# 多供应商 LLM 接入

> 📄 相关源文件：`src/providers/types.ts`（Provider 接口与 ModelConfig 定义）、`src/providers/registry.ts`（注册中心）、`src/providers/provider-store.ts`（多供应商存储与管理）、`src/providers/anthropic.ts`（Anthropic 实现）、`src/providers/openai.ts`（OpenAI 及兼容实现）、`src/providers/transformable-provider.ts`（转换器包装器）、`src/providers/provider-loader.ts`（扩展模块加载器）

## 概述

SGA-Template 支持多种 LLM 供应商，通过统一的 Provider 接口抽象，你可以轻松切换不同的 LLM 供应商，或添加自定义供应商。框架支持**配置多个供应商**，用户可以在创建会话时选择使用哪个供应商。

核心特性：
- **多供应商配置** — 支持 .env、配置文件、API 三种方式配置多个供应商
- **模型级配置** — 每个模型独立配置上下文窗口、价格、能力等
- **配置验证** — 启动时自动验证供应商配置，不满足最小配置的供应商会被警告并跳过
- **Provider 扩展** — 支持自定义 Provider 模块动态加载
- **请求/响应转换器** — 支持中转供应商的 API 格式差异

## 最小配置要求

> 📄 相关源文件：`src/providers/provider-store.ts`（`validateProviderConfig` 函数）

框架在加载供应商配置时会进行验证。**不满足最小配置的供应商将被丢弃**，不会注册到框架中。

### 必填字段

| 字段 | 说明 | 备注 |
|------|------|------|
| `name` | 供应商名称 | 非空字符串 |
| `apiKey` | API 密钥 | 非空字符串 |
| `baseUrl` | API 基础 URL | 内置供应商（anthropic、openai、deepseek 等）可省略，框架自动填充默认值 |
| `defaultModel` | 默认模型 | 内置供应商可省略，框架自动填充默认值 |

### modelConfigs 中模型的最小配置

| 字段 | 说明 | 备注 |
|------|------|------|
| `id` | 实际发送给 API 的模型 ID | 必填 |

其他字段（`displayName`、`contextWindow`、`supportsToolUse` 等）均为可选。

### 验证行为

| 场景 | 行为 |
|------|------|
| 缺少 `name` | ❌ 验证失败，供应商被丢弃 |
| 缺少 `apiKey` | ❌ 验证失败，供应商被丢弃 |
| 缺少 `baseUrl`（非内置供应商） | ❌ 验证失败，供应商被丢弃 |
| 缺少 `defaultModel` | ❌ 验证失败，供应商被丢弃 |
| 缺少 `modelConfigs` | ⚠️ 警告，供应商仍可使用（但无模型能力信息） |
| `modelConfigs` 中模型缺少 `id` | ❌ 验证失败，供应商被丢弃 |
| 同时配置 `providerModule` 和转换器 | ⚠️ 警告，`providerModule` 优先，转换器被忽略 |

### 验证失败时的日志输出

当供应商配置不满足最小要求时，框架会在控制台输出错误日志：

```
[2026-04-28T12:00:00.000Z] [ERROR] [provider-store] Provider "my-provider" validation failed: apiKey is required and must be a non-empty string
[2026-04-28T12:00:00.000Z] [ERROR] [provider-store] Provider "my-provider" validation failed: baseUrl is required when the provider is not a built-in type (anthropic, openai, deepseek, zhipu, moonshot, qwen)
[2026-04-28T12:00:00.000Z] [ERROR] [provider-store] Failed to load provider "my-provider" from config file: Provider "my-provider" does not meet minimum configuration requirements: apiKey is required and must be a non-empty string; baseUrl is required when the provider is not a built-in type. This provider will be discarded.
```

### 通过 API 添加时的错误响应

```bash
curl -X POST http://localhost:3000/api/v1/providers \
  -H "Content-Type: application/json" \
  -d '{"name": "my-provider"}'
```

响应（HTTP 400）：

```json
{
  "error": "Provider \"my-provider\" does not meet minimum configuration requirements",
  "errors": [
    "apiKey is required and must be a non-empty string",
    "baseUrl is required when the provider is not a built-in type (anthropic, openai, deepseek, zhipu, moonshot, qwen)",
    "defaultModel is required (either explicitly set or available as a built-in default)"
  ],
  "warnings": []
}
```

