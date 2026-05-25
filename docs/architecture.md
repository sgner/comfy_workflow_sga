# 项目架构

> 📄 相关源文件：`src/` 目录下所有模块

## 整体结构

SGA-Template 采用分层模块化架构，各模块职责清晰、松耦合，可独立使用或组合使用。

```
src/
├── core/           # 核心类型与状态机
│   ├── types.ts        # Message, UsageMetrics, PermissionMode 等基础类型
│   ├── state.ts        # Agent 状态机（创建与转移）
│   └── agent.ts        # 核心 Agent 查询入口
├── agents/         # Agent 定义与运行
│   ├── definition.ts   # AgentDefinition 接口、BaseAgentDefinition 基类
│   ├── runner.ts       # Agent 执行引擎（runAgent，含任务通知注入）
│   ├── coordinator-mode.ts  # Coordinator Agent 模式（系统提示 + 工具驱动）
│   ├── plan-manager.ts     # PlanManager 结构化计划管理器
│   ├── thinking-prompts.ts  # 思考力度策略解析与提示词模板
│   ├── fork.ts         # 子 Agent 分叉执行
│   └── built-in/       # 内置 Agent 定义
├── tools/          # 工具系统
│   ├── base.ts         # Tool 接口、BaseTool 基类
│   ├── registry.ts     # ToolRegistry 工具注册中心
│   ├── execution.ts    # 工具执行管线与编排
│   └── built-in/       # 内置工具
├── api/            # LLM API 客户端
│   ├── client.ts       # APIClient（支持流式/非流式）
│   └── types.ts        # API 请求/响应类型
├── providers/      # 多供应商 LLM 接入
│   ├── types.ts        # Provider 统一接口定义
│   ├── anthropic.ts    # Anthropic 供应商实现
│   ├── openai.ts       # OpenAI 兼容供应商实现
│   ├── registry.ts     # 供应商注册中心与工厂
│   └── index.ts        # 统一导出
├── context/        # 上下文管理
│   ├── system-prompt.ts # 系统提示词构建
│   ├── compression.ts   # 上下文压缩
│   └── claudemd.ts      # SGA.md / CLAUDE.md 加载（SGA 优先，CLAUDE 兼容）
├── memory/         # 记忆系统
│   ├── types.ts        # 记忆类型定义与常量
│   ├── paths.ts        # 记忆文件路径管理（三级优先级 + 安全校验）
│   ├── scanner.ts      # 记忆文件扫描与 frontmatter 解析
│   ├── retrieval.ts    # 智能检索（LLM 选择 + 关键词兜底）
│   ├── prompt.ts       # 记忆提示词构建与提取提示词
│   ├── manager.ts      # MemoryManager 核心管理器（初始化/缓存/检索/持久化）
│   ├── extractor.ts    # MemoryExtractor 自动记忆提取（后台 LLM 提取）
│   ├── context-budget.ts   # 上下文预算管理（Token 分配 + 溢出控制）
│   ├── working-set.ts      # 工作集/锚点（长内容锚定 + 淡出/摘要）
│   ├── context-builder.ts  # 上下文构建器（预算分配 + 优先级排序）
│   ├── dedup.ts            # 记忆去重与压缩（哈希/描述/Jaccard）
│   ├── team-memory-sync.ts # 团队记忆同步（Pull/Push + 冲突解决）
│   ├── storage/            # 存储后端抽象层
│   │   ├── types.ts            # 存储后端接口定义
│   │   ├── registry.ts         # 后端注册与工厂
│   │   ├── filesystem.ts       # 文件系统后端（默认）
│   │   ├── vector.ts           # 向量数据库后端
│   │   ├── sql.ts              # SQL 数据库后端
│   │   └── mongodb.ts          # MongoDB 后端
│   ├── compact/            # 三级上下文压缩
│   │   ├── index.ts            # AutoCompactor 自动压缩调度
│   │   ├── micro-compact.ts    # Level 1: 微压缩（清除旧工具输出）
│   │   ├── session-memory-compact.ts  # Level 2: 会话记忆压缩
│   │   ├── full-compact.ts     # Level 3: 全量压缩（LLM 摘要）
│   │   ├── post-compact-restore.ts  # 压缩后状态恢复
│   │   └── tool-summary.ts     # 工具调用摘要
│   ├── consolidation/      # 记忆整合
│   │   ├── auto-dream.ts       # AutoDream 整合调度（三重门控）
│   │   ├── consolidation-lock.ts  # 分布式锁
│   │   └── consolidation-prompt.ts  # 整合提示词
│   └── index.ts        # 统一导出
├── skills/         # 技能系统
│   ├── types.ts             # 技能类型定义
│   ├── discovery.ts         # 技能发现（从目录扫描）
│   ├── activation.ts        # 技能激活
│   ├── bundled-registry.ts  # 技能注册中心
│   └── bundled/             # 内置技能
├── permissions/    # 权限系统
│   ├── checker.ts      # PermissionChecker 权限检查器（规则匹配 + 分类器 + 模式兜底）
│   ├── classifier.ts   # DefaultPermissionClassifier 权限分类器（置信度决策 + Bash 命令细粒度分类 + 错误分类）
│   └── rules.ts        # 权限规则持久化（.sga/permissions.json 读写）
├── hooks/          # Hook 钩子系统
│   ├── types.ts        # Hook 事件类型（11 种 HookEventType，含 PostToolUseFailure / Cancel）
│   ├── executor.ts     # HookRegistry 注册中心 + HookExecutor 执行器（含 failure/cancel 专用方法）
│   └── config.ts       # Hook 配置持久化（.sga/hooks.json 读写 + 版本迁移）
├── feature-gate/   # Feature Gate 特性开关
│   └── index.ts        # FeatureGateManager（13 个内置开关 + 环境变量覆盖 + 运行时覆盖）
├── telemetry/      # 遥测框架
│   └── index.ts        # TelemetryManager（事件队列 + 批量导出 + 自动刷新 + 专用跟踪方法）
├── mcp/            # MCP 协议集成
│   ├── types.ts        # MCP 类型定义
│   ├── client.ts       # MCPClient 完整客户端（JSON-RPC 2.0）
│   ├── manager.ts      # MCP 服务器管理器（生命周期管理）
│   ├── adapter.ts      # MCPToolAdapter 工具适配器（MCPTool → Tool）
│   └── index.ts        # 统一导出
├── tasks/          # 任务系统
│   └── manager.ts      # TaskManager 任务管理
├── teams/          # 团队协作
│   ├── types.ts        # 团队类型定义
│   └── mailbox.ts      # 团队消息邮箱
├── server/         # HTTP 服务层
│   ├── app.ts                # Express 应用创建与路由注册（含 MemoryManager 初始化）
│   ├── routes.ts             # 核心 REST API 路由（含记忆提取触发）
│   ├── session.ts            # 会话类型定义
│   ├── session-store.ts      # SessionStore 会话持久化（JSONL 追加写入 + 自动迁移）
│   ├── interaction.ts        # 人机交互类型定义
│   ├── skills-mcp-routes.ts  # Skills 与 MCP 管理 API
│   ├── main.ts               # 服务启动入口（含优雅关闭）
│   └── index.ts              # 服务层统一导出
├── utils/          # 工具函数
│   ├── helpers.ts      # 通用工具函数
│   ├── logger.ts       # 日志系统
│   ├── cost-tracker.ts # 成本追踪
│   └── circuit-breaker.ts  # 熔断器（压缩/整合故障保护）
├── config.ts       # 统一配置模块（从 .env 加载所有 SGA_ 前缀环境变量）
```

