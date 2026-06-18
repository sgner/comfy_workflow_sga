# Hook 钩子系统

> 📄 相关源文件：`src/hooks/types.ts`（Hook 事件类型定义）、`src/hooks/executor.ts`（HookRegistry 与 HookExecutor）、`src/hooks/config.ts`（Hook 配置持久化）

## 概述

Hook 钩子系统允许你在 Agent 执行的关键节点插入自定义逻辑，例如在工具调用前进行验证、在工具调用失败后进行重试、在消息发送后进行审计、在会话开始时初始化环境等。

## HookEventType

```typescript
// src/hooks/types.ts
export type HookEventType =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Stop'
  | 'TaskCompleted'
  | 'SessionEnd'
  | 'Cancel'
```

| 事件 | 触发时机 | 可中断 |
|------|----------|--------|
| `SessionStart` | Agent 会话开始时 | 否 |
| `UserPromptSubmit` | 用户提交消息时 | 否 |
| `PreToolUse` | 工具调用前 | **是**（返回 `proceed: false` 可阻止执行） |
| `PostToolUse` | 工具调用成功后 | 否 |
| `PostToolUseFailure` | 工具调用失败后 | 否 |
| `SubagentStart` | 子 Agent 启动时 | 否 |
| `SubagentStop` | 子 Agent 停止时 | 否 |
| `Stop` | Agent 停止时 | 否 |
| `TaskCompleted` | 后台任务完成时 | 否 |
| `SessionEnd` | Agent 会话结束时 | 否 |
| `Cancel` | 操作被取消时 | 否 |

### 事件执行顺序

```typescript
export const HOOK_EVENT_ORDER: HookEventType[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'TaskCompleted',
  'SessionEnd',
  'Cancel',
]
```

### 新增事件说明

#### PostToolUseFailure

工具调用失败后触发，可用于：
- 记录错误日志和分类
- 提供替代命令建议（通过 `additionalContext`）
- 触发自定义重试逻辑
- 通知外部监控系统

```typescript
// 注册失败处理 Hook
registry.register({
  event: 'PostToolUseFailure',
  matcher: 'Bash',
  command: 'python handle_bash_failure.py',
  timeout: 10000,
})
```

#### Cancel

操作被取消时触发，可用于：
- 清理临时资源
- 通知其他 Agent 停止依赖任务
- 记录取消原因

```typescript
registry.register({
  event: 'Cancel',
  command: 'python cleanup_on_cancel.py',
})
```

## HookDefinition

```typescript
// src/hooks/types.ts
export interface HookDefinition {
  event: HookEventType
  matcher?: string
  command: string
  once?: boolean
  timeout?: number
}
```

| 字段 | 说明 |
|------|------|
| `event` | 监听的事件类型 |
| `matcher` | 工具名匹配模式（可选，不设置则匹配所有工具）。支持 `*` 通配和 `\|` 分隔多选 |
| `command` | 要执行的 shell 命令 |
| `once` | 是否只执行一次（默认 false） |
| `timeout` | 超时时间（毫秒，默认 30000） |

### matcher 匹配规则

| matcher 值 | 匹配行为 |
|-----------|---------|
| 不设置 | 匹配所有工具 |
| `*` | 匹配所有工具 |
| `Bash` | 仅匹配 Bash 工具 |
| `Read\|Write\|Edit` | 匹配 Read、Write 或 Edit |

## HookResult

```typescript
// src/hooks/types.ts
export interface HookResult {
  exitCode: number
  stdout: string
  stderr: string
  proceed: boolean
  modifiedData?: unknown
  additionalContext?: string
  mcpOutput?: Record<string, unknown>
}
```

| 字段 | 说明 |
|------|------|
| `exitCode` | 命令退出码 |
| `stdout` | 标准输出 |
| `stderr` | 标准错误 |
| `proceed` | 是否继续执行。exitCode 为 2 时为 `false`，其他为 `true` |
| `modifiedData` | 修改后的数据（预留） |
| `additionalContext` | 额外上下文信息（如替代命令建议、错误解释等） |
| `mcpOutput` | MCP 工具输出（结构化数据） |

### additionalContext 用法

Hook 命令可以通过 stdout 输出 JSON 格式的 `additionalContext`，被 Agent Runner 解析后注入到对话上下文中：

```json
{
  "additionalContext": "Bash 命令 'npm test' 失败，建议尝试 'npx vitest run' 作为替代"
}
```

### mcpOutput 用法

MCP 工具的输出可以通过 `mcpOutput` 字段传递结构化数据：

```json
{
  "mcpOutput": {
    "tool": "browser_screenshot",
    "url": "http://localhost:3000",
    "status": "loaded"
  }
}
```

## HookExecutionContext

```typescript
// src/hooks/types.ts
export interface HookExecutionContext {
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  toolError?: string
  agentId?: string
  sessionId?: string
  cwd: string
  cancelled?: boolean
}
```

| 字段 | 说明 | 可用事件 |
|------|------|---------|
| `toolName` | 当前工具名 | PreToolUse, PostToolUse, PostToolUseFailure |
| `toolInput` | 工具输入 | PreToolUse, PostToolUse, PostToolUseFailure |
| `toolOutput` | 工具输出 | PostToolUse |
| `toolError` | 工具错误信息 | PostToolUseFailure |
| `agentId` | Agent ID | SubagentStart, SubagentStop |
| `sessionId` | 会话 ID | 所有事件 |
| `cwd` | 当前工作目录 | 所有事件 |
| `cancelled` | 是否被取消 | Cancel |

## 注册与执行 Hook

### 编程方式