### 配置示例

**内置供应商的最小配置**（自动填充 baseUrl 和 defaultModel）：

```json
{
  "name": "deepseek",
  "apiKey": "sk-xxx"
}
```

**自定义供应商的最小配置**（必须提供 baseUrl 和 defaultModel）：

```json
{
  "name": "my-provider",
  "apiKey": "sk-xxx",
  "baseUrl": "https://api.example.com/v1",
  "defaultModel": "gpt-5.5"
}
```

**带模型配置的推荐配置**：

```json
{
  "name": "my-provider",
  "apiKey": "sk-xxx",
  "baseUrl": "https://api.example.com/v1",
  "defaultModel": "gpt-5.5",
  "modelConfigs": {
    "gpt-5.5": {
      "id": "gpt-5.5",
      "displayName": "GPT-5.5",
      "contextWindow": 128000,
      "supportsToolUse": true,
      "supportsStreaming": true
    }
  }
}
```

## 多供应商配置

框架支持三种方式配置多个供应商，可以组合使用：

### 方式一：环境变量（.env 文件）

配置默认供应商：

```bash
# .env 文件
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-chat
```

配置额外供应商（JSON 数组格式）：

```bash
# .env 文件
SGA_PROVIDERS=[{"name":"openai","apiKey":"sk-yyy","defaultModel":"gpt-4o"},{"name":"anthropic","apiKey":"sk-ant-zzz","defaultModel":"sonnet"}]
```

### 方式二：配置文件（推荐）

在项目根目录创建 `sga-providers.json`：

```json
{
  "defaultProvider": "deepseek",
  "providers": [
    {
      "name": "deepseek",
      "apiKey": "sk-xxx",
      "defaultModel": "deepseek-chat"
    },
    {
      "name": "openai",
      "apiKey": "sk-yyy",
      "baseUrl": "https://api.openai.com/v1",
      "defaultModel": "gpt-4o",
      "modelConfigs": {
        "gpt-4o": {
          "id": "gpt-4o",
          "displayName": "GPT-4o",
          "contextWindow": 128000,
          "maxOutputTokens": 16384,
          "inputPricePerMToken": 2.5,
          "outputPricePerMToken": 10,
          "supportsVision": true,
          "supportsToolUse": true,
          "supportsStreaming": true
        },
        "gpt-4o-mini": {
          "id": "gpt-4o-mini",
          "displayName": "GPT-4o Mini",
          "contextWindow": 128000,
          "maxOutputTokens": 16384,
          "inputPricePerMToken": 0.15,
          "outputPricePerMToken": 0.6,
          "supportsVision": true,
          "supportsToolUse": true
        }
      }
    },
    {
      "name": "anthropic",
      "apiKey": "sk-ant-zzz",
      "defaultModel": "sonnet"
    }
  ]
}
```

也可以在用户主目录下创建 `~/.sga/providers.json`（格式相同）。

### 方式三：API 动态添加

```bash
# 添加供应商
curl -X POST http://localhost:3000/api/v1/providers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "deepseek",
    "apiKey": "sk-xxx",
    "defaultModel": "deepseek-chat",
    "setAsDefault": true
  }'

# 列出已配置的供应商（包含模型配置信息）
curl http://localhost:3000/api/v1/providers

# 设置默认供应商
curl -X PUT http://localhost:3000/api/v1/providers/deepseek/default

# 删除供应商
curl -X DELETE http://localhost:3000/api/v1/providers/deepseek
```

### 配置加载顺序

启动时，框架按以下顺序加载供应商配置：

1. `.env` 文件中的 `LLM_*` 环境变量（默认供应商）
2. `.env` 文件中的 `SGA_PROVIDERS`（额外供应商）
3. `~/.sga/providers.json`（全局配置）
4. `./sga-providers.json`（项目配置）
5. API 动态添加的供应商

后加载的配置会覆盖同名供应商。

## 模型配置（ModelConfig）

> 📄 相关源文件：`src/providers/types.ts`（ModelConfig 接口定义）