## Agent 调度与对抗性验证架构

### Coordinator Agent 模式

Coordinator 从独立类重构为 Agent 模式，通过系统提示 + 工具驱动实现多 Agent 编排：

```
用户复杂任务
    │
    ▼
┌─────────────────────────────────────────┐
│ 任务复杂度检测（routes.ts）              │
│ ├─ 关键词匹配（"实现"、"重构"等）        │
│ ├─ 句子数量 ≥ 3                         │
│ └─ 动作数量 ≥ 2（and/然后连接）          │
│                                         │
│ 复杂 → 自动路由到 Coordinator Agent      │
│ 简单 → 直接调用 GeneralPurpose Agent     │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ Coordinator Agent                       │
│ （系统提示引导 LLM 自主决策）            │
│                                         │
│ 工具集：                                │
│ ├─ Plan — 创建/更新/查询结构化计划       │
│ ├─ Agent — 启动子 Agent（sync/async/fork）│
│ ├─ SendMessage — 向运行中 Agent 发消息   │
│ └─ TaskStop — 停止运行中 Agent           │
│                                         │
│ 工作流：                                │
│ 1. Plan(create) — 创建结构化计划         │
│ 2. Agent(spawn) — 启动 Worker 执行任务   │
│ 3. 接收 task-notification — 注入消息流   │
│ 4. Plan(update) — 更新任务状态           │
│ 5. 综合结果，输出最终回答                │
└──────────────────┬──────────────────────┘
                   │
    ┌──────────────┼──────────────┐
    ▼              ▼              ▼
┌────────┐  ┌────────┐  ┌──────────────┐
│Explore │  │  Plan  │  │GeneralPurpose│
│只读探索 │  │ 规划方案│  │  通用实现     │
└────────┘  └────────┘  └──────────────┘
    │              │              │
    └──────────────┼──────────────┘
                   ▼
         ┌──────────────────┐
         │   Verification   │
         │   对抗性验证      │
         │  10 种验证策略    │
         │  PASS/FAIL 判定  │
         └──────────────────┘
                   │
                   ▼
         ┌──────────────────┐
         │    Advisor       │
         │   顾问反思       │
         │  关键性审查       │
         └──────────────────┘
```

