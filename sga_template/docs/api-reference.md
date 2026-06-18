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
| `actionId` | `string` | 是 | 等待输入的操作 ID（来自 SSE 事件的 `actionId` 字段） |
| `decision` | `string` | 否 | 审批决定：`allow` / `deny` |
| `updatedInput` | `object` | 否 | 修改后的工具输入 |
| `reason` | `string` | 否 | 拒绝原因 |
| `value` | `string` | 否 | 自由文本输入值 |
| `optionValue` | `string` | 否 | 选项值 |
| `permissionUpdate` | `object` | 否 | 持久化审批规则（详见下方） |

**permissionUpdate 字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | `string` | 是 | `always_allow` / `always_deny` / `allow_pattern` |
| `toolName` | `string` | 是 | 工具名称 |
| `pattern` | `string` | 否 | 匹配模式（`allow_pattern` 时使用） |

**审批并设置"总是允许"**：

```bash
curl -X POST http://localhost:3000/api/v1/sessions/sess-xxx/input \
  -H "Content-Type: application/json" \
  -d '{
    "actionId": "approval-xxx",
    "decision": "allow",
    "permissionUpdate": {
      "type": "always_allow",
      "toolName": "Write"
    }
  }'
```

**审批并设置模式匹配允许**：

```bash
curl -X POST http://localhost:3000/api/v1/sessions/sess-xxx/input \
  -H "Content-Type: application/json" \
  -d '{
    "actionId": "approval-xxx",
    "decision": "allow",
    "permissionUpdate": {
      "type": "allow_pattern",
      "toolName": "Write",
      "pattern": "*.md"
    }
  }'
```

**错误响应**：

```json
{
  "error": "Invalid or expired action ID"
}
```

详见 [人机交互机制](human-interaction.md) 和 [权限控制](permissions.md)。

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

**成功响应**（201）：

```json
{
  "name": "deepseek",
  "defaultModel": "deepseek-chat",
  "isDefault": true,
  "hasExtension": false
}
```

**验证失败响应**（400）：

当供应商配置不满足最小配置要求时，返回详细的验证错误：

```json
{
  "error": "Provider \"my-provider\" does not meet minimum configuration requirements",
  "errors": [
    "apiKey is required and must be a non-empty string",
    "baseUrl is required when the provider is not a built-in type (anthropic, openai, deepseek, zhipu, moonshot, qwen)"
  ],
  "warnings": []
}
```

> 关于最小配置要求的详细说明，请参阅 [多供应商 LLM 接入 - 最小配置要求](multi-provider.md#最小配置要求)。

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

## 权限管理

### GET /permissions/rules

获取当前权限规则。

```bash
curl http://localhost:3000/api/v1/permissions/rules
```

**响应**：

```json
{
  "version": 1,
  "rules": {
    "allow": [
      { "tool": "Read", "behavior": "allow" }
    ],
    "deny": [
      { "tool": "Bash", "pattern": "rm -rf", "behavior": "deny", "reason": "危险删除命令" }
    ],
    "ask": [
      { "tool": "Write", "behavior": "ask" }
    ]
  }
}
```

### POST /permissions/rules

添加权限规则。

```bash
curl -X POST http://localhost:3000/api/v1/permissions/rules \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "Write",
    "behavior": "allow",
    "pattern": "*.md"
  }'
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tool` | `string` | 是 | 工具名称 |
| `behavior` | `string` | 是 | `allow` / `deny` / `ask` |
| `pattern` | `string` | 否 | 匹配模式 |
| `reason` | `string` | 否 | 原因说明 |

### DELETE /permissions/rules

删除权限规则。

```bash
curl -X DELETE http://localhost:3000/api/v1/permissions/rules \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "Write",
    "behavior": "allow",
    "pattern": "*.md"
  }'
```

### POST /permissions/classify

测试权限分类器。

```bash
curl -X POST http://localhost:3000/api/v1/permissions/classify \
  -H "Content-Type: application/json" \
  -d '{
    "toolName": "Bash",
    "toolInput": { "command": "ls -la" }
  }'
```

**响应**：

```json
{
  "decision": "allow",
  "confidence": 0.8,
  "reason": "Safe read-only bash command",
  "ruleId": "safe_bash_read"
}
```

### POST /permissions/check

综合权限检查（规则 + 分类器）。

```bash
curl -X POST http://localhost:3000/api/v1/permissions/check \
  -H "Content-Type: application/json" \
  -d '{
    "toolName": "Bash",
    "toolInput": { "command": "rm -rf node_modules" }
  }'
```

**响应**：

```json
{
  "behavior": "deny",
  "reason": "危险删除命令",
  "matchedRule": {
    "tool": "Bash",
    "pattern": "rm -rf",
    "behavior": "deny",
    "reason": "危险删除命令"
  }
}
```

### POST /permissions/sensitive-path

检测敏感路径。

```bash
curl -X POST http://localhost:3000/api/v1/permissions/sensitive-path \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/home/user/.ssh/id_rsa"
  }'
```

**响应**：

```json
{
  "isSensitive": true,
  "reason": "SSH private key",
  "category": "secrets",
  "riskLevel": "critical"
}
```

详见 [权限控制](permissions.md)。

---

## Hook 管理

### GET /hooks

获取当前 Hook 配置。

```bash
curl http://localhost:3000/api/v1/hooks
```

**响应**：

```json
{
  "version": 1,
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": "Bash",
      "command": "python validate.py",
      "timeout": 10000
    }
  ]
}
```

### POST /hooks

添加 Hook。

```bash
curl -X POST http://localhost:3000/api/v1/hooks \
  -H "Content-Type: application/json" \
  -d '{
    "event": "PreToolUse",
    "matcher": "Bash",
    "command": "python validate.py",
    "timeout": 10000
  }'
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `string` | 是 | Hook 事件类型 |
| `matcher` | `string` | 否 | 工具名匹配模式 |
| `command` | `string` | 是 | 要执行的 shell 命令 |
| `once` | `boolean` | 否 | 是否只执行一次 |
| `timeout` | `number` | 否 | 超时时间（毫秒） |

### DELETE /hooks

删除 Hook。

```bash
curl -X DELETE http://localhost:3000/api/v1/hooks \
  -H "Content-Type: application/json" \
  -d '{
    "event": "PreToolUse",
    "command": "python validate.py"
  }'
