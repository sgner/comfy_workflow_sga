# API 参考

> 📄 相关源文件：`src/server/routes.ts`（核心路由）、`src/server/skills-mcp-routes.ts`（Skills/MCP 路由）、`src/server/session.ts`（会话管理）

## 基础信息

- **基础 URL**：`http://localhost:3000/api/v1`
- **Content-Type**：`application/json`
- **字符编码**：UTF-8

## 健康检查

### GET /health

```bash
curl http://localhost:3000/api/v1/health
```

**响应**：

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 12345.67,
  "sessions": 3,
  "defaultProvider": "deepseek",
  "configuredProviders": ["deepseek", "openai", "anthropic"],
  "availableProviderTypes": ["anthropic", "openai"]
}
```

---

## 会话管理

### GET /sessions

列出所有会话。

```bash
curl http://localhost:3000/api/v1/sessions
```

**响应**：

```json
{
  "sessions": [
    {
      "id": "sess-xxx",
      "createdAt": 1700000000000,
      "updatedAt": 1700000001000,
      "status": "active",
      "messageCount": 5,
      "model": "deepseek-chat",
      "providerName": "deepseek"
    }
  ]
}
```

### POST /sessions

创建新会话。供应商由框架自动配置，只需指定 `providerName` 即可。

```bash
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "maxTurns": 50,
    "permissionMode": "bypassPermissions",
    "providerName": "deepseek"
  }'
```

不指定 `providerName` 时使用默认供应商：

```bash
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "maxTurns": 50
  }'
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | `string` | 否 | 模型名称或别名（默认 sonnet） |
| `maxTurns` | `number` | 否 | 最大对话轮数（默认 50） |
| `maxBudgetUsd` | `number` | 否 | 最大预算（美元） |
| `permissionMode` | `string` | 否 | 权限模式（默认 default） |
| `systemPrompt` | `string` | 否 | 自定义系统提示词 |
| `agentType` | `string` | 否 | Agent 类型 |
| `mcpServers` | `object[]` | 否 | MCP 服务器配置 |
| `providerName` | `string` | 否 | 供应商名称（需预先配置，不指定则使用默认供应商） |

**响应**：

```json
{
  "session": {
    "id": "sess-xxx",
    "createdAt": 1700000000000,
    "status": "active",
    "config": {
      "model": "deepseek-chat",
      "maxTurns": 50,
      "providerName": "deepseek"
    }
  }
}
```

### GET /sessions/:id

获取会话详情。

```bash
curl http://localhost:3000/api/v1/sessions/sess-xxx
```

### DELETE /sessions/:id

删除会话。

```bash
curl -X DELETE http://localhost:3000/api/v1/sessions/sess-xxx
```

---

## 消息

### POST /sessions/:id/messages

发送消息（核心接口）。

```bash
curl -X POST http://localhost:3000/api/v1/sessions/sess-xxx/messages \
  -H "Content-Type: application/json" \
  -d '{
    "content": "你好",
    "stream": false
  }'
```

临时切换供应商：

```bash
curl -X POST http://localhost:3000/api/v1/sessions/sess-xxx/messages \
  -H "Content-Type: application/json" \
  -d '{
    "content": "你好",
    "stream": false,
    "providerName": "openai",
    "model": "gpt-4o"
  }'
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content` | `string` | 是 | 消息内容 |
| `stream` | `boolean` | 否 | 是否流式输出（默认 false） |
| `providerName` | `string` | 否 | 临时切换供应商 |
| `model` | `string` | 否 | 临时切换模型 |
| `agentType` | `string` | 否 | 临时切换 Agent 类型 |

**非流式响应**：

```json
{
  "sessionId": "sess-xxx",
  "content": "你好！我是你的 AI 助手...",
  "usage": { "inputTokens": 100, "outputTokens": 50 },
  "messages": [...]
}
```

**流式响应**（SSE）：

```
data: {"type":"text_delta","data":"你好"}

data: {"type":"tool_use_start","data":{"toolName":"Bash","toolUseId":"tool-xxx"}}

data: {"type":"done","data":{"content":"你好！...","usage":{...}}}
```

### GET /sessions/:id/messages

获取消息历史。

```bash
curl http://localhost:3000/api/v1/sessions/sess-xxx/messages
```

---

## 用户输入

### POST /sessions/:id/input

提交用户输入（人机交互）。

