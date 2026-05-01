# 作为后端服务使用

> 📄 相关源文件：`src/server/main.ts`（启动入口）、`src/server/routes.ts`（核心路由）、`src/server/session.ts`（会话类型）、`src/server/session-store.ts`（会话持久化）

## 启动服务

### 方式一：使用 Anthropic（默认）

```bash
# .env 文件
ANTHROPIC_API_KEY=sk-ant-xxx

# 启动
npm run dev
```

### 方式二：使用 OpenAI 兼容供应商（如 DeepSeek、通义千问等）

```bash
# .env 文件
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-xxx
```

> 当 `LLM_PROVIDER` 设置为 `deepseek` 时，`LLM_BASE_URL` 和 `LLM_MODEL` 会自动使用默认值，无需手动指定。

### 方式三：通过配置文件配置多个供应商（推荐）

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
      "defaultModel": "gpt-4o"
    }
  ]
}
```

> 更多供应商配置方式（包括模型配置、中转供应商扩展等），详见 [多供应商 LLM 接入](multi-provider.md)。

## API 接口一览

> 📄 相关源文件：`src/server/routes.ts`（核心路由）、`src/server/skills-mcp-routes.ts`（Skills/MCP 路由）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/health` | 健康检查 |
| `GET` | `/api/v1/sessions` | 列出所有会话 |
| `POST` | `/api/v1/sessions` | 创建新会话 |
| `GET` | `/api/v1/sessions/:id` | 获取会话详情 |
| `DELETE` | `/api/v1/sessions/:id` | 删除会话 |
| `POST` | `/api/v1/sessions/:id/messages` | 发送消息（核心接口） |
| `POST` | `/api/v1/sessions/:id/input` | 用户输入（人机交互） |
| `GET` | `/api/v1/sessions/:id/messages` | 获取消息历史 |
| `GET` | `/api/v1/sessions/:id/usage` | 获取 Token 用量与成本 |
| `GET` | `/api/v1/agents` | 列出可用 Agent |
| `GET` | `/api/v1/tools` | 列出可用工具 |
| `GET` | `/api/v1/providers` | 列出已注册的 LLM 供应商 |
| `GET` | `/api/v1/skills` | 列出所有内置技能 |
| `GET` | `/api/v1/skills/discover` | 发现用户/项目技能 |
| `GET` | `/api/v1/skills/:name` | 获取技能详情 |
| `POST` | `/api/v1/skills` | 添加新技能 |
| `DELETE` | `/api/v1/skills/:name` | 删除技能 |
| `GET` | `/api/v1/mcp/servers` | 列出所有 MCP 服务器 |
| `GET` | `/api/v1/mcp/servers/:name` | 获取 MCP 服务器详情 |
| `POST` | `/api/v1/mcp/servers` | 添加 MCP 服务器 |
| `DELETE` | `/api/v1/mcp/servers/:name` | 删除 MCP 服务器 |
| `POST` | `/api/v1/mcp/servers/:name/connect` | 连接 MCP 服务器 |
| `POST` | `/api/v1/mcp/servers/:name/disconnect` | 断开 MCP 服务器 |
| `GET` | `/api/v1/mcp/tools` | 列出所有 MCP 工具 |

## 创建会话并对话

> 📄 相关源文件：`src/server/routes.ts`（路由处理）、`src/server/session.ts`（会话类型）、`src/server/session-store.ts`（会话持久化）

### 创建会话（使用默认供应商）

```bash
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "maxTurns": 50,
    "permissionMode": "bypassPermissions"
  }'
```

### 创建会话并指定供应商

供应商需预先配置（通过 `.env`、`sga-providers.json` 或 API），创建会话时只需指定 `providerName`：

```bash
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "maxTurns": 50,
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

### 发送消息

```bash
curl -X POST http://localhost:3000/api/v1/sessions/{sessionId}/messages \
  -H "Content-Type: application/json" \
  -d '{
    "content": "请帮我分析当前目录的项目结构"
  }'