### 结构化计划管理（PlanManager）

PlanManager 为 Coordinator 提供结构化的计划创建、更新和持久化能力：

```
Coordinator Agent
    │
    ▼
Plan({ action: "create", query, tasks, strategy })
    │
    ▼
┌─────────────────────────────────────────┐
│ PlanManager                             │
│ ├─ createPlan() — 创建计划              │
│ ├─ updateTaskStatus() — 更新任务状态    │
│ ├─ getReadyTasks() — 获取可执行任务     │
│ │   └─ 依赖检查：dependsOn 全部完成     │
│ ├─ canLaunchMore() — 并发控制           │
│ │   └─ maxConcurrency = 5              │
│ ├─ getProgress() — 获取进度             │
│ ├─ saveSnapshot() — 持久化到 .sga/      │
│ └─ formatPlanSummary() — 格式化摘要    │
└─────────────────────────────────────────┘
```

### 任务通知注入

异步 Worker 完成后，任务通知自动注入回 Coordinator 的消息流：

```
Worker (async) 完成任务
    │
    ▼
emitTaskNotification() → pendingNotifications 队列
    │
    ▼
runner.ts 每轮循环开始时
    │
    ▼
drainPendingNotifications() → 格式化为 XML
    │
    ▼
注入为 user 角色消息到 Coordinator 对话
    │
    ▼
Coordinator LLM 在下一轮看到通知，更新计划
```

### 并发控制

Agent Tool 限制同时运行的 Worker 数量，防止资源耗尽：

| 机制 | 说明 |
|------|------|
| MAX_CONCURRENT_WORKERS | 最大并发数 = 5 |
| 超限拒绝 | async spawn 时检查运行数，超限返回错误 |
| Plan status | Coordinator 可通过 Plan({ action: "status" }) 查看运行数 |

### 对抗性验证机制

Verification Agent 采用对抗性验证策略，其核心原则是"尝试破坏实现"而非"确认实现正确"：