每个模型可以独立配置其特性，框架为内置供应商提供了默认的模型配置，你也可以在配置中覆盖或添加自定义模型配置。

### ModelConfig 接口

```typescript
// src/providers/types.ts
export interface ModelConfig {
  id: string                       // 实际发送给 API 的模型 ID
  displayName?: string             // 显示名称
  contextWindow?: number           // 上下文窗口大小（Token 数）
  maxOutputTokens?: number         // 最大输出 Token 数
  inputPricePerMToken?: number     // 输入价格（美元/百万 Token）
  outputPricePerMToken?: number    // 输出价格（美元/百万 Token）
  supportsVision?: boolean         // 是否支持图像输入
  supportsToolUse?: boolean        // 是否支持函数调用
  supportsStreaming?: boolean      // 是否支持流式输出
  supportsThinking?: boolean       // 是否支持扩展思考
  defaultMaxTokens?: number        // 默认最大输出 Token 数
  defaultTemperature?: number      // 默认温度
  maxTemperature?: number          // 最大温度
  thinkingBudget?: number          // 默认思考预算
  baseUrl?: string                 // 模型专属请求地址（覆盖供应商级 baseUrl）
  streamingBaseUrl?: string        // 流式请求专属地址（优先于 baseUrl）
  apiKey?: string                  // 模型专属 API Key（覆盖供应商级 apiKey）
  headers?: Record<string, string> // 模型专属请求头（合并到供应商级 headers）
  extra?: Record<string, unknown>  // 模型特定参数
}
```

### 模型级请求配置

> 📄 相关源文件：`src/providers/types.ts`（ModelConfig 定义）、`src/providers/openai.ts`（`resolveRequestConfig` 方法）、`src/providers/anthropic.ts`（`resolveRequestConfig` 方法）、`src/providers/transformable-provider.ts`（`resolveRequestConfig` 方法）

框架支持在模型级别配置独立的请求地址、API Key 和请求头。这对于中转商场景非常有用，例如：

- **不同模型使用不同的请求地址** — 某些中转商为不同模型提供不同的 API 端点
- **流式和非流式使用不同地址** — 某些中转商的流式请求和非流式请求走不同的 URL
- **不同模型使用不同的 API Key** — 按模型分配密钥，便于权限控制和计费

#### 优先级规则

请求时，框架按以下优先级解析配置：

| 配置项 | 优先级（高→低） |
|--------|----------------|
| **非流式 baseUrl** | `modelConfig.baseUrl` → `provider.baseUrl` |
| **流式 baseUrl** | `modelConfig.streamingBaseUrl` → `modelConfig.baseUrl` → `provider.baseUrl` |
| **API Key** | `modelConfig.apiKey` → `provider.apiKey` |
| **Headers** | `provider.headers` + `modelConfig.headers`（合并，模型级覆盖供应商级同名 key） |

#### baseUrl 配置说明

`baseUrl` 支持两种配置方式：

1. **标准方式（推荐）** — 只配置到 `/v1`，框架自动拼接 `/chat/completions`：
   ```json
   "baseUrl": "https://api.example.com/v1"
   ```
   最终请求地址：`https://api.example.com/v1/chat/completions`

2. **完整 URL 方式** — 配置完整端点地址，框架会自动提取基础路径：
   ```json
   "baseUrl": "https://api.example.com/v1/chat/completions"
   ```
   最终请求地址：`https://api.example.com/v1/chat/completions`

> 框架内部会自动识别并处理以 `/chat/completions` 或 `/messages` 结尾的完整 URL，无需担心重复拼接。推荐使用标准方式（只配置到 `/v1`），代码更清晰。

#### 配置示例

**场景一：不同模型使用不同请求地址和 API Key**

```json
{
  "name": "t8star",
  "apiKey": "sk-default-key",
  "baseUrl": "https://api.t8star.com/v1",
  "defaultModel": "gpt-5.5",
  "modelConfigs": {
    "gpt-5.5": {
      "id": "t8star_gpt5.5",
      "baseUrl": "https://api.t8star.com/v1",
      "apiKey": "sk-gpt55-key"
    },
    "claude-sonnet": {
      "id": "t8star_sonnet",
      "baseUrl": "https://claude.t8star.com/v1",
      "apiKey": "sk-claude-key"
    }
  }
}
```

