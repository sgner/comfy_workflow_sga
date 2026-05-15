# 自定义 Agent

> 📄 相关源文件：`src/agents/definition.ts`（BaseAgentDefinition 类、AgentDefinition 接口）、`src/agents/runner.ts`（runAgent 函数）、`src/agents/fork.ts`（分叉执行）、`src/agents/loader.ts`（自定义 Agent 加载器）、`src/agents/coordinator.ts`（编排器）、`src/tools/built-in/agent.ts`（Agent Tool）

## 概述

SGA Template 支持三种 Agent 扩展方式：

1. **内置 Agent** — 系统预定义的 Agent（GeneralPurpose、Explore、Plan、Verification）
2. **自定义 Agent** — 通过代码或文件定义的 Agent
3. **Agent 编排** — 通过 Coordinator 模式协调多个 Agent 并行工作

## AgentDefinition 接口

```typescript
// src/agents/definition.ts
export interface AgentDefinition {
  name: string
  description: string
  subagentType: string

  getSystemPrompt(params: { toolUseContext: ToolUseContext }): string | Promise<string>
  getAllowedTools(): string[] | undefined
  getDisallowedTools(): string[]
  getModel(): ModelAlias | 'inherit' | undefined
  getEffort(): ThinkingEffort | undefined
  getPermissionMode(): PermissionMode | undefined

  isBuiltIn(): boolean
  isBackground(): boolean
  isProactive(): boolean
}
```

### 接口方法说明

| 方法 | 说明 |
|------|------|
| `name` | Agent 名称 |
| `description` | Agent 描述 |
| `subagentType` | 子 Agent 类型标识 |
| `getSystemPrompt()` | 获取系统提示词 |
| `getAllowedTools()` | 获取允许使用的工具列表（undefined 表示全部允许） |
| `getDisallowedTools()` | 获取禁止使用的工具列表 |
| `getModel()` | 获取模型覆盖（可返回 'inherit' 继承父级） |
| `getEffort()` | 获取思考力度（`low` / `medium` / `high` / `max`） |
| `getThinkingPrompt()` | 获取思考力度提示词（用于不支持原生思考的模型） |
| `getPermissionMode()` | 获取权限模式覆盖 |
| `isBuiltIn()` | 是否为内置 Agent |
| `isBackground()` | 是否为后台 Agent |
| `isProactive()` | 是否为主动 Agent |

## 内置 Agent

| Agent | 说明 | 工具权限 | 特点 |
|-------|------|----------|------|
| `general-purpose` | 通用 Agent，支持所有工具 | 全部工具 | 默认 Agent |
| `Explore` | 只读探索 Agent | Glob, Grep, Read, Bash | 快速搜索代码 |
| `Plan` | 规划 Agent | Glob, Grep, Read, Bash | 设计实现方案 |
| `verification` | 验证 Agent | Glob, Grep, Read, Bash | 后台运行，独立验证 |

## 通过代码创建自定义 Agent

### 方式一：使用 BaseAgentDefinition

```typescript
import { BaseAgentDefinition, runAgent, createBuiltinTools } from 'SGA-Template'

const codeReviewer = new BaseAgentDefinition({
  name: 'CodeReviewer',
  description: '代码审查专家',
  subagentType: 'code-reviewer',
  systemPrompt: '你是一位资深代码审查专家，专注于发现代码中的安全问题和性能瓶颈...',
  allowedTools: ['Read', 'Grep', 'Glob'],
  disallowedTools: ['Bash', 'Write', 'Edit'],
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'default',
})

const result = await runAgent({
  agentDefinition: codeReviewer,
  prompt: '请审查代码质量',
  tools: createBuiltinTools(),
  model: 'sonnet',
})
```

### 方式二：使用 createAgentFromConfig

```typescript
import { createAgentFromConfig, runAgent } from 'SGA-Template'

const agentDef = createAgentFromConfig({
  name: 'SecurityScanner',
  description: '安全扫描专家',
  prompt: '你是一位安全扫描专家，负责检测代码中的安全漏洞...',
  tools: ['Read', 'Grep', 'Glob'],
  disallowedTools: ['Write', 'Edit'],
  model: 'sonnet',
  background: true,
})

const result = await runAgent({
  agentDefinition: agentDef,
  prompt: '扫描项目中的安全漏洞',
  tools: createBuiltinTools(),
  model: 'sonnet',
})
```

