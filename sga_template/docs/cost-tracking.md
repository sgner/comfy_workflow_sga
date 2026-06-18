# 成本追踪

> 📄 相关源文件：`src/utils/cost-tracker.ts`（核心实现）、`src/agents/runner.ts`（集成点）、`src/server/routes.ts`（API 端点）

## 概述

CostTracker 提供会话级别的 LLM 调用成本追踪与预算控制。它在 Agent Loop 的每轮迭代中记录 token 用量，计算累计成本，并在超预算时自动终止运行。

## 架构

```
Agent Loop 每轮迭代
    │
    ├── Provider 返回 usage 信息
    │
    ▼
┌─────────────────────────────────────────┐
│ CostTracker                             │
│ ├─ recordUsage(inputTokens, outputTok.) │
│ ├─ getTotalCostUsd()                    │
│ ├─ isOverBudget()                       │
│ ├─ isNearBudget()                       │
│ └─ getRemainingBudget()                 │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 预算检查                                │
│ ├─ 超预算 → 终止 Agent 运行             │
│ └─ 接近预算 → 日志警告                   │
└─────────────────────────────────────────┘
```

## 使用方式

### 编程方式

```typescript
import { CostTracker } from 'SGA-Template'

const tracker = new CostTracker({
  maxBudgetUsd: 1.0,
  costPerInputToken: 0.000003,
  costPerOutputToken: 0.000015,
  nearBudgetThreshold: 0.8,
})

tracker.recordUsage(1000, 500)

console.log(tracker.getTotalCostUsd())
console.log(tracker.getTotalInputTokens())
console.log(tracker.getTotalOutputTokens())
console.log(tracker.isOverBudget())
console.log(tracker.isNearBudget())
console.log(tracker.getRemainingBudget())
console.log(tracker.getUsageReport())
```

### API 方式

#### 查询会话成本

```
GET /api/v1/sessions/:sessionId/cost
```

```json
{
  "sessionId": "sess-xxx",
  "totalCostUsd": 0.0523,
  "totalInputTokens": 15000,
  "totalOutputTokens": 3000,
  "isOverBudget": false,
  "isNearBudget": false,
  "remainingBudget": 0.9477,
  "report": "Input tokens: 15,000\nOutput tokens: 3,000\n...\nTotal cost: $0.0523\nBudget: $1.00\nRemaining: $0.9477"
}
```

#### 设置会话预算

```
PUT /api/v1/sessions/:sessionId/budget
```

```json
{
  "maxBudgetUsd": 2.0
}
```

## 配置

### 构造参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxBudgetUsd` | `number` | `Infinity` | 最大预算（美元） |
| `costPerInputToken` | `number` | `0` | 每输入 token 成本 |
| `costPerOutputToken` | `number` | `0` | 每输出 token 成本 |
| `nearBudgetThreshold` | `number` | `0.8` | 接近预算阈值（80% 时警告） |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SGA_MAX_BUDGET_USD` | 无限制 | 全局默认预算上限 |
| `SGA_COST_PER_INPUT_TOKEN` | `0` | 默认输入 token 单价 |
| `SGA_COST_PER_OUTPUT_TOKEN` | `0` | 默认输出 token 单价 |

### Feature Gate

成本追踪受 `cost_tracking` 特性开关控制：

```typescript
import { isFeatureEnabled } from 'SGA-Template'

if (isFeatureEnabled('cost_tracking')) {
  // 成本追踪已启用
}
```

环境变量覆盖：

```bash
SGA_FEATURE_COST_TRACKING=true
```

## 与 Agent Runner 集成

CostTracker 在 Agent Runner 中自动初始化和使用：

1. **创建会话时** — 根据配置创建 CostTracker 实例
2. **每轮迭代后** — 调用 `recordUsage()` 记录 token 用量
3. **预算检查** — 每轮迭代前检查是否超预算
4. **超预算终止** — `isOverBudget()` 返回 true 时终止 Agent 运行
5. **接近预算警告** — `isNearBudget()` 返回 true 时记录警告日志

## 用量报告

`getUsageReport()` 生成人类可读的用量报告：

```
Input tokens: 15,000
Output tokens: 3,000
Total tokens: 18,000
Input cost: $0.0450
Output cost: $0.0450
Total cost: $0.0900
Budget: $1.00
Remaining: $0.9100
```

## 相关文档

- [API 参考](api-reference.md) — 完整 API 端点文档
- [Feature Gate 特性开关](feature-gate.md) — 特性开关管理
- [项目架构](architecture.md) — 整体架构说明