```

### POST /hooks/execute

手动触发 Hook 执行（测试用）。

```bash
curl -X POST http://localhost:3000/api/v1/hooks/execute \
  -H "Content-Type: application/json" \
  -d '{
    "event": "PreToolUse",
    "context": {
      "toolName": "Bash",
      "toolInput": { "command": "npm test" },
      "cwd": "/project"
    }
  }'
```

**响应**：

```json
{
  "results": [
    {
      "exitCode": 0,
      "stdout": "Validation passed",
      "stderr": "",
      "proceed": true
    }
  ]
}
```

详见 [Hook 钩子系统](hooks.md)。

---

## Feature Gate 管理

### GET /feature-gates

列出所有特性开关。

```bash
curl http://localhost:3000/api/v1/feature-gates
```

**响应**：

```json
{
  "gates": [
    {
      "name": "tool_retry",
      "description": "Enable tool execution retry with exponential backoff",
      "defaultEnabled": true,
      "currentEnabled": true,
      "source": "default",
      "envVar": "SGA_FEATURE_TOOL_RETRY"
    }
  ]
}
```

### GET /feature-gates/:name

获取指定特性开关详情。

```bash
curl http://localhost:3000/api/v1/feature-gates/tool_retry
```

### POST /feature-gates/override

运行时覆盖特性开关。

```bash
curl -X POST http://localhost:3000/api/v1/feature-gates/override \
  -H "Content-Type: application/json" \
  -d '{
    "name": "telemetry",
    "enabled": true
  }'
```

### POST /feature-gates/reset

重置指定特性开关为默认值。

```bash
curl -X POST http://localhost:3000/api/v1/feature-gates/reset \
  -H "Content-Type: application/json" \
  -d '{
    "name": "telemetry"
  }'
```

### POST /feature-gates/reset-all

重置所有特性开关为默认值。

```bash
curl -X POST http://localhost:3000/api/v1/feature-gates/reset-all
```

### POST /feature-gates

注册自定义特性开关。

```bash
curl -X POST http://localhost:3000/api/v1/feature-gates \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my_feature",
    "description": "My custom feature",
    "defaultEnabled": false,
    "envVar": "SGA_FEATURE_MY_FEATURE"
  }'
```

详见 [Feature Gate 特性开关](feature-gate.md)。

---

## 遥测管理

### GET /telemetry/status

获取遥测状态。

```bash
curl http://localhost:3000/api/v1/telemetry/status
```

### POST /telemetry/toggle

启用或禁用遥测。

```bash
curl -X POST http://localhost:3000/api/v1/telemetry/toggle \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true
  }'
