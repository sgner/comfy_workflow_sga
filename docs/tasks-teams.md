# 任务与团队协作

> 📄 相关源文件：`src/tasks/manager.ts`（TaskManager 类）、`src/tasks/types.ts`（任务类型定义）、`src/agents/coordinator.ts`（编排器）

## 任务系统

### 概述

任务系统跟踪 Agent 执行的工作单元，记录进度、Token 用量和活动日志。增强后的 TaskManager 支持多种任务类型（agent、coordinator、fork、generic）、父子任务关系、中止控制器和实时通知。

### Task 类型

```typescript
// src/tasks/types.ts
export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed' | 'pending'
export type TaskKind = 'agent' | 'coordinator' | 'fork' | 'generic'

export interface Task {
  id: string
  name?: string
  kind: TaskKind
  status: TaskStatus
  createdAt: number
  completedAt?: number
  output?: string
  error?: string
  progress: TaskProgress
  agentId?: string
  agentType?: string
  parentTaskId?: string
  abortController?: AbortController
  metadata?: Record<string, unknown>
}

export interface TaskProgress {
  inputTokens: number
  outputTokens: number
  toolUseCount: number
  turnCount: number
  recentActivities: string[]
  lastActivityAt: number
}

export interface TaskNotification {
  taskId: string
  status: TaskStatus
  summary: string
  outputFile?: string
  error?: string
  result?: string
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    totalCostUsd: number
  }
  durationMs?: number
}
```

### TaskManager

```typescript
import { getTaskManager } from 'SGA-Template'

const taskManager = getTaskManager()

// 创建任务（新 API — 支持对象参数）
const task = taskManager.create({
  id: 'task-1',
  name: '代码审查',
  kind: 'agent',
  agentId: 'agent-1',
  agentType: 'code-reviewer',
  parentTaskId: 'parent-task-0',
})

// 兼容旧 API
const task2 = taskManager.create('task-2', '安全扫描', 'agent-2', 'security-scanner')

// 更新进度
taskManager.updateProgress('task-1', {
  inputTokens: 1000,
  outputTokens: 500,
  toolUseCount: 3,
  turnCount: 2,
})

// 添加活动日志
taskManager.addActivity('task-1', 'Read file: src/auth/validate.ts')

// 完成任务（带用量信息）
taskManager.completeWithUsage('task-1', '审查完成，发现 3 个问题', {
  inputTokens: 5000,
  outputTokens: 2000,
  totalTokens: 7000,
  totalCostUsd: 0.035,
}, 15000)

// 完成任务（简单版）
taskManager.complete('task-1', '审查完成')

// 标记失败
taskManager.fail('task-1', 'Provider 调用失败')

// 终止任务
taskManager.kill('task-1')

// 获取任务
const task = taskManager.get('task-1')

// 获取所有任务
const allTasks = taskManager.getAll()

// 按状态筛选
const runningTasks = taskManager.getByStatus('running')

// 按类型筛选
const agentTasks = taskManager.getByKind('agent')

// 按父任务筛选
const subTasks = taskManager.getByParent('parent-task-0')

// 获取运行中的 Agent 任务
const runningAgents = taskManager.getRunningAgentTasks()

// 设置中止控制器
const abortController = new AbortController()
taskManager.setAbortController('task-1', abortController)

// 设置为待执行
taskManager.setPending('task-1')
```

### TaskManager API

| 方法 | 说明 |
|------|------|
| `create(options)` | 创建任务（支持对象参数或位置参数） |
| `get(id)` | 获取任务 |
| `getAll()` | 获取所有任务 |
| `getByStatus(status)` | 按状态筛选 |
| `getByKind(kind)` | 按类型筛选 |
| `getByParent(parentId)` | 按父任务筛选 |
| `getRunningAgentTasks()` | 获取运行中的 Agent 任务 |
| `updateProgress(id, update)` | 更新进度 |
| `addActivity(id, activity)` | 添加活动日志 |
| `complete(id, output?)` | 完成任务 |
| `completeWithUsage(id, output, usage, durationMs)` | 完成任务（带用量） |
| `fail(id, error)` | 标记失败 |
| `kill(id)` | 终止任务 |
| `setPending(id)` | 设置为待执行 |
| `setAbortController(id, controller)` | 设置中止控制器 |
| `onNotification(handler)` | 监听任务通知 |
| `removeNotificationHandler(handler)` | 移除通知处理器 |
| `getPendingNotifications()` | 获取待发送通知 |
| `cleanup(maxAge?)` | 清理过期任务 |

### 任务通知

```typescript
taskManager.onNotification((notification) => {
  console.log(`Task ${notification.taskId}: ${notification.status}`)
  console.log(`Summary: ${notification.summary}`)
  if (notification.result) console.log(`Result: ${notification.result}`)
  if (notification.usage) console.log(`Usage: ${notification.usage.totalTokens} tokens, $${notification.usage.totalCostUsd}`)
  if (notification.durationMs) console.log(`Duration: ${notification.durationMs}ms`)
})
```

### 任务通知 SSE 流

通过 API 订阅实时任务通知：

```bash
GET /api/v1/tasks/notifications
Accept: text/event-stream

# 接收事件
data: {"taskId":"task-1","status":"completed","summary":"Task \"代码审查\" completed","result":"审查完成，发现 3 个问题","usage":{"inputTokens":5000,"outputTokens":2000,"totalTokens":7000,"totalCostUsd":0.035},"durationMs":15000}
```

## 多 Agent 编排

