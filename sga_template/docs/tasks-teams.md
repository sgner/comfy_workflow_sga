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

### Coordinator Agent 模式

> 📄 相关源文件：`src/agents/coordinator-mode.ts`（CoordinatorAgent 类）、`src/agents/plan-manager.ts`（PlanManager）、`src/tools/built-in/plan.ts`（PlanTool）

Coordinator 已从独立类重构为 Agent 模式，通过系统提示 + 工具驱动实现多 Agent 编排。当检测到复杂任务时，系统自动路由到 Coordinator Agent。

### 自动路由机制

系统通过任务复杂度检测自动决定是否使用 Coordinator：

| 检测标准 | 阈值 | 示例 |
|---------|------|------|
| 关键词匹配 | 包含"实现"、"重构"、"修复并测试"等 | "实现用户认证功能" |
| 句子数量 | ≥ 3 句 | "调查问题。分析原因。修复代码。" |
| 动作数量 | ≥ 2 个"and/然后"连接 | "搜索代码然后修复 bug" |

### 编排流程

```
用户查询 → 复杂度检测 → Coordinator Agent → Plan(create) → Agent(spawn workers) → 通知注入 → Plan(update) → 综合结果
```

### Coordinator 工具集

| 工具 | 说明 |
|------|------|
| **Plan** | 创建/更新/查询结构化计划，管理任务依赖和状态 |
| **Agent** | 启动子 Agent（sync/async/fork 三种模式） |
| **SendMessage** | 向运行中的 Worker 发送消息 |
| **TaskStop** | 停止运行中的 Worker |

### 结构化计划（PlanManager）

Coordinator 在启动任何 Worker 之前必须先创建计划：

```typescript
// Plan 工具调用示例
Plan({
  action: "create",
  query: "修复 auth 模块中的空指针异常",
  strategy: "hybrid",
  tasks: [
    { description: "调查 auth 模块", phase: "research", agentType: "Explore", prompt: "..." },
    { description: "设计修复方案", phase: "synthesis", agentType: "Plan", prompt: "...", dependsOn: ["调查 auth 模块"] },
    { description: "实现修复", phase: "implementation", agentType: "general-purpose", prompt: "...", dependsOn: ["设计修复方案"] },
    { description: "验证修复", phase: "verification", agentType: "verification", prompt: "...", dependsOn: ["实现修复"] },
  ]
})
```

PlanManager 核心方法：

| 方法 | 说明 |
|------|------|
| `createPlan(query, steps, strategy)` | 创建结构化计划 |
| `updateTaskStatus(taskId, status, result?)` | 更新任务状态 |
| `getReadyTasks()` | 获取依赖已满足的可执行任务 |
| `canLaunchMore()` | 检查是否还能启动更多 Worker |
| `getProgress()` | 获取计划进度（完成/运行/待执行数量） |
| `saveSnapshot()` | 持久化计划到 `.sga/snapshots/` |
| `formatPlanSummary()` | 生成人类可读的计划摘要 |

### 任务通知注入

异步 Worker 完成后，任务通知自动注入回 Coordinator 的消息流：

1. Worker 完成 → `emitTaskNotification()` → 加入 `pendingNotifications` 队列
2. `runner.ts` 每轮循环开始时 → `drainPendingNotifications()` → 格式化为 XML
3. 注入为 `user` 角色消息 → Coordinator LLM 在下一轮看到通知
4. Coordinator 调用 `Plan({ action: "update" })` 更新任务状态

### 并发控制

系统限制同时运行的 Worker 数量，防止资源耗尽：

| 机制 | 说明 |
|------|------|
| `MAX_CONCURRENT_WORKERS` | 最大并发数 = 5 |
| 超限拒绝 | async spawn 时检查运行数，超限返回错误信息 |
| `Plan({ action: "status" })` | Coordinator 可查看当前运行数和是否可启动更多 |

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

Coordinator Agent 通过系统提示引导 LLM 自主决定任务分解和 Agent 调度，无需预定义模板。LLM 根据查询内容和可用 Agent 列表智能生成最优计划。

```typescript
import { getAllAgentDefinitions } from 'SGA-Template'

// Coordinator Agent 由系统自动路由
// 当检测到复杂任务时，routes.ts 自动调用 CoordinatorAgent
// LLM 自主分析查询，生成计划，调度 Agent
```

### 上下文注入

当任务声明了 `dependsOn` 依赖关系时，Coordinator 会自动将依赖步骤的结果注入到当前步骤的 prompt 前面，确保后续 Agent 能看到前一步的输出。

### 计划持久化与断点续跑

PlanManager 在执行过程中自动保存快照到 `.sga/snapshots/`，支持从断点恢复执行：

```typescript
import { getPlanManager, listSnapshots } from 'SGA-Template'

const planManager = getPlanManager()

// 保存快照
const snapshotPath = planManager.saveSnapshot()

// 查看所有快照
const snapshots = listSnapshots()

// 从快照恢复
const plan = planManager.loadSnapshot(snapshotPath)
```

### 使用示例

```typescript
// Coordinator Agent 由系统自动路由，无需手动调用
// 当用户发送复杂任务时，routes.ts 自动检测并路由到 Coordinator

// 也可以通过 API 直接触发
POST /api/v1/sessions/:sessionId/message
{
  "content": "实现用户认证功能并编写测试",
  "agentType": "coordinator"
}
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
| `/api/v1/sessions/:id/message` | POST | 发送消息（自动检测复杂度，复杂任务路由到 Coordinator） |
| `/api/v1/sessions/:id/stream` | POST (SSE) | 流式发送消息（同上，支持实时事件推送） |
| `/api/v1/coordinate/snapshots` | GET | 列出所有快照 |

## 相关文档

- [自定义 Agent](custom-agent.md)
- [技能系统](skills.md)
- [人机交互机制](human-interaction.md)