```bash
curl -X POST http://localhost:3000/api/v1/sessions/sess-xxx/input \
  -H "Content-Type: application/json" \
  -d '{
    "actionId": "approval-xxx",
    "decision": "allow"
  }'
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `actionId` | `string` | 是 | 等待输入的操作 ID |
| `decision` | `string` | 否 | 审批决定：`allow` / `deny` |
| `updatedInput` | `object` | 否 | 修改后的工具输入 |
| `reason` | `string` | 否 | 拒绝原因 |
| `value` | `string` | 否 | 自由文本输入值 |
| `optionValue` | `string` | 否 | 选项值 |

详见 [人机交互机制](human-interaction.md)。

---

## 用量统计

### GET /sessions/:id/usage

获取 Token 用量与成本。

```bash
curl http://localhost:3000/api/v1/sessions/sess-xxx/usage
```

**响应**：

```json
{
  "usage": {
    "inputTokens": 5000,
    "outputTokens": 2000,
    "cacheReadInputTokens": 1000,
    "cacheCreationInputTokens": 500,
    "totalTokens": 8500,
    "totalCostUsd": 0.05
  },
  "costReport": "..."
}
```

---

## Agent 与工具

### GET /agents

列出可用 Agent。

```bash
curl http://localhost:3000/api/v1/agents
```

### GET /tools

列出可用工具。

```bash
curl http://localhost:3000/api/v1/tools
```

---

## 供应商管理

### GET /providers

列出已配置的供应商和可用的供应商类型。

```bash
curl http://localhost:3000/api/v1/providers
```

**响应**：

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
    },
    {
      "name": "my-relay",
      "isDefault": false,
      "baseUrl": "https://relay.example.com/v1",
      "defaultModel": "gpt-4o",
      "hasApiKey": true,
      "models": [
        {
          "key": "gpt-4o",
          "id": "gpt-4o",
          "displayName": "GPT-4o",
          "contextWindow": 128000,
          "maxOutputTokens": 16384,
          "supportsVision": true,
          "supportsToolUse": true,
          "supportsThinking": false
        }
      ],
      "hasExtension": true,
      "extensionType": "transformer"
    }
  ],
  "availableTypes": [
    {
      "name": "anthropic",
      "defaultBaseUrl": "https://api.anthropic.com/v1",
      "defaultModel": "sonnet",
      "availableModels": { "sonnet": "claude-sonnet-4-20250514", "haiku": "claude-haiku-4-20250514" }
    },
    {
      "name": "openai",
      "defaultBaseUrl": "https://api.openai.com/v1",
      "defaultModel": "gpt-4o",
      "availableModels": { "gpt-4o": "gpt-4o", "gpt-4o-mini": "gpt-4o-mini" }
    }
  ],
  "defaultProvider": "deepseek"
}
```

**响应字段说明**：

| 字段 | 说明 |
|------|------|
| `configured[].models` | 该供应商已配置的模型列表（含 ModelConfig 信息） |
| `configured[].hasExtension` | 是否配置了扩展（转换器或自定义 Provider） |
| `configured[].extensionType` | 扩展类型：`"custom_provider"`（自定义 Provider 模块）、`"transformer"`（请求/响应转换器）、`null`（无扩展） |

### POST /providers

添加新供应商。

**简单示例**（使用内置供应商类型）：

```bash
curl -X POST http://localhost:3000/api/v1/providers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "deepseek",
    "apiKey": "sk-xxx",
    "baseUrl": "https://api.deepseek.com/v1",
    "defaultModel": "deepseek-chat",
    "setAsDefault": true
  }'
```

**带模型配置的示例**：

```bash
curl -X POST http://localhost:3000/api/v1/providers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-provider",
    "apiKey": "sk-xxx",
    "baseUrl": "https://api.example.com/v1",
    "defaultModel": "custom-model",
    "modelConfigs": {
      "custom-model": {
        "id": "custom-model",
        "displayName": "Custom Model",
        "contextWindow": 32000,
        "maxOutputTokens": 4096,
        "supportsToolUse": true,
        "supportsStreaming": true
      }
    },
    "setAsDefault": true
  }'
```

**带转换器扩展的示例**（中转供应商）：

```bash
curl -X POST http://localhost:3000/api/v1/providers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-relay",
    "apiKey": "sk-relay-xxx",
    "baseUrl": "https://relay.example.com/v1",
    "defaultModel": "gpt-4o",
    "extension": {
      "requestTransformer": "./transformers/my-relay-request.js",
      "responseTransformer": "./transformers/my-relay-response.js",
      "streamChunkTransformer": "./transformers/my-relay-stream.js"
    }
  }'
```

**带自定义 Provider 模块的示例**：