**场景二：流式和非流式使用不同地址**

```json
{
  "name": "t8star",
  "apiKey": "sk-xxx",
  "baseUrl": "https://api.t8star.com/v1",
  "defaultModel": "gpt-5.5",
  "modelConfigs": {
    "gpt-5.5": {
      "id": "t8star_gpt5.5",
      "baseUrl": "https://api.t8star.com/v1",
      "streamingBaseUrl": "https://stream.t8star.com/v1"
    }
  }
}
```

**场景三：模型级自定义请求头**

```json
{
  "name": "t8star",
  "apiKey": "sk-xxx",
  "baseUrl": "https://api.t8star.com/v1",
  "defaultModel": "gpt-5.5",
  "headers": {
    "X-Custom-Header": "provider-value"
  },
  "modelConfigs": {
    "gpt-5.5": {
      "id": "t8star_gpt5.5",
      "headers": {
        "X-Model-Header": "model-value",
        "X-Custom-Header": "model-override"
      }
    }
  }
}
```

最终 `gpt-5.5` 模型的请求头为：
```
X-Custom-Header: model-override    (模型级覆盖了供应商级)
X-Model-Header: model-value        (模型级新增)
```

### 内置模型配置

框架为以下供应商提供了内置模型配置（包含上下文窗口、价格、能力等信息）：

| 供应商 | 模型 | 上下文窗口 | 输入价格 | 输出价格 | 视觉 | 工具 | 思考 |
|--------|------|-----------|---------|---------|------|------|------|
| Anthropic | sonnet | 200K | $3/M | $15/M | ✅ | ✅ | ✅ |
| Anthropic | haiku | 200K | $0.8/M | $4/M | ✅ | ✅ | ❌ |
| Anthropic | opus | 200K | $15/M | $75/M | ✅ | ✅ | ✅ |
| OpenAI | gpt-4o | 128K | $2.5/M | $10/M | ✅ | ✅ | ❌ |
| OpenAI | gpt-4o-mini | 128K | $0.15/M | $0.6/M | ✅ | ✅ | ❌ |
| OpenAI | o1 | 200K | $15/M | $60/M | ✅ | ✅ | ✅ |
| DeepSeek | deepseek-chat | 64K | $0.14/M | $0.28/M | ❌ | ✅ | ❌ |
| DeepSeek | deepseek-reasoner | 64K | $0.55/M | $2.19/M | ❌ | ✅ | ✅ |
| 智谱 | glm-4 | 128K | ¥14/M | ¥14/M | ❌ | ✅ | ❌ |
| 智谱 | glm-4-flash | 128K | ¥0.1/M | ¥0.1/M | ❌ | ✅ | ❌ |
| 月之暗面 | moonshot-v1-8k | 8K | ¥12/M | ¥12/M | ❌ | ✅ | ❌ |
| 通义千问 | qwen-plus | 131K | ¥0.8/M | ¥2/M | ❌ | ✅ | ❌ |

> 价格仅供参考，以供应商官方价格为准。

### 自定义模型配置

你可以在 `sga-providers.json` 中为任意供应商添加自定义模型配置：

```json
{
  "name": "my-provider",
  "apiKey": "sk-xxx",
  "baseUrl": "https://api.example.com/v1",
  "defaultModel": "custom-model-v2",
  "modelConfigs": {
    "custom-model-v1": {
      "id": "custom-model-v1",
      "displayName": "Custom Model V1",
      "contextWindow": 32000,
      "maxOutputTokens": 4096,
      "supportsToolUse": true,
      "supportsStreaming": true
    },
    "custom-model-v2": {
      "id": "custom-model-v2",
      "displayName": "Custom Model V2",
      "contextWindow": 128000,
      "maxOutputTokens": 8192,
      "supportsVision": true,
      "supportsToolUse": true,
      "supportsThinking": true
    }
  }
}
```

### 通过 API 获取模型信息

```bash
# 列出已配置的供应商及其模型信息
curl http://localhost:3000/api/v1/providers
```

响应中包含每个供应商的模型列表：

