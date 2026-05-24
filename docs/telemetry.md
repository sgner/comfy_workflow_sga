# 遥测框架

> 📄 相关源文件：`src/telemetry/index.ts`（TelemetryManager 类）

## 概述

遥测框架提供事件追踪能力，用于监控 Agent 系统的运行行为，包括工具调用、Agent 运行、权限决策、Hook 执行、缓存事件和错误等。

> 遥测默认关闭，需通过 Feature Gate `telemetry` 启用。

## 启用遥测

```bash
# .env 文件
SGA_FEATURE_TELEMETRY=true
```

或运行时启用：

```typescript
import { FeatureGateManager } from 'SGA-Template'

FeatureGateManager.getInstance().override('telemetry', true)
```

## 事件类型

| 事件类型 | 跟踪方法 | 字段 |
|---------|---------|------|
| `tool_use` | `trackToolUse()` | toolName, durationMs, success, errorCategory |
| `agent_run` | `trackAgentRun()` | agentId, durationMs, turnCount, success |
| `permission_decision` | `trackPermissionDecision()` | toolName, decision, source |
| `hook_execution` | `trackHookExecution()` | event, durationMs, success |
| `cache` | `trackCacheEvent()` | hit, key, size |
| `error` | `trackError()` | category, message, stack |

## 使用方式

### 初始化

```typescript
import { initTelemetry, TelemetryManager } from 'SGA-Template'

// 方式一：便捷初始化（根据 Feature Gate 自动决定是否启用）
initTelemetry()

// 方式二：手动初始化并配置导出器
const telemetry = TelemetryManager.getInstance()
telemetry.addExporter(new ConsoleExporter())
```

### 跟踪事件

```typescript
const telemetry = TelemetryManager.getInstance()

// 跟踪工具调用
telemetry.trackToolUse('Bash', 1500, true)
telemetry.trackToolUse('Bash', 500, false, 'network')

// 跟踪 Agent 运行
telemetry.trackAgentRun('agent-123', 30000, 5, true)

// 跟踪权限决策
telemetry.trackPermissionDecision('Bash', 'allow', 'classifier')

// 跟踪 Hook 执行
telemetry.trackHookExecution('PreToolUse', 100, true)

// 跟踪缓存事件
telemetry.trackCacheEvent(true, 'system_prompt_hash', 4096)

// 跟踪错误
telemetry.trackError('network', 'ECONNREFUSED', 'at HttpClient.request')
```

### 自定义导出器

```typescript
import { TelemetryExporter, TelemetryManager, TelemetryEvent } from 'SGA-Template'

class MyExporter implements TelemetryExporter {
  async export(events: TelemetryEvent[]): Promise<void> {
    // 发送到自定义后端
    await fetch('https://telemetry.example.com/events', {
      method: 'POST',
      body: JSON.stringify(events),
    })
  }

  async flush(): Promise<void> {
    // 刷新缓冲区
  }
}

TelemetryManager.getInstance().addExporter(new MyExporter())
```

## 内置导出器

| 导出器 | 说明 |
|--------|------|
| `ConsoleExporter` | 输出到控制台（开发调试用） |
| `NoOpExporter` | 空操作（默认，遥测关闭时使用） |

## 事件格式

```typescript
interface TelemetryEvent {
  type: string
  timestamp: number
  sessionId: string
  data: Record<string, unknown>
}
```

示例事件：

```json
{
  "type": "tool_use",
  "timestamp": 1700000000000,
  "sessionId": "session_1700000000_abc123",
  "data": {
    "toolName": "Bash",
    "durationMs": 1500,
    "success": true,
    "errorCategory": null
  }
}
```

## 配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 刷新间隔 | 30000ms | 事件队列自动刷新间隔 |
| 队列大小 | 无限制 | 事件队列最大容量 |

## 与 Agent Runner 的集成

Agent Runner 在以下节点自动记录遥测事件：

| 节点 | 事件类型 | 说明 |
|------|---------|------|
| 工具调用成功 | `tool_use` | 记录工具名、耗时、成功 |
| 工具调用失败 | `tool_use` | 记录工具名、耗时、失败、错误分类 |
| Agent 运行完成 | `agent_run` | 记录 Agent ID、耗时、轮次、成功 |

## 相关文档

- [Feature Gate 特性开关](feature-gate.md)
- [项目架构](architecture.md)
- [环境变量](environment-variables.md)