```

### POST /telemetry/flush

手动刷新遥测数据。

```bash
curl -X POST http://localhost:3000/api/v1/telemetry/flush
```

### GET /telemetry/events

获取最近的遥测事件。

```bash
curl http://localhost:3000/api/v1/telemetry/events
```

详见 [遥测框架](telemetry.md)。

---

## 分类器

### POST /classify/bash

分类 Bash 命令。

```bash
curl -X POST http://localhost:3000/api/v1/classify/bash \
  -H "Content-Type: application/json" \
  -d '{
    "command": "npm test"
  }'
```

**响应**：

```json
{
  "classification": {
    "category": "test",
    "riskLevel": "low",
    "isDestructive": false,
    "isReadOnly": true
  }
}
```

### POST /classify/error

分类错误信息。

```bash
curl -X POST http://localhost:3000/api/v1/classify/error \
  -H "Content-Type: application/json" \
  -d '{
    "error": "EACCES: permission denied"
  }'
```

**响应**：

```json
{
  "category": "permission"
}
```

---

## 系统提示词预览

### POST /system-prompt/preview

预览组装后的系统提示词。

```bash
curl -X POST http://localhost:3000/api/v1/system-prompt/preview \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "enabledTools": ["Read", "Write", "Bash", "Glob", "Grep"],
    "languagePreference": "zh-CN"
  }'
```

**响应**：

```json
{
  "fullPrompt": "...",
  "totalLength": 8192,
  "staticPart": "...",
  "dynamicPart": "...",
  "hasDynamicBoundary": true
}
```

---

## 运行时配置

### GET /config

获取完整运行时配置。

```bash
curl http://localhost:3000/api/v1/config
```

**响应**：

```json
{
  "config": {
    "compact": {
      "microEnabled": true,
      "microGapThresholdMinutes": 10,
      "modelMaxTokens": 200000
    },
    "budget": {
      "maxContextTokens": 200000,
      "reservedForSystem": 4000,
      "reservedForConversation": 50000
    },
    "circuitBreaker": {
      "compactMaxFailures": 3,
      "compactCooldownMs": 300000
    },
    "toolSummary": {
      "enabled": true,
      "model": "haiku"
    },
    "thinkingEffort": {
      "defaultEffort": "medium",
      "budgetMedium": 10000
    }
  }
}
```

### GET /config/:section

获取指定配置分区。

```bash
curl http://localhost:3000/api/v1/config/compact
curl http://localhost:3000/api/v1/config/budget
curl http://localhost:3000/api/v1/config/circuitBreaker
curl http://localhost:3000/api/v1/config/toolSummary
curl http://localhost:3000/api/v1/config/thinkingEffort
curl http://localhost:3000/api/v1/config/workingSet
curl http://localhost:3000/api/v1/config/consolidation
curl http://localhost:3000/api/v1/config/teamSync
curl http://localhost:3000/api/v1/config/postCompact
```

**响应**：

```json
{
  "section": "budget",
  "config": {
    "maxContextTokens": 200000,
    "reservedForSystem": 4000,
    "reservedForConversation": 50000,
    "reservedForTools": 10000,
    "memoryBudgetRatio": 0.25,
    "workingSetBudgetRatio": 0.15,
    "compressionThreshold": 0.85
  }
}
```

---

## 成本追踪

### GET /sessions/:id/cost

查询会话成本详情。

```bash
curl http://localhost:3000/api/v1/sessions/sess-xxx/cost
```

**响应**：

```json
{
  "sessionId": "sess-xxx",
  "totalCostUsd": 0.0523,
  "totalInputTokens": 15000,
  "totalOutputTokens": 3000,
  "isOverBudget": false,
  "isNearBudget": false,
  "remainingBudget": 0.9477,
  "report": "Input tokens: 15,000\nOutput tokens: 3,000\n...\nTotal cost: $0.0523\nBudget: $1.00\nRemaining: $0.9477"
}
```

### PUT /sessions/:id/budget

设置或更新会话预算。

```bash
curl -X PUT http://localhost:3000/api/v1/sessions/sess-xxx/budget \
  -H "Content-Type: application/json" \
  -d '{
    "maxBudgetUsd": 2.0
  }'
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `maxBudgetUsd` | `number` | 是 | 最大预算（美元，非负数） |

**响应**：

```json
{
  "sessionId": "sess-xxx",
  "maxBudgetUsd": 2.0,
  "totalCostUsd": 0.0523,
  "remainingBudget": 1.9477
}
```

---

## 记忆管理

### GET /memories

列出所有记忆文件。

```bash
curl http://localhost:3000/api/v1/memories
```

**响应**：

```json
{
  "count": 12,
  "global": 3,
  "project": 7,
  "session": 2,
  "memories": [
    {
      "path": "/path/to/memory.md",
      "type": "preference",
      "scope": "global",
      "description": "User prefers TypeScript",
      "mtimeMs": 1700000000000,
      "sizeBytes": 256
    }
  ]
}
```