```json
{
  "configured": [
    {
      "name": "deepseek",
      "isDefault": true,
      "baseUrl": "https://api.deepseek.com/v1",
      "defaultModel": "deepseek-chat",
      "hasApiKey": true,
      "models": [
        {
          "key": "deepseek-chat",
          "id": "deepseek-chat",
          "displayName": "DeepSeek Chat",
          "contextWindow": 64000,
          "maxOutputTokens": 8192,
          "supportsVision": false,
          "supportsToolUse": true,
          "supportsThinking": false
        },
        {
          "key": "deepseek-reasoner",
          "id": "deepseek-reasoner",
          "displayName": "DeepSeek Reasoner",
          "contextWindow": 64000,
          "maxOutputTokens": 8192,
          "supportsVision": false,
          "supportsToolUse": true,
          "supportsThinking": true
        }
      ],
      "hasExtension": false,
      "extensionType": null
    }
  ],
  "availableTypes": [...],
  "defaultProvider": "deepseek"
}
```

## 会话中使用供应商

创建会话时，只需指定 `providerName`（供应商名称），框架会自动查找已配置的供应商实例：

```bash
# 使用 deepseek 供应商
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "maxTurns": 50,
    "providerName": "deepseek"
  }'

# 不指定 providerName 时使用默认供应商
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "maxTurns": 50
  }'
```

发送消息时也可以临时切换供应商：

```bash
curl -X POST http://localhost:3000/api/v1/sessions/sess-xxx/messages \
  -H "Content-Type: application/json" \
  -d '{
    "content": "你好",
    "providerName": "openai",
    "model": "gpt-4o"
  }'
```

## Provider 接口

```typescript
// src/providers/types.ts
export interface LLMProvider {
  readonly name: string
  readonly config: ProviderConfig
  createMessage(options: ProviderRequestOptions): Promise<ProviderResponse>
  createStreamingMessage(options: ProviderRequestOptions): AsyncGenerator<ProviderStreamChunk>
  resolveModel(model: string): string
  getModelConfig(model: string): ModelConfig | undefined
  validateConfig(): boolean
}
```

| 方法 | 说明 |
|------|------|
| `name` | 供应商唯一标识 |
| `config` | 供应商配置 |
| `createMessage()` | 非流式消息发送 |
| `createStreamingMessage()` | 流式消息发送（AsyncGenerator） |
| `resolveModel()` | 解析模型别名，返回实际模型 ID |
| `getModelConfig()` | 获取模型配置（上下文窗口、价格、能力等） |
| `validateConfig()` | 验证配置 |

## ProviderConfig

```typescript
// src/providers/types.ts
export interface ProviderConfig {
  name: string
  apiKey: string
  baseUrl: string
  models?: Record<string, string>           // 简单别名映射（向后兼容）
  modelConfigs?: Record<string, ModelConfig> // 详细模型配置
  defaultModel?: string
  defaultMaxTokens?: number
  defaultTemperature?: number
  retries?: number
  retryDelay?: number
  headers?: Record<string, string>
  extra?: Record<string, unknown>
  extension?: ProviderExtension              // 扩展配置
}
```

## 中转供应商与扩展机制

> 📄 相关源文件：`src/providers/transformable-provider.ts`（转换器包装器）、`src/providers/provider-loader.ts`（扩展模块加载器）

对于 API 格式与官方不同的中转供应商，框架提供了两种扩展方式：

### 方式一：请求/响应转换器（适用于少量差异）

当中转供应商的 API 与 OpenAI 格式有少量差异时，可以使用转换器来修改请求和响应：

```json
{
  "name": "my-relay",
  "apiKey": "sk-relay-xxx",
  "baseUrl": "https://relay.example.com/v1",
  "defaultModel": "gpt-4o",
  "extension": {
    "requestTransformer": "./transformers/my-relay-request.js",
    "responseTransformer": "./transformers/my-relay-response.js",
    "streamChunkTransformer": "./transformers/my-relay-stream.js"
  }
}
```

**请求转换器** (`./transformers/my-relay-request.js`)：

```javascript
// 修改发送给 API 的请求体和请求头
export default function transformRequest(body, headers) {
  // 添加自定义字段
  body.custom_field = "value"
  // 修改认证头
  headers["X-Custom-Auth"] = "my-token"
  // 删除不需要的字段
  delete body.max_tokens
  return { body, headers }
}
```