### Coordinator 模式

Coordinator 模式参考 cc-haha-main 的实现，支持多 Agent 并行调度与结果汇总。详见 [自定义 Agent](custom-agent.md#agent-编排--coordinator-模式)。

### 编排流程

```
用户查询 → Coordinator → 分解任务 → 并行/串行调度 Agent → 汇总结果
```

### 工作阶段

| 阶段 | 说明 | 并发策略 |
|------|------|----------|
| Research | 调查代码库，理解问题 | 可并行 |
| Synthesis | 综合研究结果，设计实现方案 | 串行 |
| Implementation | 执行代码修改 | 串行（按文件集） |
| Verification | 验证实现是否正确 | 可并行 |

### 编排策略

| 策略 | 说明 |
|------|------|
| `parallel` | 所有任务并行执行 |
| `sequential` | 所有任务串行执行 |
| `hybrid` | 按阶段执行：research/verification 可并行，implementation 串行（推荐） |

### 动态规划

Coordinator 支持两种规划方式：

- **静态规划** — `createCoordinatorPlanFromUserQuery()` 基于模板生成固定步骤
- **动态规划** — `generateDynamicPlan()` 让 LLM 根据查询内容和可用 Agent 智能生成最优计划

```typescript
import { generateDynamicPlan, getAllAgentDefinitions } from 'SGA-Template'

const agentDefs = await getAllAgentDefinitions()
const plan = await generateDynamicPlan('Rust 异步编程有哪些坑？', agentDefs, provider, 'sonnet')
```

详见 [自定义 Agent - 动态规划](custom-agent.md#动态规划--llm-智能生成计划)。

### 上下文注入

当任务声明了 `dependsOn` 依赖关系时，Coordinator 会自动将依赖步骤的结果注入到当前步骤的 prompt 前面，确保后续 Agent 能看到前一步的输出。

详见 [自定义 Agent - 上下文注入](custom-agent.md#上下文注入--自动传递步骤结果)。

### 计划动态更新

Coordinator 支持在执行过程中动态修改计划：

```typescript
coordinator.addStep({ description: '补充安全审查', phase: 'verification', agentType: 'SecurityScanner', prompt: '...' })
coordinator.skipTask('coord-task-xxx', '不再需要')
coordinator.updateTaskPrompt('coord-task-xxx', '更新后的 prompt')
```

详见 [自定义 Agent - 计划动态更新](custom-agent.md#计划动态更新)。

### 计划持久化与断点续跑

Coordinator 在执行过程中自动保存快照到 `.sga/snapshots/`，支持从断点恢复执行：

```typescript
import { Coordinator, listSnapshots } from 'SGA-Template'

const snapshots = listSnapshots()
const coordinator = new Coordinator(config)
const result = await coordinator.resumeFromSnapshot('.sga/snapshots/plan-xxx.json')
```

详见 [自定义 Agent - 计划持久化与断点续跑](custom-agent.md#计划持久化与断点续跑)。

### 使用示例

```typescript
import { Coordinator, createCoordinatorPlanFromUserQuery, generateDynamicPlan, getAllAgentDefinitions } from 'SGA-Template'

const agentDefs = await getAllAgentDefinitions()

// 静态规划
const plan = createCoordinatorPlanFromUserQuery('修复 auth 模块中的空指针异常', agentDefs)

// 动态规划
const dynamicPlan = await generateDynamicPlan('修复 auth 模块中的空指针异常', agentDefs, provider, 'sonnet')

const coordinator = new Coordinator({
  maxConcurrency: 3,
  defaultModel: 'sonnet',
  provider: myProvider,
  tools: toolPool,
  agentDefinitions: agentDefs,
  onTaskStart: (task) => console.log(`Started: ${task.description}`),
  onTaskComplete: (task) => console.log(`Completed: ${task.description}`),
  onTaskFailed: (task) => console.log(`Failed: ${task.description}: ${task.error}`),
  onPlanUpdated: (plan) => console.log(`Plan updated: ${plan.tasks.length} tasks`),
})

const result = await coordinator.execute(plan)
console.log(result.synthesis)
```

## Agent Tool — 子代理调度

Agent Tool 允许一个 Agent 在运行过程中启动另一个 Agent 执行子任务。详见 [自定义 Agent - Agent Tool](custom-agent.md#agent-tool--子代理调度)。

### 调度模式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `sync` | 同步模式，等待子 Agent 完成后返回结果 | 需要立即获取结果的简单任务 |
| `async` | 异步模式，子 Agent 在后台运行 | 长时间运行的任务、并行执行 |
| `fork` | 分叉模式，子 Agent 拥有隔离上下文 | 需要独立上下文的复杂任务 |

## Task API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/tasks` | GET | 列出所有任务 |
| `/api/v1/tasks/:taskId` | GET | 获取任务详情 |
| `/api/v1/tasks/:taskId` | DELETE | 终止任务 |
| `/api/v1/tasks/notifications` | GET (SSE) | 实时任务通知流 |

## Coordinator API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/coordinate` | POST | 执行 Coordinator 编排（`dynamic: true` 启用 LLM 动态规划） |
| `/api/v1/coordinate/plan` | POST | 仅生成动态计划（不执行，可预览） |
| `/api/v1/coordinate/snapshots` | GET | 列出所有快照 |
| `/api/v1/coordinate/resume` | POST | 从快照恢复执行 |

## 相关文档

- [自定义 Agent](custom-agent.md)
- [技能系统](skills.md)
- [人机交互机制](human-interaction.md)
