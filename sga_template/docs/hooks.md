# Hook 钩子系统

> 📄 相关源文件：`src/hooks/executor.ts`（HookRegistry 与 HookExecutor）、`src/hooks/types.ts`（Hook 事件类型定义）

## 概述

Hook 钩子系统允许你在 Agent 执行的关键节点插入自定义逻辑，例如在工具调用前进行验证、在消息发送后进行审计等。

## HookEventType

```typescript
// src/hooks/types.ts
export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
```

| 事件 | 触发时机 |
|------|----------|
| `PreToolUse` | 工具调用前 |
| `PostToolUse` | 工具调用后 |
| `Notification` | 通知事件 |
| `Stop` | Agent 停止时 |
| `SubagentStop` | 子 Agent 停止时 |

## HookDefinition

```typescript
// src/hooks/types.ts
export interface HookDefinition {
  event: HookEventType
  matcher?: string
  command: string
  timeout?: number
  once?: boolean
}
```

| 字段 | 说明 |
|------|------|
| `event` | 监听的事件类型 |
| `matcher` | 工具名匹配模式（可选，不设置则匹配所有工具） |
| `command` | 要执行的 shell 命令 |
| `timeout` | 超时时间（毫秒，默认 30000） |
| `once` | 是否只执行一次 |

## HookResult

```typescript
// src/hooks/types.ts
export interface HookResult {
  proceed: boolean
  modifiedData?: unknown
  message?: string
}
```

| 字段 | 说明 |
|------|------|
| `proceed` | 是否继续执行（false 会中断后续流程） |
| `modifiedData` | 修改后的数据 |
| `message` | 消息 |

## HookExecutionContext

```typescript
// src/hooks/types.ts
export interface HookExecutionContext {
  toolName?: string
  toolInput?: Record<string, unknown>
  sessionId?: string
  cwd?: string
  [key: string]: unknown
}
```

## 注册与执行 Hook

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

const executor = new HookExecutor(registry)
const results = await executor.execute('PreToolUse', {
  toolName: 'Bash',
  toolInput: { command: 'npm test' },
  cwd: '/project',
})
```

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
6. 如果任一 Hook 返回 `proceed: false`，中断后续 Hook 和工具执行

### 环境变量

Hook 命令执行时，会注入以下环境变量：

| 变量 | 说明 |
|------|------|
| `SGA_HOOK_EVENT` | 当前事件类型 |
| `SGA_TOOL_NAME` | 当前工具名 |
| `SGA_SESSION_ID` | 当前会话 ID |

## 使用场景

### 代码质量检查

```typescript
registry.register({
  event: 'PreToolUse',
  matcher: 'Write',
  command: 'npx eslint --fix $FILE',
  timeout: 30000,
})
```

### 安全审计

```typescript
registry.register({
  event: 'PostToolUse',
  matcher: 'Bash',
  command: 'python log_bash_command.py',
})
```

### 自动格式化

```typescript
registry.register({
  event: 'PostToolUse',
  matcher: 'Edit',
  command: 'npx prettier --write $FILE',
  timeout: 15000,
})
```

## 相关文档

- [自定义工具](custom-tools.md)
- [权限控制](permissions.md)
- [人机交互机制](human-interaction.md)