### 方式三：通过 API 动态创建

```bash
POST /api/v1/agents
Content-Type: application/json

{
  "name": "SecurityScanner",
  "description": "安全扫描专家",
  "prompt": "你是一位安全扫描专家，负责检测代码中的安全漏洞...",
  "tools": ["Read", "Grep", "Glob"],
  "model": "sonnet"
}
```

## 通过文件定义 Agent

### Markdown 格式（.md）

在项目目录 `.sga/agents/` 或用户目录 `~/.sga/agents/` 下创建 `.md` 文件：

```markdown
---
name: SecurityScanner
description: 安全扫描专家
tools: Read, Grep, Glob
disallowed-tools: Write, Edit
model: sonnet
background: true
user-invocable: true
context: fork
---

你是一位安全扫描专家，负责检测代码中的安全漏洞。

## 工作流程
1. 扫描指定目录下的所有源代码文件
2. 检查常见的 OWASP Top 10 安全问题
3. 报告发现的漏洞及其严重程度
4. 提供修复建议

## 注意事项
- 不要修改任何文件
- 报告应包含文件路径和行号
```

### JSON 格式（.json）

单个 Agent 定义：

```json
{
  "name": "SecurityScanner",
  "description": "安全扫描专家",
  "prompt": "你是一位安全扫描专家，负责检测代码中的安全漏洞...",
  "tools": ["Read", "Grep", "Glob"],
  "disallowedTools": ["Write", "Edit"],
  "model": "sonnet",
  "background": true
}
```

多个 Agent 定义（放在一个文件中）：

```json
{
  "SecurityScanner": {
    "description": "安全扫描专家",
    "prompt": "你是一位安全扫描专家...",
    "tools": ["Read", "Grep", "Glob"]
  },
  "PerformanceAnalyzer": {
    "description": "性能分析专家",
    "prompt": "你是一位性能分析专家...",
    "tools": ["Read", "Grep", "Glob", "Bash"]
  }
}
```

