# 任务与团队协作

> 📄 相关源文件：`src/tasks/manager.ts`（TaskManager 类）、`src/teams/mailbox.ts`（团队邮箱）、`src/teams/types.ts`（团队类型定义）

## 任务系统

### 概述

任务系统跟踪 Agent 执行的工作单元，记录进度、Token 用量和活动日志。

### TaskManager

```typescript
import { TaskManager } from 'SGA-Template'

const taskManager = new TaskManager()

// 创建任务
const task = taskManager.create('task-1', '代码审查', 'agent-1', 'code-reviewer')

// 更新进度
taskManager.updateProgress('task-1', {
  inputTokens: 1000,
  outputTokens: 500,
  toolUseCount: 3,
})

// 完成任务
taskManager.complete('task-1', '审查完成，发现 3 个问题')

// 获取任务
const task = taskManager.get('task-1')

// 获取所有任务
const allTasks = taskManager.getAll()

// 按状态筛选
const runningTasks = taskManager.getByStatus('running')
```

### Task 类型

```typescript
// src/tasks/types.ts
export interface Task {
  id: string
  name?: string
  status: TaskStatus
  createdAt: number
  completedAt?: number
  output?: string
  error?: string
  progress: TaskProgress
  agentId?: string
  agentType?: string
}

export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface TaskProgress {
  inputTokens: number
  outputTokens: number
  toolUseCount: number
  recentActivities: string[]
  lastActivityAt: number
}
```

### TaskManager API

| 方法 | 说明 |
|------|------|
| `create(id, name?, agentId?, agentType?)` | 创建任务 |
| `get(id)` | 获取任务 |
| `getAll()` | 获取所有任务 |
| `getByStatus(status)` | 按状态筛选 |
| `updateProgress(id, update)` | 更新进度 |
| `complete(id, output?)` | 完成任务 |
| `fail(id, error)` | 标记失败 |
| `cancel(id)` | 取消任务 |
| `onNotification(handler)` | 监听任务通知 |

### 任务通知

```typescript
taskManager.onNotification((notification) => {
  console.log(`Task ${notification.taskId}: ${notification.status}`)
  console.log(`Summary: ${notification.summary}`)
})
```

## 团队协作

### 概述

团队协作系统允许多个 Agent 之间通过邮箱机制进行消息传递和协调。

### 团队邮箱

```typescript
import { TeamMailbox } from 'SGA-Template'

const mailbox = new TeamMailbox()

// 注册 Agent
mailbox.registerAgent('reviewer', { id: 'agent-1', type: 'code-reviewer' })
mailbox.registerAgent('developer', { id: 'agent-2', type: 'developer' })

// 发送消息
mailbox.sendMessage({
  from: 'developer',
  to: 'reviewer',
  type: 'review_request',
  content: '请审查 PR #42',
  metadata: { prNumber: 42 },
})

// 接收消息
const messages = mailbox.getMessages('reviewer')
const unread = mailbox.getUnreadMessages('reviewer')

// 标记已读
mailbox.markAsRead('reviewer', messages[0].id)
```

### 团队消息类型

```typescript
// src/teams/types.ts
export interface TeamMessage {
  id: string
  from: string
  to: string
  type: string
  content: string
  metadata?: Record<string, unknown>
  timestamp: number
  read: boolean
}

export interface AgentInfo {
  id: string
  type: string
  capabilities?: string[]
}
```

### 协作模式

#### 主从模式

一个主 Agent 分配任务给多个子 Agent：

```typescript
// 主 Agent 分配任务
mailbox.sendMessage({
  from: 'coordinator',
  to: 'reviewer',
  type: 'task_assignment',
  content: '审查 src/utils/ 目录',
})

mailbox.sendMessage({
  from: 'coordinator',
  to: 'developer',
  type: 'task_assignment',
  content: '修复 issue #123',
})
```

#### 对等模式

多个 Agent 平等协作：

```typescript
// Agent 之间直接沟通
mailbox.sendMessage({
  from: 'reviewer',
  to: 'developer',
  type: 'feedback',
  content: '请在 utils.ts 第 42 行添加错误处理',
})
```

## 相关文档

- [自定义 Agent](custom-agent.md)
- [技能系统](skills.md)
- [人机交互机制](human-interaction.md)