| 特性 | 说明 |
|------|------|
| 10 种验证策略 | 前端/后端/CLI/基础设施/库/移动端/数据管道/数据库迁移/重构/通用 |
| PASS 前置检查 | 必须包含至少一个对抗性探测（并发/边界值/幂等性/孤儿操作） |
| FAIL 前置检查 | 检查是否已有防御代码、是否为故意设计、是否为不可修复限制 |
| 输出格式强制 | 每个检查必须包含 Command run + Output observed + Result |
| VERDICT 判定 | PASS / FAIL / PARTIAL（仅环境限制） |

### 反思与重试机制

Agent Runner 内置了多层反思与重试机制：

```
工具执行失败
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. PostToolUseFailure Hook              │
│    HookExecutor.executeFailureHooks()   │
│    ├─ Hook 可提供 additionalContext     │
│    └─ Hook 可提供替代方案建议            │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 2. 工具重试（Feature Gate 控制）         │
│    isFeatureEnabled('tool_retry')       │
│    ├─ 可重试错误：network/timeout/...   │
│    ├─ 指数退避：1s → 2s → 4s           │
│    └─ 最大重试次数：3                    │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 3. 连续失败转向（Feature Gate 控制）     │
│    isFeatureEnabled('consecutive_       │
│    failure_pivot')                      │
│    ├─ 连续 N 次失败后触发               │
│    └─ 自动切换策略/请求用户指导          │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 4. Advisor Agent 顾问反思               │
│    isFeatureEnabled('advisor_agent')    │
│    ├─ 对当前方案进行批判性审查           │
│    ├─ 指出潜在问题和改进方向             │
│    └─ 建议替代方案                       │
└─────────────────────────────────────────┘
```

### Feature Gate 特性开关

Feature Gate 控制各项高级能力的启用/禁用，支持三种配置方式：

| 配置方式 | 优先级 | 示例 |
|---------|--------|------|
| 运行时覆盖 | 最高 | `FeatureGateManager.getInstance().override('tool_retry', true)` |
| 环境变量 | 中 | `SGA_FEATURE_TOOL_RETRY=true` |
| 默认值 | 最低 | 代码中定义的 `defaultEnabled` |

内置开关列表：

| 开关名 | 默认 | 说明 |
|--------|------|------|
| `adversarial_verification` | true | 对抗性验证 |
| `advisor_agent` | true | Advisor 顾问反思 |
| `tool_retry` | true | 工具执行重试 |
| `consecutive_failure_pivot` | true | 连续失败自动转向 |
| `parallel_search` | true | 并行搜索 |
| `cache_optimization` | true | 缓存优化 |
| `telemetry` | false | 遥测数据收集 |
| `hook_failure_handling` | true | Hook 失败处理 |
| `bash_command_classification` | true | Bash 命令细粒度分类 |
| `dynamic_prompt_assembly` | true | 动态系统提示词拼装 |
| `behavior_rules_injection` | true | 行为规则注入 |
| `mcp_instructions_in_prompt` | true | MCP 指令注入提示词 |
| `skill_list_in_prompt` | true | Skill 列表注入提示词 |
| `auto_compact` | true | 自动上下文压缩 |
| `task_planning` | true | 复杂任务自动规划 |
| `tool_batch_summary` | true | 工具批量调用摘要 |
| `memory_extraction` | true | 对话自动记忆提取 |
| `context_budget` | true | 上下文预算分配与检查 |
| `provider_circuit_breaker` | true | Provider API 熔断保护 |
| `cost_tracking` | true | 成本追踪与预算控制 |

详见 [Feature Gate 特性开关](feature-gate.md)。

### 遥测框架

TelemetryManager 提供事件追踪能力，用于监控系统行为：

| 跟踪方法 | 事件类型 | 说明 |
|---------|---------|------|
| `trackToolUse()` | `tool_use` | 工具调用（名称/耗时/成功/错误分类） |
| `trackAgentRun()` | `agent_run` | Agent 运行（ID/耗时/轮次/成功） |
| `trackPermissionDecision()` | `permission_decision` | 权限决策（工具/决策/来源） |
| `trackHookExecution()` | `hook_execution` | Hook 执行（事件/耗时/成功） |
| `trackCacheEvent()` | `cache` | 缓存事件（命中/未命中/大小） |
| `trackError()` | `error` | 错误（分类/消息/堆栈） |

