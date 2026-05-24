# SGA Agent 事件系统与 SSE 流式协议

## 概述

SGA 的 Agent 事件系统参考 cc-haha-main (Claude Code) 的 `QueryProgressEvent` / `StreamEvent` / `StreamClientEvent` 设计，实现了结构化的 SSE 流式事件协议。

### 设计来源

cc-haha-main 的事件系统包含三层：

1. **Provider 层** — `StreamEvent`：Anthropic SDK 原始流事件（`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`）
2. **Agent 层** — `QueryProgressEvent`：Agent 执行循环的高层语义事件（`turn_start`, `api_call_start`, `stream_delta`, `tool_use_start`, `tool_use_result`, `turn_end`, `stop` 等）
3. **传输层** — `StreamClientEvent`：SSE 传输帧，包含 `event_id`, `sequence_num`, `event_type`, `source`, `payload`, `created_at`

SGA 参考了第 2 层和第 3 层的设计，将事件类型化和 SSE 传输格式统一。

---

## SSE 协议格式

### 旧格式（仅 data）

```
data: {"type":"text_delta","data":"Hello"}
```

### 新格式（event + data）

```
event: stream_delta
data: {"type":"stream_delta","text":"Hello"}

event: tool_use_start
data: {"type":"tool_use_start","toolName":"Bash","toolUseId":"toolu_01abc"}

event: done
data: {"type":"done","data":{"content":"...","usage":{...}}}
```

`event` 字段对应 `AgentStreamEvent.type`，客户端可据此注册事件监听器：

```javascript
const es = new EventSource('/api/v1/sessions/{id}/messages', { method: 'POST' })

es.addEventListener('stream_delta', (e) => {
  const data = JSON.parse(e.data)
  appendText(data.text)
})

es.addEventListener('tool_use_start', (e) => {
  const data = JSON.parse(e.data)
  showToolIndicator(data.toolName)
})

es.addEventListener('done', (e) => {
  const data = JSON.parse(e.data)
  finalize(data.data.content, data.data.usage)
})
```

---

## 事件类型定义

### AgentStreamEvent

定义于 `src/core/types.ts`，是 Agent 执行过程中所有可观测事件的联合类型：

| 事件类型 | 触发时机 | 数据字段 |
|---------|---------|---------|
| `session_start` | SSE 连接建立、Agent 开始执行 | `sessionId`, `model`, `agentType?` |
| `turn_start` | 每个 Agent Loop 迭代开始 | `turnCount` |
| `api_call_start` | 调用 LLM Provider 前 | `turnCount` |
| `stream_delta` | LLM 返回文本增量 | `text` |
| `thinking_delta` | LLM 返回思考增量 | `text` |
| `tool_use_start` | 检测到工具调用开始 | `toolName`, `toolUseId` |
| `tool_progress` | 工具执行过程中的实时进度 | `toolName`, `toolUseId`, `data: ToolProgressData`, `parentToolUseId?` |
| `tool_use_end` | 工具执行完成（预留） | `toolName`, `toolUseId`, `isError` |
| `tool_use_result` | 工具执行结果就绪 | `toolName`, `result: { toolUseId, content, isError }` |
| `turn_end` | 当前轮次结束 | `turnCount`, `usage` |
| `approval_required` | 工具需要用户审批 | `actionId`, `toolName`, `toolInput`, `toolCallId`, `message`, `suggestions?` |
| `human_input_required` | Agent 需要用户输入 | `actionId`, `message`, `context?`, `options?` |
| `compact_start` | 上下文压缩开始（预留） | `reason` |
| `compact_end` | 上下文压缩完成（预留） | `messagesRemoved` |
| `task_started` | 后台任务启动 | `taskId`, `description`, `taskType?`, `toolUseId?` |
| `task_progress` | 后台任务进度更新 | `taskId`, `description`, `usage`, `lastToolName?`, `summary?` |
| `task_notification` | 后台任务完成/失败/停止 | `taskId`, `toolUseId?`, `status`, `summary` |
| `recovery` | 错误恢复（预留） | `error`, `attempt` |
| `stop` | Agent 循环终止 | `reason: StopReason` |
| `done` | SSE 流结束 | `data: { content, usage } \| null` |
| `error` | 发生错误 | `data: string` |