```typescript
import { HookRegistry, HookExecutor } from 'SGA-Template'

const registry = new HookRegistry()

// 注册：在 Bash 工具调用前执行验证脚本
registry.register({
  event: 'PreToolUse',
  matcher: 'Bash',
  command: 'python validate.py',
  timeout: 10000,
})

// 注册：在所有工具调用后记录审计日志
registry.register({
  event: 'PostToolUse',
  command: 'python audit.py',
})

// 注册：会话开始时初始化环境
registry.register({
  event: 'SessionStart',
  command: 'bash init-env.sh',
  once: true,
})

const executor = new HookExecutor(registry)
const results = await executor.execute('PreToolUse', {
  toolName: 'Bash',
  toolInput: { command: 'npm test' },
  cwd: '/project',
})
```

### 配置文件方式

Hook 可持久化到配置文件，支持项目级和全局级：

- **项目级**：`.sga/hooks.json`
- **全局级**：`~/.sga/hooks.json`

项目级优先于全局级。

```json
{
  "version": 1,
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": "Bash",
      "command": "python validate.py",
      "timeout": 10000
    },
    {
      "event": "PostToolUse",
      "command": "python audit.py"
    },
    {
      "event": "SessionStart",
      "command": "bash init-env.sh",
      "once": true
    }
  ]
}
```

配置文件支持版本迁移，当 `version` 低于当前版本时会自动迁移并保存。

## HookRegistry API

| 方法 | 说明 |
|------|------|
| `register(hook)` | 注册 Hook |
| `unregister(event, command)` | 取消注册 |
| `getHooks(event)` | 获取指定事件的所有 Hook |
| `clear()` | 清空所有 Hook |

## HookExecutor 执行逻辑

1. 获取指定事件的所有 Hook
2. 如果 Hook 有 `matcher`，检查是否匹配当前工具名
3. 如果 Hook 设置了 `once`，检查是否已执行过
4. 执行 Hook 命令（通过 `child_process.execSync`）
5. 收集执行结果
6. 解析 stdout 中的结构化数据（`additionalContext`、`mcpOutput`）
7. 如果任一 Hook 返回 `proceed: false`（exitCode === 2），中断后续 Hook 和工具执行

### 专用执行方法

HookExecutor 提供了针对特定场景的专用方法：

| 方法 | 说明 |
|------|------|
| `execute(event, context)` | 通用执行方法 |
| `executeFailureHooks(toolName, toolInput, error, context)` | 执行 PostToolUseFailure Hook，自动注入 `toolError` |
| `executeCancelHooks(context)` | 执行 Cancel Hook，自动设置 `cancelled: true` |

```typescript
// 工具失败时调用
const failureResults = await executor.executeFailureHooks(
  'Bash',
  { command: 'npm test' },
  'Command failed with exit code 1',
  { cwd: '/project', sessionId: 'sess-123' },
)

// 操作取消时调用
const cancelResults = await executor.executeCancelHooks({
  cwd: '/project',
  sessionId: 'sess-123',
})
```

### 环境变量

Hook 命令执行时，会注入以下环境变量：

| 变量 | 说明 |
|------|------|
| `SGA_HOOK_EVENT` | 当前事件类型 |
| `SGA_TOOL_NAME` | 当前工具名 |
| `SGA_SESSION_ID` | 当前会话 ID |

### 中断执行

Hook 命令通过退出码控制是否中断：

| 退出码 | 含义 |
|--------|------|
| 0 | 正常，继续执行 |
| 2 | 阻止执行（`proceed: false`） |
| 其他 | 出错，但继续执行（`proceed: true`） |

## 与工具执行管线的集成

Hook 系统已集成到工具执行管线（`src/tools/execution.ts`）中：

### PreToolUse Hook

在权限检查之前执行，可修改工具输入或阻止执行：

```
工具调用请求
    │
    ▼
PreToolUse Hook 执行
    │
    ├─ proceed: false → 返回 HOOK_BLOCKED 错误
    │
    └─ proceed: true → 继续权限检查 → 工具执行
```

### PostToolUse Hook

在工具执行完成后执行，可获取工具输出：

```
工具执行完成
    │
    ▼
PostToolUse Hook 执行（含 toolOutput）
    │
    ▼
返回工具结果
```

### PostToolUseFailure Hook

在工具执行失败后执行，可获取错误信息并提供替代方案：

```
工具执行失败
    │
    ▼
PostToolUseFailure Hook 执行（含 toolError）
    │
    ├─ additionalContext → 注入到对话上下文（如替代命令建议）
    │
    └─ 继续 → 返回错误结果（触发重试/转向机制）
```

> PostToolUseFailure Hook 与 Agent Runner 的反思重试机制配合使用，详见 [项目架构](architecture.md) 中的"反思与重试机制"章节。

## 使用场景

### 代码质量检查

```json
{
  "event": "PreToolUse",
  "matcher": "Write",
  "command": "npx eslint --fix $FILE",
  "timeout": 30000
}
```

### 安全审计

```json
{
  "event": "PostToolUse",
  "matcher": "Bash",
  "command": "python log_bash_command.py"
}
```

### 自动格式化

```json
{
  "event": "PostToolUse",
  "matcher": "Edit",
  "command": "npx prettier --write $FILE",
  "timeout": 15000
}
```

### 会话初始化

```json
{
  "event": "SessionStart",
  "command": "bash setup-project.sh",
  "once": true
}
```

### 阻止危险操作

```json
{
  "event": "PreToolUse",
  "matcher": "Bash",
  "command": "python check-dangerous-cmd.py"
}
```

`check-dangerous-cmd.py` 检测到危险命令时以 exit code 2 退出，阻止工具执行。

## 相关文档

- [自定义工具](custom-tools.md)
- [权限控制](permissions.md)
- [人机交互机制](human-interaction.md)
- [API 参考 — Hook 接口](api-reference.md)