### Frontmatter 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | Agent 名称（必填） |
| `description` | `string` | Agent 描述（必填） |
| `model` | `string` | 模型覆盖（sonnet/opus/haiku） |
| `effort` | `string` | 思考力度（low/medium/high/max），详见[思考力度策略](#思考力度策略) |
| `tools` | `string` 或 `string[]` | 允许使用的工具列表 |
| `disallowed-tools` | `string` 或 `string[]` | 禁止使用的工具列表 |
| `user-invocable` | `boolean` | 是否可被用户直接调用 |
| `context` | `'inline' \| 'fork'` | 上下文模式（默认 fork） |
| `mode` | `string` | 权限模式 |
| `background` | `boolean` | 是否为后台 Agent |
| `proactive` | `boolean` | 是否为主动 Agent |
| `mcp-servers` | `object` | 关联的 MCP 服务器配置 |

### Agent 加载路径

自定义 Agent 按以下顺序加载（后加载的同名 Agent 会覆盖先加载的）：

1. **项目级 Agent** — `<project-root>/.sga/agents/` （source: `project`）
2. **用户级 Agent** — `~/.sga/agents/` （source: `user`）
3. **API 创建的 Agent** — 通过 API 动态创建（source: `api`）

## Agent Tool — 子代理调度

> 📄 相关源文件：`src/tools/built-in/agent.ts`

Agent Tool 允许一个 Agent 在运行过程中启动另一个 Agent 执行子任务，支持三种调度模式：

### 调度模式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `sync` | 同步模式，等待子 Agent 完成后返回结果 | 需要立即获取结果的简单任务 |
| `async` | 异步模式，子 Agent 在后台运行 | 长时间运行的任务、并行执行 |
| `fork` | 分叉模式，子 Agent 拥有隔离上下文 | 需要独立上下文的复杂任务 |

### 使用方式

```typescript
// Agent Tool 作为内置工具自动注册
// 在 LLM 调用中，模型可以调用 Agent 工具：

{
  "name": "Agent",
  "input": {
    "description": "Investigate auth bug",
    "prompt": "调查 auth 模块中的空指针异常...",
    "subagent_type": "Explore",
    "mode": "sync"
  }
}

// 异步模式
{
  "name": "Agent",
  "input": {
    "description": "Run security scan",
    "prompt": "扫描所有源代码中的安全漏洞...",
    "subagent_type": "SecurityScanner",
    "run_in_background": true
  }
}

// Fork 模式
{
  "name": "Agent",
  "input": {
    "description": "Implement feature",
    "prompt": "实现 JWT 认证功能...",
    "subagent_type": "general-purpose",
    "mode": "fork"
  }
}
```

### 异步任务管理

```typescript
import { getRunningTask, getAllRunningTasks, killRunningTask, waitForTask } from 'SGA-Template'

// 获取运行中的任务
const task = getRunningTask('agent-task-1234567890-1')

// 获取所有运行中的任务
const tasks = getAllRunningTasks()

// 等待任务完成
const result = await waitForTask('agent-task-1234567890-1')

// 终止任务
killRunningTask('agent-task-1234567890-1')

// 清理已完成的任务
cleanupCompletedTasks()
```

## Agent 编排 — Coordinator 模式

> 📄 相关源文件：`src/agents/coordinator.ts`

Coordinator 模式参考 cc-haha-main 的实现，支持多 Agent 并行调度与结果汇总。

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

### 使用 Coordinator API

```bash
# 静态规划（基于模板生成计划）
POST /api/v1/coordinate
Content-Type: application/json

{
  "query": "修复 auth 模块中的空指针异常",
  "strategy": "hybrid",
  "maxConcurrency": 3,
  "model": "sonnet",
  "providerName": "openai"
}

# 动态规划（LLM 智能分析生成计划）
POST /api/v1/coordinate
Content-Type: application/json

{
  "query": "Rust 异步编程有哪些坑？",
  "strategy": "hybrid",
  "maxConcurrency": 3,
  "model": "sonnet",
  "dynamic": true
}

# 仅生成计划（不执行）
POST /api/v1/coordinate/plan
Content-Type: application/json

{
  "query": "Rust 异步编程有哪些坑？",
  "model": "sonnet"
}

# 查看所有快照
GET /api/v1/coordinate/snapshots

# 从快照恢复执行
POST /api/v1/coordinate/resume
Content-Type: application/json

{
  "snapshotPath": ".sga/snapshots/plan-1700000000-abc123.json",
  "maxConcurrency": 3,
  "model": "sonnet"
}
```

### 使用 Coordinator 代码

```typescript
import { Coordinator, createCoordinatorPlanFromUserQuery, generateDynamicPlan, getAllAgentDefinitions } from 'SGA-Template'

const agentDefs = await getAllAgentDefinitions()

// 方式一：静态规划（基于模板）
const plan = createCoordinatorPlanFromUserQuery('修复 auth 模块中的空指针异常', agentDefs)

// 方式二：动态规划（LLM 智能分析）
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

### 自定义编排计划

```typescript
import { Coordinator } from 'SGA-Template'

const plan = {
  strategy: 'hybrid',
  tasks: [
    {
      description: '调查 auth 模块',
      phase: 'research',
      agentType: 'Explore',
      prompt: '调查 src/auth/ 目录中的空指针异常问题...',
    },
    {
      description: '设计修复方案',
      phase: 'synthesis',
      agentType: 'Plan',
      prompt: '基于调查结果设计修复方案...',
      dependsOn: ['调查 auth 模块'],
    },
    {
      description: '实现修复',
      phase: 'implementation',
      agentType: 'general-purpose',
      prompt: '修复 src/auth/validate.ts 中的空指针异常...',
      dependsOn: ['设计修复方案'],
    },
    {
      description: '验证修复',
      phase: 'verification',
      agentType: 'verification',
      prompt: '验证空指针异常的修复是否正确...',
      dependsOn: ['实现修复'],
    },
  ],
}

const result = await coordinator.execute(plan)
```

### 编排策略

| 策略 | 说明 |
|------|------|
| `parallel` | 所有任务并行执行 |
| `sequential` | 所有任务串行执行 |
| `hybrid` | 按阶段执行：research/verification 可并行，implementation 串行（推荐） |

### 动态规划 — LLM 智能生成计划

> 📄 相关源文件：`src/agents/coordinator.ts` → `generateDynamicPlan()`

传统静态规划使用固定模板，根据有哪些内置 Agent 拼装步骤。动态规划则让 LLM 根据用户查询和可用 Agent 列表智能分析，生成最优执行计划。

#### 工作原理

```
用户查询："Rust 异步编程有哪些坑？"
        +
可用 Agent 列表：
  - WebResearcher (联网搜索专家)
  - ProblemSolver (问题解决专家)
  - Explore (代码探索)
  - ...
        ↓
   LLM 分析规划（PLAN_GENERATION_SYSTEM_PROMPT）
        ↓
   输出 JSON 计划：
{
  "strategy": "sequential",
  "tasks": [
    {
      "description": "联网搜集资料",
      "phase": "research",
      "agentType": "WebResearcher",
      "prompt": "搜索 Rust 异步编程常见陷阱...",
      "dependsOn": []
    },
    {
      "description": "基于资料解决问题",
      "phase": "synthesis",
      "agentType": "ProblemSolver",
      "prompt": "基于上一步搜集到的资料，回答...",
      "dependsOn": ["联网搜集资料"]
    }
  ]
}
```

#### 使用方式

```typescript
import { generateDynamicPlan, getAllAgentDefinitions } from 'SGA-Template'

const agentDefs = await getAllAgentDefinitions()

// LLM 会根据查询内容和可用 Agent 智能生成计划
const plan = await generateDynamicPlan(
  'Rust 异步编程有哪些坑？',
  agentDefs,
  provider,
  'sonnet',
)

// 如果 LLM 规划失败，会自动回退到静态规划
console.log(plan.strategy)  // 'sequential' | 'parallel' | 'hybrid'
console.log(plan.tasks)     // CoordinatorTaskStep[]
```

#### API 调用

```bash
# 仅生成计划（不执行），可预览后再决定是否执行
POST /api/v1/coordinate/plan
{ "query": "Rust 异步编程有哪些坑？" }

# 生成并执行（dynamic=true 启用 LLM 规划）
POST /api/v1/coordinate
{ "query": "Rust 异步编程有哪些坑？", "dynamic": true }
```

#### 容错机制

- LLM 返回空计划 → 自动回退到 `createCoordinatorPlanFromUserQuery()` 静态规划
- LLM 返回无效 JSON → 自动回退到静态规划
- LLM 返回无效 phase/strategy → 自动修正为默认值（`implementation` / `hybrid`）
- 网络超时或 Provider 错误 → 自动回退到静态规划

### 上下文注入 — 自动传递步骤结果

> 📄 相关源文件：`src/agents/coordinator.ts` → `injectContextFromDependencies()`

当任务声明了 `dependsOn` 依赖关系时，Coordinator 会在执行前自动将依赖步骤的结果注入到当前步骤的 prompt 前面。

#### 工作原理

```
Step 1: WebResearcher
  prompt: "搜索 Rust 异步编程常见陷阱..."
  → 返回: "### 搜索结果汇总\n1. Send/Sync trait bounds...\n2. Pinning issues..."

Step 2: ProblemSolver (dependsOn: ["联网搜集资料"])
  原始 prompt: "基于上一步搜集到的资料，回答..."
  ↓ injectContextFromDependencies 自动注入 ↓
  实际 prompt:
  """
  ## Previous Step Results

  ### 联网搜集资料 (research)
  ### 搜索结果汇总
  1. Send/Sync trait bounds...
  2. Pinning issues...

  ---

  基于上一步搜集到的资料，回答...
  """
```

#### 关键特性

- 通过 `dependsOn` 字段声明依赖（引用依赖步骤的 `description`）
- 执行前自动查找已完成的依赖步骤
- 将依赖步骤的结果（截断到 3000 字符防止过长）注入到 prompt 前面
- 如果依赖步骤未完成或未找到匹配，则只使用原始 prompt
- 断点续跑时，已完成步骤的结果同样会被注入

#### 代码示例

```typescript
const plan = {
  strategy: 'hybrid',
  tasks: [
    {
      description: '联网搜集资料',
      phase: 'research',
      agentType: 'WebResearcher',
      prompt: '搜索 Rust 异步编程常见陷阱...',
    },
    {
      description: '基于资料解决问题',
      phase: 'synthesis',
      agentType: 'ProblemSolver',
      prompt: '基于上一步搜集到的资料，回答用户问题...',
      dependsOn: ['联网搜集资料'],  // 引用上一步的 description
    },
  ],
}

// Coordinator 执行 Step 2 时会自动注入 Step 1 的结果
const result = await coordinator.execute(plan)
```

### 计划动态更新

> 📄 相关源文件：`src/agents/coordinator.ts` → `addStep()` / `skipTask()` / `updateTaskPrompt()`

Coordinator 支持在执行过程中动态修改计划，无需重新创建整个编排。

#### 添加步骤

```typescript
// 在执行中添加新步骤（例如发现需要额外安全审查）
const newTask = coordinator.addStep({
  description: '补充安全审查',
  phase: 'verification',
  agentType: 'SecurityScanner',
  prompt: '审查代码安全性，重点关注注入攻击...',
  dependsOn: ['实现功能'],
})
// 触发 onPlanUpdated 回调
```

#### 跳过步骤

```typescript
// 跳过某个不再需要的步骤
coordinator.skipTask('coord-task-1700000000-1', '该步骤不再需要')
// 只能跳过 pending 或 running 状态的任务
```

#### 修改步骤 Prompt

```typescript
// 根据中间结果调整后续步骤的 prompt
coordinator.updateTaskPrompt(
  'coord-task-1700000000-2',
  '基于最新的调查结果，重点关注 src/auth/validate.ts 第 42 行的空指针问题...',
)
// 只能修改 pending 状态的任务
```

#### 回调通知

```typescript
const coordinator = new Coordinator({
  // ...其他配置
  onPlanUpdated: (plan) => {
    console.log(`计划已更新，当前 ${plan.tasks.length} 个步骤`)
    // 可在此处持久化计划、通知前端等
  },
})
```

### 计划持久化与断点续跑

> 📄 相关源文件：`src/agents/coordinator.ts` → `saveSnapshot()` / `loadSnapshot()` / `resumeFromSnapshot()` / `listSnapshots()`

Coordinator 在执行过程中自动保存快照，支持从断点恢复执行。

#### 快照自动保存

- **每个阶段完成后** — 自动保存快照到 `.sga/snapshots/{planId}.json`
- **全部完成时** — 保存最终快照
- 快照目录可通过 `snapshotDir` 配置覆盖

#### 快照内容

```json
{
  "plan": {
    "id": "plan-1700000000-abc123",
    "query": "修复 auth 模块中的空指针异常",
    "strategy": "hybrid",
    "tasks": [
      { "id": "step-1", "description": "Research the codebase", "phase": "research", ... },
      { "id": "step-2", "description": "Design implementation plan", "phase": "synthesis", ... }
    ]
  },
  "tasks": [
    { "id": "coord-task-xxx-1", "status": "completed", "result": { "content": "...", "durationMs": 5000, "turnCount": 3, "toolUseCount": 5 } },
    { "id": "coord-task-xxx-2", "status": "completed", "result": { "content": "...", "durationMs": 8000, "turnCount": 4, "toolUseCount": 7 } },
    { "id": "coord-task-xxx-3", "status": "pending" },
    { "id": "coord-task-xxx-4", "status": "pending" }
  ],
  "totalUsage": { "inputTokens": 10000, "outputTokens": 5000, "totalTokens": 15000, "totalCostUsd": 0.075 },
  "startedAt": 1700000000000,
  "savedAt": 1700000013000
}
```

#### 从快照恢复

```typescript
import { Coordinator, listSnapshots } from 'SGA-Template'

// 查看所有可用快照
const snapshots = listSnapshots()
// [
//   { planId: 'plan-xxx', query: '修复 auth...', savedAt: 1700000013000, pendingCount: 2, path: '.sga/snapshots/plan-xxx.json' }
// ]

// 从快照恢复执行
const coordinator = new Coordinator({
  maxConcurrency: 3,
  defaultModel: 'sonnet',
  provider,
  tools: toolPool,
  agentDefinitions: agentDefs,
})

const result = await coordinator.resumeFromSnapshot('.sga/snapshots/plan-xxx.json')
// 恢复过程：
// 1. 加载快照，还原所有任务状态
// 2. 跳过已完成的任务 (status === 'completed')
// 3. 从第一个 pending 任务继续执行
// 4. 上下文注入仍然有效（已完成的结果会被注入到依赖步骤）
// 5. 执行完成后保存最终快照
```

#### API 调用

```bash
# 查看所有快照
GET /api/v1/coordinate/snapshots
# 响应: { "snapshots": [{ "planId": "plan-xxx", "query": "...", "savedAt": ..., "pendingCount": 2, "path": "..." }] }

# 从快照恢复执行
POST /api/v1/coordinate/resume
{ "snapshotPath": ".sga/snapshots/plan-xxx.json" }
```

#### 断点续跑的上下文注入

恢复执行时，`injectContextFromDependencies` 仍然有效：

```
快照中 Step 1 已完成 → result.content 保存了搜索结果
快照中 Step 2 待执行 → dependsOn: ["联网搜集资料"]

恢复执行 Step 2 时：
  → 找到 Step 1 的 result（从快照恢复的）
  → 自动注入到 Step 2 的 prompt 前面
  → ProblemSolver 仍然能看到搜索结果
```

### CoordinatorConfig 完整配置

```typescript
interface CoordinatorConfig {
  maxConcurrency: number              // 最大并发数
  defaultModel: string                // 默认模型
  provider: LLMProvider               // LLM Provider
  tools: Tool[]                       // 工具池
  agentDefinitions: AgentDefinition[] // 可用 Agent 列表
  maxTurnsPerAgent?: number           // 每个 Agent 最大轮次
  snapshotDir?: string                // 快照保存目录（默认 .sga/snapshots）
  onTaskStart?: (task: CoordinatorTask) => void
  onTaskComplete?: (task: CoordinatorTask) => void
  onTaskFailed?: (task: CoordinatorTask) => void
  onPlanUpdated?: (plan: CoordinatorPlan) => void
}
```

## 子 Agent 分叉执行

> 📄 相关源文件：`src/agents/fork.ts`

在 Agent 运行过程中，可以通过分叉（fork）机制启动子 Agent 执行子任务：

```typescript
import { createSubagentContext, FORK_BOILERPLATE } from 'SGA-Template'

const forkedContext = createSubagentContext(parentContext, {
  tools: filteredTools,
  agentId: `fork-${Date.now()}`,
  agentType: 'Explore',
})
```

分叉执行的特点：
- 子 Agent 拥有独立的消息历史和上下文
- 子 Agent 的工具列表可以与父 Agent 不同
- 子 Agent 执行完成后，结果返回给父 Agent
- 支持嵌套分叉（子 Agent 可以再分叉）

## Agent 执行引擎

> 📄 相关源文件：`src/agents/runner.ts`

`runAgent` 是 Agent 的核心执行引擎，其内部流程如下：

1. **解析模型** — 根据 Agent 定义和参数确定使用的模型
2. **过滤工具** — 根据 Agent 的 `getAllowedTools()` / `getDisallowedTools()` 过滤工具
3. **构建系统提示词** — 调用 `agentDefinition.getSystemPrompt()`，注入记忆上下文
4. **初始化消息** — 将用户 prompt 添加到消息历史
5. **执行 Agent 循环** — 反复调用 LLM 和工具，直到结束条件满足
6. **返回结果** — 提取最终回复文本和统计信息

## API 参考

### Agent 相关 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/agents` | GET | 列出所有 Agent（内置 + 自定义） |
| `/api/v1/agents` | POST | 动态创建自定义 Agent |
| `/api/v1/coordinate` | POST | 执行 Coordinator 编排（支持 `dynamic: true` 启用 LLM 动态规划） |
| `/api/v1/coordinate/plan` | POST | 仅生成动态计划（不执行） |
| `/api/v1/coordinate/snapshots` | GET | 列出所有快照 |
| `/api/v1/coordinate/resume` | POST | 从快照恢复执行 |

### Task 相关 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/tasks` | GET | 列出所有任务 |
| `/api/v1/tasks/:taskId` | GET | 获取任务详情 |
| `/api/v1/tasks/:taskId` | DELETE | 终止任务 |
| `/api/v1/tasks/notifications` | GET (SSE) | 实时任务通知流 |

## 相关文档

- [任务与团队协作](tasks-teams.md)
- [自定义工具](custom-tools.md)
- [自定义系统提示词](custom-prompt.md)
- [权限控制](permissions.md)
- [MCP 集成](mcp-integration.md)

## 思考力度策略

> 📄 相关源文件：`src/agents/thinking-prompts.ts`（策略解析与提示词模板）、`src/agents/runner.ts`（运行时注入）、`src/config.ts`（环境变量加载）

### 概述

思考力度（Thinking Effort）控制 Agent 在回答前的推理深度。SGA 通过**自动策略适配**，让所有模型都能获得思考力度控制，无论模型是否原生支持。

### 三种策略

```
Agent.getEffort()
    │
    ▼
检查模型能力 (ModelConfig)
    │
    ├── supportsThinking = true
    │   → 原生思考（Anthropic Claude）
    │   → API 参数: thinking: { budget_tokens: n }
    │
    ├── supportsReasoningEffort = true
    │   → 原生推理力度（OpenAI o1/o3）
    │   → API 参数: reasoning_effort: 'low' | 'medium' | 'high'
    │
    └── 两者都不支持
        → 提示词注入（GPT-4o、DeepSeek 等）
        → 系统提示词追加思考引导 / Chain-of-Thought
```

### 模型支持矩阵

| 模型 | 原生思考 | 原因推理力度 | 提示词注入 |
|------|---------|------------|-----------|
| Claude Sonnet 4 | ✅ `budget_tokens` | — | — |
| Claude Opus 4 | ✅ `budget_tokens` | — | — |
| Claude Haiku 4 | — | — | ✅ 提示词 |
| OpenAI o1 | — | ✅ `reasoning_effort` | — |
| OpenAI o1-mini | — | ✅ `reasoning_effort` | — |
| OpenAI o3-mini | — | ✅ `reasoning_effort` | — |
| GPT-4o | — | — | ✅ 提示词 |
| DeepSeek Chat | — | — | ✅ 提示词 |

### 思考力度级别

| 级别 | 说明 | 原生思考预算 | 推理力度 | 提示词效果 |
|------|------|------------|---------|-----------|
| `low` | 快速响应 | 2,000 tokens | `low` | 简洁直接 |
| `medium` | 平衡模式（默认） | 10,000 tokens | `medium` | 适度思考 |
| `high` | 深度分析 | 20,000 tokens | `high` | 系统分析 + CoT |
| `max` | 最详细推理 | 32,000 tokens | `high` | 深度推理 + CoT |

### 在 Agent 定义中使用

```typescript
// 代码定义
const agent = new BaseAgentDefinition({
  name: 'code-analyzer',
  description: '深度代码分析',
  effort: 'high',  // 设置思考力度
  // ...
})
```

```markdown
<!-- 文件定义 .md -->
---
name: code-analyzer
description: 深度代码分析
effort: high
---
```

### 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SGA_THINKING_EFFORT_DEFAULT` | `medium` | 默认思考力度 |
| `SGA_THINKING_EFFORT_BUDGET_LOW` | `2000` | low 级别的原生思考 token 预算 |
| `SGA_THINKING_EFFORT_BUDGET_MEDIUM` | `10000` | medium 级别的原生思考 token 预算 |
| `SGA_THINKING_EFFORT_BUDGET_HIGH` | `20000` | high 级别的原生思考 token 预算 |
| `SGA_THINKING_EFFORT_BUDGET_MAX` | `32000` | max 级别的原生思考 token 预算 |
| `SGA_THINKING_EFFORT_PROMPT_INJECTION` | `true` | 是否启用提示词注入模拟 |
| `SGA_THINKING_EFFORT_COT` | `true` | 是否使用 Chain-of-Thought 格式 |