### GET /memories/:name

获取指定记忆详情（含完整内容）。

```bash
curl http://localhost:3000/api/v1/memories/user-preferences
```

**响应**：

```json
{
  "path": "/path/to/user-preferences.md",
  "type": "preference",
  "scope": "global",
  "description": "User prefers TypeScript",
  "content": "---\ntype: preference\nscope: global\n---\n# User Preferences\n...",
  "frontmatter": {
    "type": "preference",
    "scope": "global"
  },
  "mtimeMs": 1700000000000,
  "sizeBytes": 256
}
```

### POST /memories/search

语义搜索记忆。

```bash
curl -X POST http://localhost:3000/api/v1/memories/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "项目使用的技术栈"
  }'
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | `string` | 是 | 搜索查询 |

**响应**：

```json
{
  "query": "项目使用的技术栈",
  "count": 3,
  "memories": [
    {
      "path": "/path/to/tech-stack.md",
      "type": "project",
      "scope": "project",
      "description": "Project tech stack",
      "content": "...",
      "freshnessWarning": null
    }
  ]
}
```

### DELETE /memories/:scope

删除指定范围的记忆。

```bash
curl -X DELETE http://localhost:3000/api/v1/memories/session
```

目前仅支持删除 `session` 范围的记忆。

**响应**：

```json
{
  "success": true,
  "deleted": 3,
  "scope": "session"
}
```

### POST /memories/extract

手动触发记忆提取。

```bash
curl -X POST http://localhost:3000/api/v1/memories/extract \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "sess-xxx"
  }'
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 否 | 从指定会话提取记忆（不指定则不提取对话） |

**响应**：

```json
{
  "success": true,
  "messageCount": 15
}
```

---

## 熔断器管理

### GET /circuit-breaker

查询熔断器状态。

```bash
curl http://localhost:3000/api/v1/circuit-breaker
```

**响应**：

```json
{
  "compact": {
    "state": "closed",
    "consecutiveFailures": 0,
    "lastFailureTime": 0,
    "timeUntilCooldown": 0
  },
  "consolidation": {
    "state": "closed",
    "consecutiveFailures": 0,
    "lastFailureTime": 0,
    "timeUntilCooldown": 0
  }
}
```

**state 值说明**：

| 值 | 说明 |
|------|------|
| `closed` | 正常状态，允许执行 |
| `open` | 熔断状态，拒绝执行 |
| `half_open` | 半开状态，允许有限尝试 |

### POST /circuit-breaker/reset

重置熔断器。

```bash
curl -X POST http://localhost:3000/api/v1/circuit-breaker/reset \
  -H "Content-Type: application/json" \
  -d '{
    "type": "all"
  }'
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | `string` | 否 | 重置类型：`compact` / `consolidation` / `all`（默认 `all`） |

**响应**：

```json
{
  "success": true,
  "compact": {
    "state": "closed",
    "consecutiveFailures": 0,
    "lastFailureTime": 0,
    "timeUntilCooldown": 0
  },
  "consolidation": {
    "state": "closed",
    "consecutiveFailures": 0,
    "lastFailureTime": 0,
    "timeUntilCooldown": 0
  }
}
```

---

## 上下文预算

### GET /context-budget

查询上下文预算配置与分配。

```bash
curl http://localhost:3000/api/v1/context-budget
```

**响应**：

```json
{
  "config": {
    "maxContextTokens": 200000,
    "reservedForSystem": 4000,
    "reservedForConversation": 50000,
    "reservedForTools": 10000,
    "memoryBudgetRatio": 0.25,
    "workingSetBudgetRatio": 0.15,
    "compressionThreshold": 0.85
  },
  "allocation": {
    "total": 200000,
    "systemInstruction": 4000,
    "workingSet": 20250,
    "memory": 33750,
    "conversation": 50000,
    "tools": 10000
  }
}
```

**allocation 字段说明**：

| 字段 | 说明 |
|------|------|
| `total` | 上下文窗口总 token 数 |
| `systemInstruction` | 系统指令预留 token 数 |
| `workingSet` | 工作集可用 token 数 |
| `memory` | 记忆注入可用 token 数 |
| `conversation` | 对话历史预留 token 数 |
| `tools` | 工具输出预留 token 数 |

---

## 相关文档

- [多供应商 LLM 接入](multi-provider.md)
- [作为后端服务使用](backend-service.md)
- [人机交互机制](human-interaction.md)
- [Skills 与 MCP 管理](skills-mcp-management.md)
- [环境变量](environment-variables.md)