### 流式模式 Usage 统计

`done` 事件的 `data.usage` 字段包含完整的 Token 用量统计。流式模式下 usage 数据的采集机制因供应商而异：

| 供应商 | Usage 采集方式 | 说明 |
|--------|---------------|------|
| **Anthropic** | `message_start` 提供 `inputTokens`，`message_delta` 提供 `outputTokens` | 按事件类型分散提供 |
| **OpenAI 兼容** | 最后一个 chunk（`choices: []`）提供完整 usage | 需启用 `stream_options: { include_usage: true }` |

> ⚠️ OpenAI 兼容供应商的 usage 数据在流的最后一个 chunk 中返回（该 chunk 的 `choices` 为空数组）。框架已处理此场景，确保 usage 数据正确采集。如果供应商不支持 `stream_options`，usage 可能为 0。

`turn_end` 事件也包含当前轮次的 `usage` 字段，可用于实时监控 Token 消耗。

Usage 统计在 `consumeStream()` 中累积，每轮 LLM 调用的 usage 会叠加到 `AgentLoopResult.usage`，最终通过 `done` 事件返回总 usage。

### SSEEvent 接口

```typescript
export interface SSEEvent<T extends AgentStreamEvent = AgentStreamEvent> {
  event: SSEEventType    // 等同于 AgentStreamEvent['type']
  data: T               // 完整的事件数据
  id?: string           // 可选的事件 ID（用于 Last-Event-ID 重连）
  retry?: number        // 可选的重连间隔（毫秒）
}
```

### actionId 字段

`approval_required` 和 `human_input_required` 事件包含 `actionId` 字段，用于标识当前交互请求。客户端在提交用户输入时必须使用此 ID，否则会收到 `Invalid or expired action ID` 错误。

```typescript
// approval_required 事件
| { type: 'approval_required'; actionId: string; toolName: string; toolInput: Record<string, unknown>; toolCallId: string; message: string; suggestions?: string[] }

// human_input_required 事件
| { type: 'human_input_required'; actionId: string; message: string; context?: string; options?: Array<{ label: string; value: string; description?: string }> }
```

**SSE 输出示例**：

```
event: approval_required
data: {"type":"approval_required","actionId":"approval-1700000000-abc123","toolName":"Bash","toolInput":{"command":"rm -rf node_modules"},"toolCallId":"toolu_01abc","message":"Bash 工具请求执行删除命令，是否允许？","suggestions":["允许","拒绝","修改命令"]}

event: human_input_required
data: {"type":"human_input_required","actionId":"input-1700000000-def456","message":"请选择部署环境","options":[{"label":"开发环境","value":"dev"},{"label":"生产环境","value":"prod"}]}
```

**客户端提交审批时使用 actionId**：

```bash
curl -X POST http://localhost:3000/api/v1/sessions/{sessionId}/input \
  -H "Content-Type: application/json" \
  -d '{
    "actionId": "approval-1700000000-abc123",
    "decision": "allow"
  }'
```

> ⚠️ `actionId` 具有时效性，长时间未响应会过期，此时提交会返回 `{"error": "Invalid or expired action ID"}`。

---

## 事件流转架构

```
┌─────────────────────────────────────────────────────────────┐
│                     HTTP Client                              │
│  EventSource / fetch + ReadableStream                        │
│  es.addEventListener('stream_delta', handler)                │
│  es.addEventListener('tool_use_start', handler)              │
└──────────────────────────┬──────────────────────────────────┘
                           │ SSE: event + data
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Server (routes.ts)                         │
│                                                              │
│  sendEvent(event: AgentStreamEvent)                          │
│    → res.write(formatSSE(event))                             │
│    → "event: {type}\ndata: {json}\n\n"                       │
│                                                              │
│  onProgress: (event) => sendEvent(event)                     │
└──────────────────────────┬──────────────────────────────────┘
                           │ AgentStreamEvent
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                Agent Runner (runner.ts)                      │
│                                                              │
│  executeAgentLoop() {                                        │
│    onProgress({ type: 'turn_start', turnCount })             │
│    onProgress({ type: 'api_call_start', turnCount })         │
│    consumeStream(provider, options, onProgress)              │
│      → onProgress({ type: 'stream_delta', text })            │
│      → onProgress({ type: 'thinking_delta', text })          │
│      → onProgress({ type: 'tool_use_start', ... })           │
│    onProgress({ type: 'tool_use_result', ... })              │
│    onProgress({ type: 'turn_end', turnCount, usage })        │
│  }                                                           │
└──────────────────────────┬──────────────────────────────────┘
                           │ Provider StreamChunk
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              LLM Provider (anthropic/openai/transformable)   │
│                                                              │
│  createStreamingMessage() → AsyncIterable<ProviderStreamChunk│
│    { type: 'stream_chunk' | 'message_start' |               │
│      'content_block_start' | 'content_block_delta' |        │
│      'content_block_stop' | 'message_delta' | 'message_stop'}│
└─────────────────────────────────────────────────────────────┘
```