**响应转换器** (`./transformers/my-relay-response.js`)：

```javascript
// 修改 API 返回的响应数据
export default function transformResponse(response) {
  // 重命名字段
  if (response.result) {
    response.choices = response.result
    delete response.result
  }
  return response
}
```

**流式块转换器** (`./transformers/my-relay-stream.js`)：

```javascript
// 修改流式响应的每个数据块
export default function transformStreamChunk(chunk) {
  // 适配不同的流式格式
  if (chunk.data) {
    chunk.choices = chunk.data.choices
  }
  return chunk
}
```

### 方式二：自定义 Provider 模块（适用于较大差异）

当中转供应商的 API 格式与 OpenAI/Anthropic 差异较大时，可以编写完整的自定义 Provider：

```json
{
  "name": "my-custom-provider",
  "apiKey": "sk-custom-xxx",
  "baseUrl": "https://custom.example.com/api",
  "defaultModel": "custom-model",
  "extension": {
    "providerModule": "./providers/my-custom-provider.js"
  }
}
```

**自定义 Provider 模块** (`./providers/my-custom-provider.js`)：

```javascript
export default class MyCustomProvider {
  constructor(config) {
    this.name = config.name
    this.config = config
  }

  resolveModel(model) {
    return model
  }

  getModelConfig(model) {
    return undefined
  }

  validateConfig() {
    return !!this.config.apiKey
  }

  async createMessage(options) {
    // 完全自定义的 API 调用逻辑
    const response = await fetch(`${this.config.baseUrl}/custom-endpoint`, {
      method: 'POST',
      headers: {
        'Authorization': `Custom ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: options.messages.map(m =>
          typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
        ).join('\n'),
        model: this.resolveModel(options.model),
      }),
    })

    if (!response.ok) {
      throw new Error(`API Error ${response.status}`)
    }

    const data = await response.json()

    // 转换为框架统一的响应格式
    return {
      id: data.id || '',
      model: data.model || '',
      content: [{ type: 'text', text: data.answer || data.content || '' }],
      stopReason: 'end_turn',
      usage: {
        inputTokens: data.usage?.input || 0,
        outputTokens: data.usage?.output || 0,
      },
    }
  }

  async *createStreamingMessage(options) {
    // 完全自定义的流式调用逻辑
    const response = await fetch(`${this.config.baseUrl}/custom-stream`, {
      method: 'POST',
      headers: {
        'Authorization': `Custom ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: options.messages.map(m =>
          typeof m.content === 'string' ? m.content : ''
        ).join('\n'),
        model: this.resolveModel(options.model),
        stream: true,
      }),
    })

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const text = decoder.decode(value, { stream: true })
      yield {
        type: 'stream_chunk',
        delta: { type: 'text_delta', text },
      }
    }
  }
}
```

### 扩展类型对比

| 特性 | 转换器 | 自定义 Provider |
|------|--------|----------------|
| 适用场景 | API 格式有少量差异 | API 格式差异较大 |
| 实现难度 | 低 | 中 |
| 灵活性 | 中（只能修改请求/响应） | 高（完全自定义） |
| 支持流式 | ✅（通过 streamChunkTransformer） | ✅ |
| 支持工具调用 | ✅（基于 OpenAI 格式） | ✅（需自行实现） |
| 需要编写代码 | 是（转换函数） | 是（完整 Provider 类） |

## 内置供应商

### Anthropic

```typescript
import { addProvider } from 'SGA-Template'

await addProvider({
  name: 'anthropic',
  apiKey: 'sk-ant-xxx',
  defaultModel: 'sonnet',
})
```

模型别名：

| 别名 | 实际模型 | 上下文窗口 | 输出价格 |
|------|----------|-----------|---------|
| `sonnet` | `claude-sonnet-4-20250514` | 200K | $15/M |
| `haiku` | `claude-haiku-4-20250514` | 200K | $4/M |
| `opus` | `claude-opus-4-20250514` | 200K | $75/M |

### OpenAI 兼容

支持所有 OpenAI API 兼容的供应商：

```typescript
import { addProvider } from 'SGA-Template'

// DeepSeek
await addProvider({
  name: 'deepseek',
  apiKey: 'sk-xxx',
  baseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-chat',
})

// 通义千问
await addProvider({
  name: 'qwen',
  apiKey: 'sk-xxx',
  defaultModel: 'qwen-plus',
})

// 本地 Ollama
await addProvider({
  name: 'ollama',
  apiKey: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  defaultModel: 'llama3',
})
```

## Provider Store API

> 📄 相关源文件：`src/providers/provider-store.ts`

| 方法 | 说明 |
|------|------|
| `addProvider(config, setAsDefault?)` | 添加供应商（异步，支持扩展加载） |
| `removeProvider(name)` | 移除供应商 |
| `getProvider(name)` | 获取供应商实例 |
| `getProviderConfig(name)` | 获取供应商配置 |
| `getDefaultProvider()` | 获取默认供应商 |
| `setDefaultProvider(name)` | 设置默认供应商 |
| `getAllProviders()` | 获取所有供应商信息 |
| `getAllProviderNames()` | 获取所有供应商名称 |
| `resolveProvider(name?)` | 解析供应商（按名称或默认） |
| `loadProvidersFromEnv()` | 从环境变量加载（异步） |
| `loadProvidersFromConfig(configs, defaultName?)` | 从配置数组加载（异步） |

## 自定义供应商（代码方式）

实现 `LLMProvider` 接口来添加自定义供应商：

```typescript
import type { LLMProvider, ProviderConfig, ProviderRequestOptions, ProviderResponse, ProviderStreamChunk, ModelConfig } from 'SGA-Template'

export class MyCustomProvider implements LLMProvider {
  readonly name = 'my-provider'
  readonly config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
  }

  async createMessage(options: ProviderRequestOptions): Promise<ProviderResponse> {
    // 实现非流式调用
  }

  async *createStreamingMessage(options: ProviderRequestOptions): AsyncGenerator<ProviderStreamChunk> {
    // 实现流式调用
  }

  resolveModel(model: string): string { return model }
  getModelConfig(model: string): ModelConfig | undefined { return undefined }
  validateConfig(): boolean { return !!this.config.apiKey }
}
```

然后注册到框架：

```typescript
import { registerProvider, addProvider } from 'SGA-Template'

registerProvider('my-provider', MyCustomProvider, {
  baseUrl: 'https://my-api.example.com/v1',
  defaultModel: 'my-model-v1',
})

await addProvider({
  name: 'my-provider',
  apiKey: 'sk-xxx',
  defaultModel: 'my-model-v1',
})
```

## 工具调用支持

框架完整支持 OpenAI 格式的工具调用（Function Calling），包括：

1. **工具调用请求**：Assistant 消息中的 `tool_calls` 字段
2. **工具结果返回**：`tool` 角色的消息，通过 `tool_call_id` 关联

### 消息格式转换

框架内部使用统一的消息格式，在发送到不同供应商时会自动转换为对应格式：

**内部格式 → OpenAI 格式**：
```typescript
// Assistant 消息包含 tool_use
{
  role: 'assistant',
  content: [{ type: 'text', text: 'Let me check that' }],
  tool_calls: [{
    id: 'call_abc123',
    type: 'function',
    function: {
      name: 'get_weather',
      arguments: '{"location": "Beijing"}'
    }
  }]
}

// User 消息包含 tool_result
{
  role: 'tool',
  tool_call_id: 'call_abc123',
  content: '{"temperature": 25, "condition": "sunny"}'
}
```

### TransformableProvider 工具调用

`TransformableProvider`（用于中转供应商）完全支持工具调用：
- 正确转换历史消息中的 `tool_use` 和 `tool_result`
- 保持 `tool_call_id` 的一致性
- 支持多轮工具调用对话

### 故障排查

如果遇到 "No tool call found for function call output" 错误，请检查：
1. 历史消息中是否包含对应的 `tool_calls` assistant 消息
2. `tool_call_id` 是否匹配
3. 消息顺序是否正确（tool 消息必须紧跟在对应的 assistant 消息之后）

## 相关文档

- [环境变量](environment-variables.md)
- [作为后端服务使用](backend-service.md)
- [API 参考](api-reference.md)
