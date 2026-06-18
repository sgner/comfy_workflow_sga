# Feature Gate 特性开关

> 📄 相关源文件：`src/feature-gate/index.ts`（FeatureGateManager 类）

## 概述

Feature Gate 提供了特性开关机制，允许在运行时灵活启用或禁用各项高级能力。所有开关支持三种配置方式，按优先级从高到低为：运行时覆盖 > 环境变量 > 默认值。

## 内置开关

| 开关名 | 默认值 | 环境变量 | 说明 |
|--------|--------|---------|------|
| `adversarial_verification` | true | `SGA_FEATURE_ADVERSARIAL_VERIFICATION` | 对抗性验证 Agent |
| `advisor_agent` | true | `SGA_FEATURE_ADVISOR_AGENT` | Advisor 顾问反思 Agent |
| `tool_retry` | true | `SGA_FEATURE_TOOL_RETRY` | 工具执行重试（指数退避） |
| `consecutive_failure_pivot` | true | `SGA_FEATURE_CONSECUTIVE_FAILURE_PIVOT` | 连续失败自动转向 |
| `parallel_search` | true | `SGA_FEATURE_PARALLEL_SEARCH` | 并行搜索策略 |
| `cache_optimization` | true | `SGA_FEATURE_CACHE_OPTIMIZATION` | API 层缓存优化 |
| `telemetry` | false | `SGA_FEATURE_TELEMETRY` | 遥测数据收集 |
| `hook_failure_handling` | true | `SGA_FEATURE_HOOK_FAILURE_HANDLING` | Hook 失败处理 |
| `bash_command_classification` | true | `SGA_FEATURE_BASH_COMMAND_CLASSIFICATION` | Bash 命令细粒度分类 |
| `dynamic_prompt_assembly` | true | `SGA_FEATURE_DYNAMIC_PROMPT_ASSEMBLY` | 动态系统提示词拼装 |
| `behavior_rules_injection` | true | `SGA_FEATURE_BEHAVIOR_RULES_INJECTION` | 行为规则注入 |
| `mcp_instructions_in_prompt` | true | `SGA_FEATURE_MCP_INSTRUCTIONS_IN_PROMPT` | MCP 指令注入提示词 |
| `skill_list_in_prompt` | true | `SGA_FEATURE_SKILL_LIST_IN_PROMPT` | Skill 列表注入提示词 |
| `auto_compact` | true | `SGA_FEATURE_AUTO_COMPACT` | 自动上下文压缩（token 阈值触发） |
| `task_planning` | true | `SGA_FEATURE_TASK_PLANNING` | 复杂任务自动规划与分解 |
| `tool_batch_summary` | true | `SGA_FEATURE_TOOL_BATCH_SUMMARY` | 工具批量调用 LLM 摘要生成 |
| `memory_extraction` | true | `SGA_FEATURE_MEMORY_EXTRACTION` | 对话中自动提取记忆 |
| `context_budget` | true | `SGA_FEATURE_CONTEXT_BUDGET` | 上下文预算分配与检查 |
| `provider_circuit_breaker` | true | `SGA_FEATURE_PROVIDER_CIRCUIT_BREAKER` | Provider API 熔断保护 |
| `cost_tracking` | true | `SGA_FEATURE_COST_TRACKING` | 成本追踪与预算控制 |

## 使用方式

### 编程方式

```typescript
import { FeatureGateManager, isFeatureEnabled } from 'SGA-Template'

// 方式一：使用便捷函数
if (isFeatureEnabled('tool_retry')) {
  // 执行重试逻辑
}

// 方式二：使用单例管理器
const gate = FeatureGateManager.getInstance()

// 检查开关状态
gate.isEnabled('advisor_agent')  // true

// 运行时覆盖（最高优先级）
gate.override('telemetry', true)

// 查看开关来源
gate.getSource('tool_retry')  // 'default' | 'env' | 'override'

// 重置为默认值
gate.reset('telemetry')

// 重置所有覆盖
gate.resetAll()
```

### 环境变量方式

在 `.env` 文件或系统环境变量中设置：

```bash
# 启用遥测
SGA_FEATURE_TELEMETRY=true

# 禁用工具重试
SGA_FEATURE_TOOL_RETRY=false

# 启用对抗性验证
SGA_FEATURE_ADVERSARIAL_VERIFICATION=true
```

### 初始化遥测

```typescript
import { initTelemetry } from 'SGA-Template'

// 根据特性开关初始化遥测
initTelemetry()
```

## 配置优先级

```
运行时覆盖 (override)
       │
       ▼
环境变量 (env)
       │
       ▼
默认值 (default)
```

| 来源 | 优先级 | 持久性 | 适用场景 |
|------|--------|--------|---------|
| 运行时覆盖 | 最高 | 进程生命周期内 | 临时测试、动态调整 |
| 环境变量 | 中 | 跨进程持久 | 部署配置、环境差异 |
| 默认值 | 最低 | 代码内固定 | 安全的默认行为 |

## 自定义开关

可以通过 `registerGate()` 方法注册自定义开关：

```typescript
const gate = FeatureGateManager.getInstance()

gate.registerGate({
  name: 'my_custom_feature',
  description: 'My custom feature description',
  defaultEnabled: false,
  envVar: 'SGA_FEATURE_MY_CUSTOM_FEATURE',
})

// 使用
if (isFeatureEnabled('my_custom_feature')) {
  // 自定义逻辑
}
```

## 与其他模块的集成

Feature Gate 已集成到以下模块中：

| 模块 | 使用的开关 | 说明 |
|------|-----------|------|
| Agent Runner | `tool_retry`, `advisor_agent`, `consecutive_failure_pivot`, `auto_compact`, `task_planning`, `tool_batch_summary`, `memory_extraction`, `context_budget`, `provider_circuit_breaker`, `cost_tracking` | 控制重试、顾问、转向、压缩、规划、摘要、记忆提取、预算、熔断、成本 |
| System Prompt | `behavior_rules_injection`, `dynamic_prompt_assembly`, `mcp_instructions_in_prompt`, `skill_list_in_prompt` | 控制提示词拼装 |
| Permissions | `bash_command_classification` | 控制 Bash 命令分类 |
| Hooks | `hook_failure_handling` | 控制失败 Hook 处理 |
| Telemetry | `telemetry` | 控制遥测数据收集 |
| Anthropic Provider | `cache_optimization` | 控制缓存优化 |

## 相关文档

- [项目架构](architecture.md)
- [遥测框架](telemetry.md)
- [环境变量](environment-variables.md)