```bash
curl -X POST http://localhost:3000/api/v1/providers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-custom-provider",
    "apiKey": "sk-custom-xxx",
    "baseUrl": "https://custom.example.com/api",
    "defaultModel": "custom-model",
    "extension": {
      "providerModule": "./providers/my-custom-provider.js"
    }
  }'
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | 是 | 供应商名称（如 deepseek、openai、anthropic） |
| `apiKey` | `string` | 是 | API 密钥 |
| `baseUrl` | `string` | 否 | API 基础 URL（默认根据供应商自动设置） |
| `defaultModel` | `string` | 否 | 默认模型 |
| `models` | `object` | 否 | 模型别名映射（如 `{"sonnet": "claude-sonnet-4-20250514"}`） |
| `modelConfigs` | `object` | 否 | 模型详细配置（ModelConfig，详见 [多供应商 LLM 接入](multi-provider.md)） |
| `defaultMaxTokens` | `number` | 否 | 默认最大 Token 数 |
| `defaultTemperature` | `number` | 否 | 默认温度参数 |
| `retries` | `number` | 否 | 请求重试次数（默认 2） |
| `retryDelay` | `number` | 否 | 重试延迟毫秒数（默认 1000） |
| `headers` | `object` | 否 | 额外请求头 |
| `extra` | `object` | 否 | 供应商特定参数 |
| `extension` | `object` | 否 | 扩展配置（详见下方） |
| `setAsDefault` | `boolean` | 否 | 是否设为默认供应商 |

**extension 字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `extension.providerModule` | `string` | 自定义 Provider 模块路径（API 格式差异较大时使用） |
| `extension.requestTransformer` | `string` | 请求转换器模块路径 |
| `extension.responseTransformer` | `string` | 响应转换器模块路径 |
| `extension.streamChunkTransformer` | `string` | 流式块转换器模块路径 |

> 关于模型配置和扩展机制的详细说明，请参阅 [多供应商 LLM 接入](multi-provider.md)。

**响应**：

```json
{
  "name": "deepseek",
  "defaultModel": "deepseek-chat",
  "isDefault": true,
  "hasExtension": false
}
```

### DELETE /providers/:name

删除供应商。

```bash
curl -X DELETE http://localhost:3000/api/v1/providers/deepseek
```

### PUT /providers/:name/default

设置默认供应商。

```bash
curl -X PUT http://localhost:3000/api/v1/providers/deepseek/default
```

**响应**：

```json
{
  "success": true,
  "defaultProvider": "deepseek"
}
```

---

## 技能管理

### GET /skills

列出所有内置技能。

```bash
curl http://localhost:3000/api/v1/skills
```

### GET /skills/discover

发现用户/项目技能。

```bash
curl http://localhost:3000/api/v1/skills/discover
```

### GET /skills/:name

获取技能详情。

```bash
curl http://localhost:3000/api/v1/skills/code-review
```

### POST /skills

添加新技能。

```bash
curl -X POST http://localhost:3000/api/v1/skills \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-skill",
    "description": "我的技能",
    "prompt": "...",
    "userInvocable": true,
    "saveToDir": "user"
  }'
```

### DELETE /skills/:name

删除技能。

```bash
curl -X DELETE http://localhost:3000/api/v1/skills/my-skill
```

---

## MCP 管理

### GET /mcp/servers

列出所有 MCP 服务器。

```bash
curl http://localhost:3000/api/v1/mcp/servers
```

### GET /mcp/servers/:name

获取 MCP 服务器详情。

```bash
curl http://localhost:3000/api/v1/mcp/servers/filesystem
```

### POST /mcp/servers

添加 MCP 服务器。

```bash
curl -X POST http://localhost:3000/api/v1/mcp/servers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
    "transport": "stdio",
    "autoConnect": true,
    "saveToConfig": true
  }'
```

### DELETE /mcp/servers/:name

删除 MCP 服务器。

```bash
curl -X DELETE http://localhost:3000/api/v1/mcp/servers/filesystem
```

### POST /mcp/servers/:name/connect

连接 MCP 服务器。

```bash
curl -X POST http://localhost:3000/api/v1/mcp/servers/filesystem/connect
```

### POST /mcp/servers/:name/disconnect

断开 MCP 服务器。

```bash
curl -X POST http://localhost:3000/api/v1/mcp/servers/filesystem/disconnect
```

### GET /mcp/tools

列出所有 MCP 工具。

```bash
curl http://localhost:3000/api/v1/mcp/tools
```

---

## 相关文档

- [多供应商 LLM 接入](multi-provider.md)
- [作为后端服务使用](backend-service.md)
- [人机交互机制](human-interaction.md)
- [Skills 与 MCP 管理](skills-mcp-management.md)
- [环境变量](environment-variables.md)