详见 [遥测框架](telemetry.md)。

## 核心数据流

![核心数据流](diagrams/core-data-flow.svg)

## 模块依赖关系

| 模块 | 依赖 | 被依赖 |
|------|------|--------|
| `core` | 无 | 所有模块 |
| `providers` | `core` | `api`, `server` |
| `api` | `core`, `providers` | `agents`, `server` |
| `tools` | `core` | `agents`, `server` |
| `agents` | `core`, `tools`, `context` | `server` |
| `context` | `core` | `agents` |
| `permissions` | `core` | `tools`, `agents`, `server` |
| `hooks` | `core` | `tools`, `agents`, `server` |
| `feature-gate` | `core` | `agents`, `tools`, `server` |
| `telemetry` | `core` | `agents`, `tools`, `server` |
| `memory` | `core`, `providers` | `agents`, `server` |
| `skills` | `core`, `tools` | `server` |
| `mcp` | `core`, `tools` | `server` |
| `tasks` | `core` | `agents`, `server` |
| `teams` | `core` | `agents`, `server` |
| `server` | 所有模块 | 无 |

## 权限系统架构

权限系统由三层决策组成，按优先级依次执行：

```
工具调用请求
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. PreToolUse Hook                      │
│    HookExecutor.execute('PreToolUse')   │
│    ├─ proceed: false → 阻止执行         │
│    └─ proceed: true  → 继续             │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 2. PermissionChecker                    │
│    ├─ 2a. 规则匹配                      │
│    │   deny → allow → ask               │
│    ├─ 2b. PermissionClassifier          │
│    │   confidence ≥ 0.85 → allow        │
│    │   confidence ≥ 0.80 → deny         │
│    │   其他 → ask                       │
│    └─ 2c. PermissionMode 兜底           │
│        bypassPermissions → allow        │
│        auto/dontAsk → allow/deny        │
│        default → ask                    │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 3. 敏感路径检测                          │
│    isSensitivePath / categorizePathRisk │
│    critical → deny/ask                  │
│    high → ask                           │
│    medium → ask                         │
│    low → 正常权限检查                    │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─ allow ──→ 工具执行 ──→ PostToolUse Hook
├─ deny ───→ 返回错误
└─ ask ────→ 人机交互审批
              ├─ 允许（+ permissionUpdate → 持久化规则）
              └─ 拒绝
```

### 关键组件

| 组件 | 源文件 | 职责 |
|------|--------|------|
| CoordinatorAgent | `src/agents/coordinator-mode.ts` | Agent 模式的编排器，系统提示 + 工具驱动 |
| PlanManager | `src/agents/plan-manager.ts` | 结构化计划管理，创建/更新/查询/持久化 |
| PlanTool | `src/tools/built-in/plan.ts` | Plan 工具，Coordinator 通过工具调用管理计划 |
| AgentTool | `src/tools/built-in/agent.ts` | Agent 工具，子 Agent 调度 + 并发控制 + 通知队列 |
| PermissionChecker | `src/permissions/checker.ts` | 权限检查入口，协调规则/分类器/模式 |
| DefaultPermissionClassifier | `src/permissions/classifier.ts` | 基于置信度的自动决策 |
| classifyBashCommand | `src/permissions/classifier.ts` | Bash 命令细粒度分类（11 类） |
| classifyError | `src/permissions/classifier.ts` | 错误分类（6 类：network/filesystem/permission/validation/timeout/resource） |
| SensitivePathChecker | `src/tools/built-in/sensitive-paths.ts` | 6 类 40+ 模式的敏感路径检测 |
| PermissionRule | `src/permissions/rules.ts` | 规则持久化读写 |
| HookRegistry / HookExecutor | `src/hooks/executor.ts` | Hook 注册与执行（含 failure/cancel 专用方法） |
| HookConfig | `src/hooks/config.ts` | Hook 配置持久化与版本迁移 |
| FeatureGateManager | `src/feature-gate/index.ts` | 特性开关管理（13 个内置开关） |
| TelemetryManager | `src/telemetry/index.ts` | 遥测事件追踪与导出 |

