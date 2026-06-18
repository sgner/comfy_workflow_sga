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
| `Explore` | 只读探索 Agent | Glob, Grep, Read, Bash | 并行搜索策略，广度优先 → 深度追踪 |
| `Plan` | 规划 Agent | Glob, Grep, Read, Bash | 结构化计划格式，PLAN_COMPLETE 退出信号 |
| `verification` | 验证 Agent | Glob, Grep, Read, Bash, WebFetch | 10 种验证策略，对抗性验证，PASS/FAIL 判定 |
| `advisor` | 顾问 Agent | Glob, Grep, Read | 批判性审查，反思与改进建议 |

### Verification Agent — 对抗性验证

Verification Agent 采用对抗性验证策略，其核心原则是"尝试破坏实现"而非"确认实现正确"。

#### 10 种验证策略

| 策略 | 适用场景 | 关键动作 |
|------|---------|---------|
| 前端验证 | UI 变更 | 启动 dev server → 浏览器自动化 → curl 子资源 → 前端测试 |
| 后端/API 验证 | API 变更 | 启动 server → curl 端点 → 验证响应结构 → 测试错误处理 |
| CLI/脚本验证 | 命令行工具 | 运行代表性输入 → 验证 stdout/stderr/exit code → 边界输入 |
| 基础设施验证 | 配置变更 | 语法验证 → dry-run → 检查环境变量引用 |
| 库/包验证 | 库变更 | 构建 → 完整测试 → 从新上下文导入并测试公共 API |
| 移动端验证 | iOS/Android | 清理构建 → 安装模拟器 → dump UI tree → 截图验证 |
| 数据/ML 验证 | 数据管道 | 样本输入运行 → 验证输出 schema → 空输入/NaN 处理 |
| 数据库迁移验证 | Schema 变更 | 运行 migration up → 验证 schema → 运行 migration down |
| 重构验证 | 无行为变更 | 现有测试必须通过 → diff 公共 API → 行为一致性检查 |
| 通用验证 | 其他 | 运行/调用 → 检查输出 → 尝试破坏 |

#### PASS/FAIL 前置检查

**PASS 前置检查**：报告必须包含至少一个对抗性探测（并发/边界值/幂等性/孤儿操作），否则报告被拒绝。

**FAIL 前置检查**：在报告 FAIL 前，检查是否已有防御代码、是否为故意设计、是否为不可修复的限制。

#### 输出格式

每个检查必须遵循以下格式：

```
### Check: [验证内容]
**Command run:**
  [执行的命令]
**Output observed:**
  [实际终端输出]
**Result: PASS** (或 FAIL — 含 Expected vs Actual)
```

最终输出必须以以下行结尾（被调用方解析）：

```
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL
```

### Explore Agent — 并行搜索

Explore Agent 使用并行搜索策略，提高代码探索效率：

1. **Broad scan** — 广度扫描，快速定位相关文件
2. **Targeted deep dive** — 深度追踪，详细阅读关键文件
3. **Follow the graph** — 跟踪依赖关系，发现关联模块

### Plan Agent — 结构化规划

Plan Agent 使用结构化计划格式：

1. 分析任务需求
2. 读取 CLAUDE.md / SGA.md 获取项目约定
3. 生成结构化计划（含步骤、依赖、预期结果）
4. 通过 `PLAN_COMPLETE` 信号退出规划模式

### Advisor Agent — 顾问反思

Advisor Agent 在任务执行过程中提供批判性审查：

- 对当前方案进行独立评估
- 指出潜在问题和风险
- 建议改进方向和替代方案
- 防止 Agent 陷入局部最优

> Advisor Agent 通过 Feature Gate `advisor_agent` 控制启用/禁用，详见 [Feature Gate 特性开关](feature-gate.md)。

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

## Agent 编排 — Coordinator Agent 模式

> 📄 相关源文件：`src/agents/coordinator-mode.ts`（CoordinatorAgent 类）、`src/agents/plan-manager.ts`（PlanManager）、`src/tools/built-in/plan.ts`（PlanTool）

Coordinator 已从独立类重构为 Agent 模式，通过系统提示 + 工具驱动实现多 Agent 编排。当检测到复杂任务时，系统自动路由到 Coordinator Agent。

### 架构变更