---

## 与 cc-haha-main 的对照

| cc-haha-main | SGA | 说明 |
|-------------|-----|------|
| `StreamEvent` (Provider 层) | `ProviderStreamChunk` | Provider 原始流事件，SGA 已有 |
| `QueryProgressEvent` (Agent 层) | `AgentStreamEvent` | Agent 高层语义事件，本次迁移 |
| `StreamClientEvent` (传输层) | `SSEEvent` | SSE 传输帧，本次迁移 |
| `handleMessageFromStream()` | `consumeStream()` + `onProgress` | 流事件处理，SGA 简化为直接转发 |
| `event: client_event` (SSE) | `event: {AgentStreamEvent.type}` | cc-haha-main 单一事件类型，SGA 按类型分发 |
| `data: StreamClientEvent` (SSE) | `data: AgentStreamEvent` | cc-haha-main 有 envelope，SGA 扁平化 |

### 关键差异

1. **SSE 事件分发**：cc-haha-main 使用单一 `event: client_event`，客户端需解析 `payload.type`；SGA 使用 `event: {type}` 直接分发，客户端可用 `addEventListener` 按类型监听
2. **事件信封**：cc-haha-main 的 `StreamClientEvent` 包含 `event_id`, `sequence_num`, `source`, `created_at` 等元数据；SGA 的 `AgentStreamEvent` 扁平化，不含传输元数据（可后续通过 `SSEEvent.id` 扩展）
3. **消息类型**：cc-haha-main 区分 `StreamEvent`（流增量）和 `Message`（完整消息）；SGA 统一为 `AgentStreamEvent`，完整消息在 `done` 事件中返回

---

## 客户端接入指南

### JavaScript / TypeScript

```typescript
interface AgentStreamEvent {
  type: 'session_start' | 'turn_start' | 'api_call_start' |
        'stream_delta' | 'thinking_delta' | 'tool_use_start' |
        'tool_use_end' | 'tool_use_result' | 'turn_end' |
        'approval_required' | 'human_input_required' |
        'compact_start' | 'compact_end' | 'recovery' |
        'stop' | 'done' | 'error'
  [key: string]: unknown
}

async function streamAgentMessage(
  sessionId: string,
  content: string,
  handlers: {
    onText?: (text: string) => void
    onThinking?: (text: string) => void
    onToolStart?: (toolName: string, toolUseId: string) => void
    onToolResult?: (toolName: string, result: { toolUseId: string; content: string; isError: boolean }) => void
    onApprovalRequired?: (data: { actionId: string; toolName: string; toolInput: Record<string, unknown>; toolCallId: string; message: string }) => Promise<{ decision: 'allow' | 'deny'; updatedInput?: Record<string, unknown> }>
    onDone?: (content: string, usage: unknown) => void
    onError?: (error: string) => void
  }
): Promise<void> {
  const response = await fetch(`/api/v1/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, stream: true }),
  })

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    let currentEvent = ''
    let currentData = ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7)
      } else if (line.startsWith('data: ')) {
        currentData = line.slice(6)
      } else if (line === '' && currentEvent && currentData) {
        const event = JSON.parse(currentData) as AgentStreamEvent

        switch (event.type) {
          case 'stream_delta':
            handlers.onText?.(event.text)
            break
          case 'thinking_delta':
            handlers.onThinking?.(event.text)
            break
          case 'tool_use_start':
            handlers.onToolStart?.(event.toolName, event.toolUseId)
            break
          case 'tool_use_result':
            handlers.onToolResult?.(event.toolName, event.result)
            break
          case 'approval_required':
            if (handlers.onApprovalRequired) {
              const decision = await handlers.onApprovalRequired(event)
              await fetch(`/api/v1/sessions/${sessionId}/input`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  actionId: event.actionId,
                  decision: decision.decision,
                  updatedInput: decision.updatedInput,
                }),
              })
            }
            break
          case 'done':
            if (event.data) {
              handlers.onDone?.(event.data.content, event.data.usage)
            }
            break
          case 'error':
            handlers.onError?.(event.data)
            break
        }

        currentEvent = ''
        currentData = ''
      }
    }
  }
}
```

### EventSource (浏览器原生)

注意：浏览器原生 `EventSource` 仅支持 GET 请求。如需 POST + SSE，需使用 `fetch` + `ReadableStream` 或第三方库如 `@microsoft/fetch-event-source`。

```javascript
// 仅适用于 GET 端点（如 task notifications）
const es = new EventSource('/api/v1/tasks/{taskId}/notifications')

