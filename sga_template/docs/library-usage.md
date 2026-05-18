# 作为库使用

> 📄 相关源文件：`src/index.ts`（统一导出）、`src/agents/runner.ts`（runAgent 函数）

SGA-Template 不仅可以作为独立后端服务运行，还可以作为 Node.js 库在你的代码中直接引用。这使得你可以在现有的 Node.js 项目中灵活地集成 Agent 能力。

## 基本用法

```typescript
import {
  runAgent,
  createBuiltinTools,
  getBuiltinAgentDefinitions,
  ToolRegistry,
  APIClient,
} from 'SGA-Template'

const tools = createBuiltinTools()
const agent = getBuiltinAgentDefinitions()[0]
const result = await runAgent({
  agentDefinition: agent,
  prompt: '帮我分析这个项目',
  tools,
  model: 'sonnet',
  maxTurns: 50,
})

console.log(result.content)       // Agent 回复文本
console.log(result.usage)         // Token 用量
console.log(result.turnCount)     // 对话轮数
console.log(result.messages)      // 完整消息历史
```

## AgentRunOptions 详解

> 📄 相关源文件：`src/agents/runner.ts`

`runAgent` 函数接受以下参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentDefinition` | `AgentDefinition` | 是 | Agent 定义，控制行为和系统提示词 |
| `prompt` | `string` | 是 | 用户输入的提示文本 |
| `messages` | `Message[]` | 否 | 历史消息（用于多轮对话） |
| `tools` | `Tool[]` | 是 | 可用工具列表 |
| `model` | `string` | 是 | 模型名称或别名 |
| `systemPrompt` | `SystemPrompt` | 否 | 自定义系统提示词 |
| `maxTurns` | `number` | 否 | 最大对话轮数（默认 50） |
| `maxBudgetUsd` | `number` | 否 | 最大预算（美元） |
| `signal` | `AbortSignal` | 否 | 中断信号 |
| `onProgress` | `(event) => void` | 否 | 进度回调 |
| `parentContext` | `ToolUseContext` | 否 | 父级工具上下文 |

## AgentRunResult 详解

`runAgent` 返回以下结果：

| 字段 | 类型 | 说明 |
|------|------|------|
| `content` | `string` | Agent 最终回复的文本内容 |
| `messages` | `Message[]` | 完整的消息历史（包含所有轮次） |
| `usage` | `UsageMetrics` | Token 用量统计 |
| `turnCount` | `number` | 实际对话轮数 |
| `totalToolUseCount` | `number` | 工具调用总次数 |
| `totalDurationMs` | `number` | 总耗时（毫秒） |

## 多轮对话

```typescript
import { runAgent, createBuiltinTools, getBuiltinAgentDefinitions } from 'SGA-Template'

const tools = createBuiltinTools()
const agent = getBuiltinAgentDefinitions()[0]

// 第一轮
const result1 = await runAgent({
  agentDefinition: agent,
  prompt: '请列出当前目录的文件',
  tools,
  model: 'sonnet',
})

// 第二轮（传入历史消息）
const result2 = await runAgent({
  agentDefinition: agent,
  prompt: '请读取 README.md 的内容',
  messages: result1.messages,
  tools,
  model: 'sonnet',
})
```

## 使用自定义工具

```typescript
import { runAgent, createBuiltinTools, ToolRegistry } from 'SGA-Template'
import { MyCustomTool } from './my-custom-tool'

const registry = new ToolRegistry()
for (const tool of createBuiltinTools()) {
  registry.register(tool)
}
registry.register(new MyCustomTool())

const result = await runAgent({
  agentDefinition: myAgent,
  prompt: '使用自定义工具查询数据',
  tools: registry.getAll(),
  model: 'sonnet',
})
```

## 进度监听

```typescript
const result = await runAgent({
  agentDefinition: agent,
  prompt: '帮我重构代码',
  tools,
  model: 'sonnet',
  onProgress: (event) => {
    if (event.type === 'text_delta') {
      process.stdout.write(event.data)
    } else if (event.type === 'tool_use_start') {
      console.log(`[Tool] ${event.data.name}`)
    }
  },
})
```

## 中断执行

```typescript
const controller = new AbortController()

// 5 秒后中断
setTimeout(() => controller.abort(), 5000)

const result = await runAgent({
  agentDefinition: agent,
  prompt: '长时间任务',
  tools,
  model: 'sonnet',
  signal: controller.signal,
})
```

## 相关文档

- [自定义工具](custom-tools.md)
- [自定义 Agent](custom-agent.md)
- [多供应商 LLM 接入](multi-provider.md)
- [API 参考](api-reference.md)