```

### 流式发送消息（SSE）

```bash
curl -X POST http://localhost:3000/api/v1/sessions/{sessionId}/messages \
  -H "Content-Type: application/json" \
  -d '{
    "content": "请帮我分析当前目录的项目结构",
    "stream": true
  }'
```

## SSE 流式事件格式

> 📄 相关源文件：`src/server/routes.ts`（SSE 事件发送）、`src/server/session.ts`（事件类型定义）

| 事件类型 | 说明 |
|----------|------|
| `text_delta` | 文本增量输出 |
| `tool_use_start` | 工具调用开始 |
| `tool_use_result` | 工具调用结果 |
| `thinking_delta` | 思考过程增量 |
| `approval_required` | 需要用户审批（人机交互） |
| `human_input_required` | 需要用户输入（人机交互） |
| `turn_end` | 一轮对话结束 |
| `error` | 错误事件 |
| `done` | 全部完成 |

### SSE 事件数据格式

每个 SSE 事件的格式为：

```
event: {eventType}
data: {"type": "{eventType}", "data": ..., "sessionId": "..."}
```

示例：

```
event: text_delta
data: {"type": "text_delta", "data": "你好", "sessionId": "sess-xxx"}

event: tool_use_start
data: {"type": "tool_use_start", "data": {"name": "Bash", "input": {"command": "ls"}}, "sessionId": "sess-xxx"}

event: done
data: {"type": "done", "data": null, "sessionId": "sess-xxx"}
```

## 会话管理

### 会话状态

> 📄 相关源文件：`src/server/session.ts`、`src/server/session-store.ts`

每个会话包含以下状态信息：

- `id` — 会话唯一标识
- `createdAt` / `updatedAt` — 创建/更新时间
- `status` — 会话状态（`active` / `waiting_input` / `completed` / `error`）
- `messages` — 消息历史
- `config` — 会话配置（模型、权限模式、供应商等）
- `usage` — Token 用量统计
- `pendingAction` — 挂起的人机交互动作（如有）

### 会话持久化

> 📄 相关源文件：`src/server/session-store.ts`

会话数据通过 `SessionStore` 持久化到磁盘，使用 **JSONL 追加写入**格式确保崩溃安全：

| 文件 | 格式 | 说明 |
|------|------|------|
| `data/sessions/{id}.meta.json` | JSON | 会话元数据（ID、创建时间、配置、状态） |
| `data/sessions/{id}.jsonl` | JSONL | 消息和用量追加日志 |

**写入策略**：
- 每条消息和用量更新通过 `appendMessage()` / `appendUsage()` 实时追加到 JSONL 文件
- 写入操作通过 200ms 缓冲队列批量刷盘，减少磁盘 I/O
- 元数据变更（状态、错误）通过 `updateStatus()` 写入 meta 文件
- 服务器重启时自动从磁盘恢复所有会话

**自动迁移**：启动时检测旧格式 `.json` 会话文件，自动迁移为 JSONL 格式。

**优雅关闭**：服务器关闭时自动 flush 所有缓冲队列，确保数据完整。

### 创建会话参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `model` | `string` | `sonnet` | 模型名称或别名 |
| `maxTurns` | `number` | `50` | 最大对话轮数 |
| `maxBudgetUsd` | `number` | 无 | 最大预算（美元） |
| `permissionMode` | `string` | `default` | 权限模式 |
| `systemPrompt` | `string` | 无 | 自定义系统提示词 |
| `agentType` | `string` | 无 | 指定 Agent 类型 |
| `mcpServers` | `object[]` | 无 | MCP 服务器配置列表 |
| `providerName` | `string` | 无 | 供应商名称（需预先配置，不指定则使用默认供应商） |

## 相关文档

- [快速开始](quick-start.md)
- [人机交互机制](human-interaction.md)
- [多供应商 LLM 接入](multi-provider.md)
- [为任何产品提供 Agent 后端](agent-backend.md)
- [API 参考](api-reference.md)
