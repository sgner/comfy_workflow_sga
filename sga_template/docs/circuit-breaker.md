# 熔断器

> 📄 相关源文件：`src/utils/circuit-breaker.ts`（核心实现）、`src/memory/compact/index.ts`（压缩熔断器）、`src/memory/consolidation/auto-dream.ts`（整合熔断器）、`src/server/routes.ts`（API 端点）

## 概述

熔断器（Circuit Breaker）是一种故障保护模式，当操作连续失败达到阈值时自动切断执行，防止级联故障。SGA 在上下文压缩和记忆整合两个关键操作中使用了熔断器。

## 状态机

```
          连续失败达到阈值
  closed ──────────────────→ open
    │                          │
    │                          │ 冷却时间过后
    │                          ▼
    │                      half_open
    │                       │      │
    │         成功 ←────────┘      └────────→ 失败
    │           │                              │
    ▼           │                              ▼
  closed        │                            open
                │
                └──→ closed（重置失败计数）
```

| 状态 | 说明 | 行为 |
|------|------|------|
| `closed` | 正常状态 | 允许执行，记录失败次数 |
| `open` | 熔断状态 | 拒绝执行，返回降级结果 |
| `half_open` | 半开状态 | 允许有限次数的尝试，用于探测是否恢复 |

## 内置熔断器实例

### CompactCircuitBreaker

保护上下文压缩操作。当 FullCompact 连续失败时触发熔断，防止反复调用 LLM 生成摘要。

```typescript
import { CompactCircuitBreaker } from 'SGA-Template'

const cb = new CompactCircuitBreaker()

if (cb.canExecute()) {
  try {
    const result = await fullCompact(messages, provider, model)
    cb.recordSuccess()
  } catch (error) {
    cb.recordFailure()
  }
} else {
  // 熔断中，跳过压缩
}
```

### ConsolidationCircuitBreaker

保护记忆整合操作。当 AutoDream 整合连续失败时触发熔断。

```typescript
import { ConsolidationCircuitBreaker } from 'SGA-Template'

const cb = new ConsolidationCircuitBreaker()

if (cb.canExecute()) {
  try {
    await consolidateMemories()
    cb.recordSuccess()
  } catch (error) {
    cb.recordFailure()
  }
}
```

### ProviderCircuitBreaker

保护 Provider API 调用。当 LLM API 连续返回错误时触发熔断。

```typescript
import { CircuitBreaker } from 'SGA-Template'

const cb = new CircuitBreaker({
  maxConsecutiveFailures: 3,
  cooldownMs: 10_000,
  halfOpenMaxAttempts: 1,
})

if (cb.canExecute()) {
  try {
    const response = await provider.createMessage(params)
    cb.recordSuccess()
  } catch (error) {
    cb.recordFailure()
  }
}
```

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SGA_CB_COMPACT_MAX_FAILURES` | `3` | 压缩熔断器：连续失败次数阈值 |
| `SGA_CB_COMPACT_COOLDOWN_MS` | `300000` | 压缩熔断器：冷却时间（5 分钟） |
| `SGA_CB_COMPACT_HALF_OPEN_ATTEMPTS` | `1` | 压缩熔断器：半开状态最大尝试次数 |
| `SGA_CB_CONSOLIDATION_MAX_FAILURES` | `2` | 整合熔断器：连续失败次数阈值 |
| `SGA_CB_CONSOLIDATION_COOLDOWN_MS` | `1800000` | 整合熔断器：冷却时间（30 分钟） |
| `SGA_CB_CONSOLIDATION_HALF_OPEN_ATTEMPTS` | `1` | 整合熔断器：半开状态最大尝试次数 |

### Feature Gate

Provider 熔断器受 `provider_circuit_breaker` 特性开关控制：

```bash
SGA_FEATURE_PROVIDER_CIRCUIT_BREAKER=true
```

## API

### 查询熔断器状态

```
GET /api/v1/circuit-breaker
```

```json
{
  "compact": {
    "state": "closed",
    "consecutiveFailures": 0,
    "lastFailureTime": 0,
    "timeUntilCooldown": 0
  },
  "consolidation": {
    "state": "open",
    "consecutiveFailures": 3,
    "lastFailureTime": 1700000000000,
    "timeUntilCooldown": 120000
  }
}
```

### 重置熔断器

```
POST /api/v1/circuit-breaker/reset
```

请求体：

```json
{
  "type": "all"
}
```

| type 值 | 说明 |
|---------|------|
| `compact` | 仅重置压缩熔断器 |
| `consolidation` | 仅重置整合熔断器 |
| `all` | 重置所有熔断器（默认） |

响应：

```json
{
  "success": true,
  "compact": {
    "state": "closed",
    "consecutiveFailures": 0,
    "lastFailureTime": 0,
    "timeUntilCooldown": 0
  },
  "consolidation": {
    "state": "closed",
    "consecutiveFailures": 0,
    "lastFailureTime": 0,
    "timeUntilCooldown": 0
  }
}
```

## 编程方式

### 自定义熔断器

```typescript
import { CircuitBreaker } from 'SGA-Template'

const cb = new CircuitBreaker({
  maxConsecutiveFailures: 5,
  cooldownMs: 60_000,
  halfOpenMaxAttempts: 2,
})

cb.canExecute()           // boolean
cb.recordSuccess()        // 重置失败计数
cb.recordFailure()        // 增加失败计数
cb.getStats()             // { state, consecutiveFailures, lastFailureTime, timeUntilCooldown }
cb.reset()                // 重置为 closed 状态
```

## 相关文档

- [上下文压缩](context-compression.md) — 压缩策略与熔断器集成
- [记忆系统](memory.md) — 记忆整合与熔断器集成
- [API 参考](api-reference.md) — 完整 API 端点文档
- [Feature Gate 特性开关](feature-gate.md) — 特性开关管理