详见 [权限控制](permissions.md)、[Hook 钩子系统](hooks.md)、[Feature Gate 特性开关](feature-gate.md) 和 [遥测框架](telemetry.md)。

## Agent Runner 高级能力集成

Agent Runner (`src/agents/runner.ts`) 集成了多项高级能力，通过 Feature Gate 控制启用/禁用：

### 成本追踪与预算控制

```
Agent Loop 每轮迭代
    │
    ▼
┌─────────────────────────────────────────┐
│ CostTracker                             │
│ ├─ 记录 inputTokens / outputTokens     │
│ ├─ 计算 totalCostUsd                   │
│ ├─ 检查 isOverBudget / isNearBudget    │
│ └─ 超预算时终止 Agent 运行              │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 预算 API                                │
│ GET /sessions/:id/cost  → 查询成本      │
│ PUT /sessions/:id/budget → 设置预算     │
└─────────────────────────────────────────┘
```

### 熔断器保护

```
Provider API 调用
    │
    ▼
┌─────────────────────────────────────────┐
│ CircuitBreaker                          │
│ ├─ closed → 正常调用                    │
│ ├─ 连续 N 次失败 → open（拒绝调用）     │
│ ├─ 冷却期后 → half_open（允许有限尝试） │
│ └─ half_open 成功 → closed              │
└─────────────────────────────────────────┘
```

两种熔断器实例：
- **CompactCircuitBreaker**：保护上下文压缩操作
- **ConsolidationCircuitBreaker**：保护记忆整合操作

### 记忆自动提取

```
Agent Loop 每轮迭代
    │
    ▼
┌─────────────────────────────────────────┐
│ MemoryExtractor                         │
│ ├─ shouldExtractMemory() 判断是否提取   │
│ ├─ buildExtractionPrompt() 构建提示词   │
│ ├─ LLM 提取关键信息                     │
│ ├─ inferScope() 推断范围               │
│ └─ saveMemoryFile() 持久化             │
└─────────────────────────────────────────┘
```

### 上下文预算管理

```
Agent Loop 启动时
    │
    ▼
┌─────────────────────────────────────────┐
│ ContextBudget                           │
│ ├─ 检查 system prompt 是否超预算        │
│ ├─ computeBudgetAllocation() 分配      │
│ │   ├─ systemInstruction (预留)        │
│ │   ├─ workingSet (15%)                │
│ │   ├─ memory (25%)                    │
│ │   ├─ conversation (预留)             │
│ │   └─ tools (预留)                    │
│ └─ 超阈值时触发压缩                     │
└─────────────────────────────────────────┘
```

### 工具批量摘要

```
多个工具调用结果
    │
    ▼
┌─────────────────────────────────────────┐
│ ToolUseSummary                          │
│ ├─ 检测批量调用场景                     │
│ ├─ LLM 生成摘要（使用 haiku 模型）     │
│ ├─ 聚合成功/失败状态                    │
│ └─ 提取关键信息                         │
└─────────────────────────────────────────┘
```

### 任务规划

```
用户复杂任务
    │
    ▼
┌─────────────────────────────────────────┐
│ Task Planning                           │
│ ├─ 检测任务复杂度                       │
│ ├─ 自动分解为子步骤                     │
│ ├─ 集成 TodoWrite 工具                  │
│ └─ 逐步执行引导                         │
└─────────────────────────────────────────┘
```

## 相关文档

- [快速开始](quick-start.md)
- [作为后端服务使用](backend-service.md)
- [作为库使用](library-usage.md)
- [自定义工具](custom-tools.md)
- [自定义 Agent](custom-agent.md)