es.addEventListener('task_notification', (e) => {
  const notification = JSON.parse(e.data)
  console.log('Task notification:', notification)
})
```

---

## 文件变更清单

| 文件 | 变更 |
|------|------|
| `src/core/types.ts` | 新增 `AgentStreamEvent`, `SSEEventType`, `SSEEvent` 类型定义 |
| `src/core/index.ts` | 导出新增类型 |
| `src/server/session.ts` | `StreamEventPayload` 改为 `AgentStreamEvent` 别名；新增 `formatSSE()`, `parseSSE()` 函数；导出 `AgentStreamEvent`, `SSEEventType`, `SSEEvent` |
| `src/server/index.ts` | 导出 `formatSSE`, `parseSSE`, `AgentStreamEvent`, `SSEEventType`, `SSEEvent` |
| `src/server/routes.ts` | `sendEvent` 使用 `formatSSE()` 输出 `event: + data:` 格式；`onProgress` 直接转发 `AgentStreamEvent`；新增 `session_start` 事件；`approval_required` / `human_input_required` 使用结构化字段替代 `data` 包裹；任务通知使用 `event: task_notification` |
| `src/agents/runner.ts` | `onProgress` 类型从 `(event: unknown) => void` 改为 `(event: AgentStreamEvent) => void`；新增 `turn_start`, `api_call_start`, `turn_end` 事件发射；`tool_use_result` 使用结构化 `result` 字段；`orchestrateToolCalls` 传递 `onProgress` 回调；审批通过后重新执行工具时传递 `onProgress` |

---

## 工具级 onProgress 回调

### 设计动机

cc-haha-main 的工具（如 Bash, WebSearch）在执行过程中可以发射 `tool_progress` 事件，通过 `StdoutMessage` 管道传输给客户端。这使得客户端可以实时看到命令行输出、搜索进度等，而不必等到工具执行完毕。

SGA 实现了相同的机制：工具的 `call()` 方法接受可选的 `onProgress` 回调，工具在执行过程中调用它来发射进度事件，这些事件通过 `AgentStreamEvent.tool_progress` 传递到 SSE 流。

### ToolProgressData 类型

```typescript
export type ToolProgressData =
  | { type: 'stdout'; text: string }        // 标准输出增量
  | { type: 'stderr'; text: string }        // 标准错误增量
  | { type: 'progress'; message: string; percentage?: number }  // 进度更新
  | { type: 'status'; message: string }     // 状态变更
  | { type: 'custom'; [key: string]: unknown }  // 自定义数据
```

### BashProgressData 扩展类型

Bash 工具在通用 `ToolProgressData` 基础上扩展了结构化的 `bash_progress` 类型，与 cc-haha-main 的 `BashProgress` 对齐：

```typescript
export type BashProgressData =
  | ToolProgressData
  | { type: 'bash_progress'; output: string; fullOutput: string; elapsedTimeSeconds: number; totalLines: number; totalBytes: number; taskId?: string; timeoutMs?: number }
```

Bash 工具同时发射两种进度：
- **stdout/stderr**：每个 chunk 实时发射（细粒度，用于终端输出展示）
- **bash_progress**：节流发射（1 秒间隔，结构化数据，用于进度条/统计展示）

### 工具实现示例

```typescript
import { BaseTool, type ToolProgressCallback } from '../base.js'

