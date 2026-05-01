# 环境变量

> 📄 相关源文件：`src/server/main.ts`（启动入口读取环境变量）、`src/providers/provider-store.ts`（多供应商存储与管理）、`src/providers/registry.ts`（供应商注册）

## 概述

SGA-Template 通过环境变量进行配置，支持灵活的供应商切换和运行时行为调整。支持 `.env` 文件，且 `.env` 文件中的值**优先于**系统环境变量。

## .env 文件

SGA-Template 内置了 dotenv 支持，在项目根目录（即运行 `npm run dev` 的目录）创建 `.env` 文件即可自动加载。

### 快速开始

1. 复制示例文件：

```bash
cp .env.example .env
```

2. 编辑 `.env` 文件，填写你的配置：

```bash
LLM_PROVIDER=anthropic
LLM_API_KEY=sk-ant-xxx
```

3. 启动服务：

```bash
npm run dev
```

### .env 文件优先级

> **`.env` 文件中的值会覆盖同名的系统环境变量。**

这意味着：

- 如果系统环境变量设置了 `LLM_API_KEY=sk-system`，但 `.env` 文件中设置了 `LLM_API_KEY=sk-dotenv`，最终使用 `sk-dotenv`
- 这让你可以在 `.env` 文件中统一管理配置，而不必担心系统环境变量的干扰

### .env 文件加载规则

- 文件路径：项目根目录下的 `.env` 文件（即 `process.cwd()/.env`）
- 加载时机：服务启动时自动加载（在读取任何环境变量之前）
- 覆盖模式：`override: true`（.env 文件中的值覆盖系统环境变量）
- 文件不存在时：静默忽略，不会报错

### 安全提示

- **不要**将 `.env` 文件提交到版本控制系统
- 确保 `.gitignore` 包含 `.env`
- 项目已提供 `.env.example` 作为配置模板

## 完整环境变量列表

### LLM 供应商配置（默认供应商）

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `LLM_PROVIDER` | 否 | `anthropic` | LLM 供应商名称（`anthropic` / `openai` / `deepseek` / `zhipu` / `moonshot` / `qwen`） |
| `LLM_API_KEY` | 否 | 无 | LLM API 密钥 |
| `LLM_BASE_URL` | 否 | 供应商默认 URL | LLM API 基础 URL |
| `LLM_MODEL` | 否 | 供应商默认模型 | 默认模型名称 |
| `LLM_MAX_TOKENS` | 否 | 无 | 最大生成 Token 数 |
| `LLM_TEMPERATURE` | 否 | 无 | 温度参数（0.0 - 1.0） |
| `LLM_RETRIES` | 否 | `2` | 请求重试次数 |
| `LLM_RETRY_DELAY` | 否 | `1000` | 重试延迟（毫秒） |
| `LLM_EXTRA_HEADERS` | 否 | 无 | 额外请求头（JSON 格式） |

### Anthropic 专用

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `ANTHROPIC_API_KEY` | 否 | 无 | Anthropic API 密钥 |

> 当 `LLM_PROVIDER=anthropic` 时，API 密钥的读取顺序为：`LLM_API_KEY` → `ANTHROPIC_API_KEY` → 空字符串。

### 多供应商配置

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SGA_PROVIDERS` | 否 | 无 | 额外供应商配置（JSON 数组格式） |

`SGA_PROVIDERS` 示例：

```bash
SGA_PROVIDERS=[{"name":"deepseek","apiKey":"sk-xxx","defaultModel":"deepseek-chat"},{"name":"openai","apiKey":"sk-yyy","defaultModel":"gpt-4o"}]
```

`SGA_PROVIDERS` 支持完整的供应商配置，包括模型配置和扩展：

```bash
# 带模型配置
SGA_PROVIDERS=[{"name":"openai","apiKey":"sk-yyy","defaultModel":"gpt-4o","modelConfigs":{"gpt-4o":{"id":"gpt-4o","contextWindow":128000,"maxOutputTokens":16384,"supportsVision":true,"supportsToolUse":true}}}]