| 旧架构 | 新架构 |
|--------|--------|
| `Coordinator` 独立类 | `CoordinatorAgent` Agent 模式 |
| 代码驱动编排 | 系统提示 + 工具驱动编排 |
| `coordinator.execute(plan)` | `runAgent({ agentDefinition: coordinatorDef })` |
| 静态/动态规划函数 | LLM 自主规划（Plan 工具） |
| 回调通知 | 任务通知注入消息流 |

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

Coordinator 在启动任何 Worker 之前必须先创建计划。PlanManager 提供以下能力：

- `createPlan(query, steps, strategy)` — 创建结构化计划
- `updateTaskStatus(taskId, status, result?)` — 更新任务状态
- `getReadyTasks()` — 获取依赖已满足的可执行任务
- `canLaunchMore()` — 检查是否还能启动更多 Worker（maxConcurrency = 5）
- `getProgress()` — 获取计划进度
- `saveSnapshot()` / `loadSnapshot()` — 持久化到 `.sga/snapshots/`

### 任务通知注入

异步 Worker 完成后，任务通知自动注入回 Coordinator 的消息流：

1. Worker 完成 → `emitTaskNotification()` → 加入 `pendingNotifications` 队列
2. `runner.ts` 每轮循环开始时 → `drainPendingNotifications()` → 格式化为 XML
3. 注入为 `user` 角色消息 → Coordinator LLM 在下一轮看到通知
4. Coordinator 调用 `Plan({ action: "update" })` 更新任务状态

### 并发控制

系统限制同时运行的 Worker 数量（`MAX_CONCURRENT_WORKERS = 5`），超限时 async spawn 返回错误信息。

### 使用方式

Coordinator Agent 由系统自动路由，无需手动调用：

```typescript
// 当用户发送复杂任务时，routes.ts 自动检测并路由到 Coordinator
// 也可以通过 API 指定 agentType
POST /api/v1/sessions/:sessionId/message
{
  "content": "实现用户认证功能并编写测试",
  "agentType": "coordinator"
}
```

### 编排策略

| 策略 | 说明 |
|------|------|
| `parallel` | 所有任务并行执行 |
| `sequential` | 所有任务串行执行 |
| `hybrid` | 按阶段执行：research/verification 可并行，implementation 串行（推荐） |

### 动态规划 — LLM 自主生成计划

Coordinator Agent 通过系统提示引导 LLM 自主决定任务分解和 Agent 调度。LLM 根据查询内容和可用 Agent 列表，使用 Plan 工具智能生成最优计划。

#### 工作原理

```
用户查询："Rust 异步编程有哪些坑？"
        +
可用 Agent 列表
        ↓
   Coordinator Agent 分析规划（系统提示引导）
        ↓
   Plan({ action: "create", query, tasks, strategy })
        ↓
   Agent(spawn) 启动 Worker 执行
```

#### 容错机制

- LLM 未调用 Plan 工具 → 系统提示强制要求先创建计划
- Worker 失败 → task-notification 注入消息流，Coordinator 可重试或跳过
- 超出并发限制 → Agent Tool 返回错误，Coordinator 等待后重试

### 上下文注入 — 自动传递步骤结果

当任务声明了 `dependsOn` 依赖关系时，Coordinator 会自动将依赖步骤的结果注入到当前步骤的 prompt 前面。

#### 工作原理

```
Step 1: Explore Worker
  prompt: "调查 auth 模块..."
  → task-notification: <result>调查结果...</result>

Step 2: Plan Worker (dependsOn: ["调查 auth 模块"])
  原始 prompt: "基于调查结果设计修复方案..."
  ↓ PlanManager 自动注入依赖结果 ↓
  实际 prompt:
  """
  ## Previous Step Results
  调查结果...
  ---
  基于调查结果设计修复方案...
  """
```

### 计划动态更新

Coordinator 通过 Plan 工具在执行过程中动态修改计划：

```typescript
// 添加新任务
Plan({ action: "add_task", task: { description: "补充安全审查", phase: "verification", agentType: "verification", prompt: "..." } })

// 移除任务
Plan({ action: "remove_task", taskId: "task-xxx" })

// 更新任务状态
Plan({ action: "update", taskId: "task-xxx", status: "completed", result: "审查完成" })

// 查看计划状态
Plan({ action: "status" })
```

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
| `/api/v1/sessions/:id/message` | POST | 发送消息（自动检测复杂度，复杂任务路由到 Coordinator） |
| `/api/v1/sessions/:id/stream` | POST (SSE) | 流式发送消息（同上，支持实时事件推送） |
| `/api/v1/coordinate/snapshots` | GET | 列出所有快照 |

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