class MyTool extends BaseTool<{ query: string }, string> {
  async call(input: { query: string }, _context: ToolUseContext, onProgress?: ToolProgressCallback): Promise<string> {
    onProgress?.({ type: 'status', message: 'Starting search...' })

    // 长时间操作中发射进度
    for (let i = 0; i < 10; i++) {
      await doStep(i)
      onProgress?.({ type: 'progress', message: `Step ${i + 1}/10`, percentage: (i + 1) * 10 })
    }

    onProgress?.({ type: 'status', message: 'Search complete' })
    return result
  }
}
```

### Bash 工具实时输出

Bash 工具已改造为支持实时输出：

- **无 onProgress**：使用 `execSync` 同步执行（向后兼容）
- **有 onProgress**：使用 `spawn` 异步执行，同时发射两种进度：
  - `stdout`/`stderr`：每个 chunk 实时发射
  - `bash_progress`：节流发射（1 秒间隔），包含结构化数据（行数、字节数、耗时）

SSE 输出示例：

```
event: tool_progress
data: {"type":"tool_progress","toolName":"Bash","toolUseId":"toolu_01","data":{"type":"stdout","text":"Building project...\n"}}

event: tool_progress
data: {"type":"tool_progress","toolName":"Bash","toolUseId":"toolu_01","data":{"type":"stdout","text":"  Compiling src/index.ts\n"}}

event: tool_progress
data: {"type":"tool_progress","toolName":"Bash","toolUseId":"toolu_01","data":{"type":"bash_progress","output":"...","fullOutput":"...","elapsedTimeSeconds":5.2,"totalLines":42,"totalBytes":8192,"timeoutMs":120000}}

event: tool_use_result
data: {"type":"tool_use_result","toolName":"Bash","result":{"toolUseId":"toolu_01","content":"Build successful","isError":false}}
```

### 事件流转

```
Tool.call(input, context, onProgress)
  │
  ├─ onProgress({ type: 'stdout', text: '...' })
  ├─ onProgress({ type: 'progress', message: '...', percentage: 50 })
  ├─ onProgress({ type: 'stderr', text: '...' })
  │
  ▼
execution.ts pipeline
  │  tool.call(currentInput, context, onProgress)
  ▼
orchestrateToolCalls(tools, ..., onProgress)
  │  pipeline.execute(tool, input, context, toolProgress)
  │  toolProgress = (data) => onProgress(toolUseId, data)
  ▼
runner.ts
  │  orchestrateToolCalls(calls, ..., (toolUseId, data) => {
  │    onProgress({ type: 'tool_progress', toolName, toolUseId, data })
  │  })
  ▼
routes.ts
  │  onProgress: (event: AgentStreamEvent) => sendEvent(event)
  ▼
SSE Client
  │  event: tool_progress
  │  data: { type: 'tool_progress', toolName, toolUseId, data: { type: 'stdout', text: '...' } }
```

### 客户端监听 tool_progress

```javascript
es.addEventListener('tool_progress', (e) => {
  const { toolName, toolUseId, data } = JSON.parse(e.data)

  switch (data.type) {
    case 'stdout':
      appendTerminalOutput(toolUseId, data.text)
      break
    case 'stderr':
      appendTerminalError(toolUseId, data.text)
      break
    case 'progress':
      updateProgressBar(toolUseId, data.percentage, data.message)
      break
    case 'status':
      updateToolStatus(toolUseId, data.message)
      break
    case 'bash_progress':
      updateBashStats(toolUseId, {
        lines: data.totalLines,
        bytes: data.totalBytes,
        elapsed: data.elapsedTimeSeconds,
        output: data.output,
      })
      break
    case 'custom':
      handleCustomProgress(toolUseId, data)
      break
  }
})

es.addEventListener('task_started', (e) => {
  const { taskId, description, taskType } = JSON.parse(e.data)
  addTask(taskId, { description, taskType })
})

es.addEventListener('task_progress', (e) => {
  const { taskId, description, usage, summary } = JSON.parse(e.data)
  updateTask(taskId, { description, usage, summary })
})

es.addEventListener('task_notification', (e) => {
  const { taskId, status, summary } = JSON.parse(e.data)
  completeTask(taskId, { status, summary })
})
```
