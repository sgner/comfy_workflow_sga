# 自定义 Agent

> 📄 相关源文件：`src/agents/definition.ts`（BaseAgentDefinition 类、AgentDefinition 接口）、`src/agents/runner.ts`（runAgent 函数）、`src/agents/fork.ts`（分叉执行）

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
| `getEffort()` | 获取思考力度 |
| `getPermissionMode()` | 获取权限模式覆盖 |
| `isBuiltIn()` | 是否为内置 Agent |
| `isBackground()` | 是否为后台 Agent |
| `isProactive()` | 是否为主动 Agent |

## BaseAgentDefinition 基类

`BaseAgentDefinition` 提供了 `AgentDefinition` 的默认实现，你可以通过构造函数参数快速创建自定义 Agent：

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

### 构造函数参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | 是 | Agent 名称 |
| `description` | `string` | 是 | Agent 描述 |
| `subagentType` | `string` | 是 | 子 Agent 类型标识 |
| `systemPrompt` | `string` | 是 | 系统提示词内容 |
| `allowedTools` | `string[]` | 否 | 允许使用的工具列表 |
| `disallowedTools` | `string[]` | 否 | 禁止使用的工具列表（默认 []） |
| `model` | `ModelAlias \| 'inherit'` | 否 | 模型覆盖 |
| `effort` | `ThinkingEffort` | 否 | 思考力度 |
| `permissionMode` | `PermissionMode` | 否 | 权限模式覆盖 |
| `background` | `boolean` | 否 | 是否为后台 Agent（默认 false） |
| `proactive` | `boolean` | 否 | 是否为主动 Agent（默认 false） |

## 通过文件定义 Agent

除了代码定义，你还可以通过 Markdown 文件定义 Agent（类似 Skills 的方式）：

```typescript
// src/agents/definition.ts — AgentFrontmatter
export interface AgentFrontmatter {
  name?: string
  description?: string
  model?: string
  effort?: string
  tools?: string | string[]
  'disallowed-tools'?: string | string[]
  'user-invocable'?: boolean
  context?: 'inline' | 'fork'
  mode?: string
  background?: boolean
  proactive?: boolean
  'mcp-servers'?: Record<string, unknown>
}
```

## 子 Agent 分叉执行

> 📄 相关源文件：`src/agents/fork.ts`

在 Agent 运行过程中，可以通过分叉（fork）机制启动子 Agent 执行子任务：

```typescript
import { forkAgent } from 'SGA-Template'

const subResult = await forkAgent({
  parentContext: toolUseContext,
  agentDefinition: subAgent,
  prompt: '请分析这个函数的复杂度',
  tools: filteredTools,
  model: 'haiku',
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
3. **构建系统提示词** — 调用 `agentDefinition.getSystemPrompt()`
4. **初始化消息** — 将用户 prompt 添加到消息历史
5. **执行 Agent 循环** — 反复调用 LLM 和工具，直到结束条件满足
6. **返回结果** — 提取最终回复文本和统计信息

```typescript
// src/agents/runner.ts — AgentRunOptions
export interface AgentRunOptions {
  agentDefinition: AgentDefinition
  prompt: string
  messages?: Message[]
  tools: Tool[]
  model: string
  systemPrompt?: SystemPrompt
  maxTurns?: number
  maxBudgetUsd?: number
  signal?: AbortSignal
  onProgress?: (event: unknown) => void
  parentContext?: ToolUseContext
}
```

## 相关文档

- [作为库使用](library-usage.md)
- [自定义工具](custom-tools.md)
- [自定义系统提示词](custom-prompt.md)
- [权限控制](permissions.md)