# 带转换器扩展（中转供应商）
SGA_PROVIDERS=[{"name":"my-relay","apiKey":"sk-relay-xxx","baseUrl":"https://relay.example.com/v1","defaultModel":"gpt-4o","extension":{"requestTransformer":"./transformers/my-relay-request.js","responseTransformer":"./transformers/my-relay-response.js"}}]
```

> 由于环境变量中 JSON 格式较难维护，推荐使用配置文件（`sga-providers.json`）来配置复杂的供应商设置。详见 [多供应商 LLM 接入](multi-provider.md)。

### 服务配置

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `PORT` | 否 | `3000` | HTTP 服务端口 |
| `HOST` | 否 | `0.0.0.0` | HTTP 服务绑定地址 |
| `CORS_ORIGIN` | 否 | `*` | CORS 允许的来源 |
| `SGA_API_KEY` | 否 | 无 | API 认证密钥（设置后请求需携带 `Authorization: Bearer <key>`） |
| `BASE_PATH` | 否 | `/api/v1` | API 基础路径 |
| `SGA_HOME` | 否 | `~/.sga` | 框架数据主目录（记忆文件、供应商配置、MCP 配置、Skills 等） |

### Web 搜索工具

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `BRAVE_SEARCH_API_KEY` | 否 | 无 | Brave Search API 密钥 |
| `WEB_SEARCH_API_KEY` | 否 | 无 | 通用 Web 搜索 API 密钥（备用） |

## 配置示例

### 使用 Anthropic

```bash
# .env 文件
ANTHROPIC_API_KEY=sk-ant-api03-xxx
```

或：

```bash
export LLM_PROVIDER=anthropic
export LLM_API_KEY=sk-ant-api03-xxx
```

### 使用 DeepSeek

```bash
# .env 文件
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-chat
```

> 当 `LLM_PROVIDER` 设置为 `deepseek` 时，`LLM_BASE_URL` 和 `LLM_MODEL` 会自动使用默认值，无需手动指定。

### 使用通义千问

```bash
# .env 文件
LLM_PROVIDER=qwen
LLM_API_KEY=sk-xxx
```

### 配置多个供应商

```bash
# .env 文件 — 默认供应商
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-xxx

# .env 文件 — 额外供应商
SGA_PROVIDERS=[{"name":"openai","apiKey":"sk-yyy","defaultModel":"gpt-4o"},{"name":"anthropic","apiKey":"sk-ant-zzz","defaultModel":"sonnet"}]
```

或者使用配置文件 `sga-providers.json`：

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
      "defaultModel": "gpt-4o",
      "modelConfigs": {
        "gpt-4o": {
          "id": "gpt-4o",
          "displayName": "GPT-4o",
          "contextWindow": 128000,
          "maxOutputTokens": 16384,
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

### 配置中转供应商（带扩展）

```json
{
  "defaultProvider": "my-relay",
  "providers": [
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
    },
    {
      "name": "my-custom-provider",
      "apiKey": "sk-custom-xxx",
      "baseUrl": "https://custom.example.com/api",
      "defaultModel": "custom-model",
      "extension": {
        "providerModule": "./providers/my-custom-provider.js"
      }
    }
  ]
}
```

> 关于模型配置和扩展机制的详细说明，请参阅 [多供应商 LLM 接入](multi-provider.md)。

### 使用本地 Ollama

```bash
# .env 文件
LLM_PROVIDER=openai
LLM_API_KEY=ollama
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3
```

### 自定义端口

```bash
# .env 文件
PORT=8080
ANTHROPIC_API_KEY=sk-ant-xxx
```

### 自定义数据目录

```bash
# .env 文件
SGA_HOME=/data/sga  # Linux/macOS
SGA_HOME=D:\sga-data  # Windows
```

> 设置 `SGA_HOME` 后，框架会将记忆文件、供应商配置、MCP 配置、Skills 等数据存储到指定目录，而不是默认的 `~/.sga`。

## 优先级

配置的优先级从高到低：

1. **API 动态添加的供应商**（运行时通过 `POST /providers` 添加）
2. **配置文件**（`sga-providers.json` 或 `~/.sga/providers.json`）
3. **`.env` 文件中的值**（覆盖系统环境变量）
4. **系统环境变量**（`LLM_*` / `ANTHROPIC_*` 等）
5. **代码中的默认值**

> 注意：创建会话时指定的 `providerName` 不是优先级覆盖，而是选择已配置的供应商。如果指定的供应商名称不存在，会返回 400 错误。

## 相关文档

- [多供应商 LLM 接入](multi-provider.md)
- [快速开始](quick-start.md)
- [API 参考](api-reference.md)
