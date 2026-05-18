# 自定义工具

> 📄 相关源文件：`src/tools/base.ts`（Tool 接口定义）、`src/tools/registry.ts`（ToolRegistry 类）、`src/tools/execution.ts`（执行管线与编排）

## Tool 接口

每个工具必须实现 `Tool` 接口，该接口定义了工具的生命周期方法：

```typescript
// src/tools/base.ts
export interface Tool<Input = Record<string, unknown>, Output = unknown> {
  name: string
  aliases?: string[]
  description: string
  searchHint?: string

  isEnabled(): boolean
  isConcurrencySafe(input: Input): boolean
  isReadOnly(input: Input): boolean
  isDestructive(input: Input): boolean

  validateInput(input: unknown): ValidationResult
  checkPermissions(input: Input, context: ToolUseContext): Promise<PermissionResult>
  call(input: Input, context: ToolUseContext): Promise<Output>

  getDefinition(): ToolDefinition
  renderToolUseMessage?(input: Input): string
  renderToolResultMessage?(result: Output): string
  getToolUseSummary?(input: Input): string

  maxResultSizeChars?: number
  shouldDefer?: boolean
  alwaysLoad?: boolean
}
```

### 接口方法说明

| 方法/属性 | 说明 |
|-----------|------|
| `name` | 工具唯一标识名，LLM 通过此名称调用工具 |
| `aliases` | 可选的别名列表 |
| `description` | 工具描述，LLM 根据此描述决定是否调用 |
| `searchHint` | 搜索提示词，用于工具发现 |
| `isEnabled()` | 工具是否启用 |
| `isConcurrencySafe()` | 是否可并发执行（只读工具通常为 true） |
| `isReadOnly()` | 是否为只读操作 |
| `isDestructive()` | 是否为破坏性操作 |
| `validateInput()` | 输入验证，返回 `ValidationResult` |
| `checkPermissions()` | 权限检查，返回 `PermissionResult` |
| `call()` | 工具的实际执行逻辑 |
| `getDefinition()` | 返回 JSON Schema 格式的工具定义 |
| `maxResultSizeChars` | 结果最大字符数限制 |
| `shouldDefer` | 是否延迟加载 |
| `alwaysLoad` | 是否始终加载 |

## ValidationResult

```typescript
// src/tools/base.ts
export interface ValidationResult {
  success: boolean
  error?: string
}
```

## PermissionResult

```typescript
// src/tools/base.ts
export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: unknown; decisionReason?: string }
  | { behavior: 'ask'; message: string; suggestions?: string[] }
  | { behavior: 'deny'; message: string; decisionReason?: string }
  | { behavior: 'passthrough'; message: string }
```

- **allow** — 允许执行，可通过 `updatedInput` 修改输入
- **ask** — 需要用户确认（触发人机交互）
- **deny** — 拒绝执行
- **passthrough** — 透传，由上层决定

## BaseTool 基类

为了简化工具开发，框架提供了 `BaseTool` 抽象基类，提供了常用方法的默认实现：

```typescript
import { BaseTool } from 'SGA-Template'

export class MyTool extends BaseTool {
  name = 'MyTool'
  description = '我的自定义工具'

  validateInput(input: unknown): ValidationResult {
    return { success: true }
  }

  async call(input: Record<string, unknown>, context: ToolUseContext): Promise<string> {
    return 'result'
  }

  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    }
  }
}
```

## 完整示例：数据库查询工具

```typescript
import type { Tool, ToolUseContext, ValidationResult, PermissionResult } from 'SGA-Template'

export class DatabaseQueryTool implements Tool {
  name = 'DBQuery'
  description = '查询数据库'
  searchHint = 'database sql query'

  isEnabled(): boolean { return true }
  isConcurrencySafe(_input: Record<string, unknown>): boolean { return true }
  isReadOnly(_input: Record<string, unknown>): boolean { return true }
  isDestructive(_input: Record<string, unknown>): boolean { return false }

  validateInput(input: unknown): ValidationResult {
    const sql = (input as { sql?: string }).sql
    if (!sql) return { success: false, error: 'sql is required' }
    return { success: true }
  }

  async checkPermissions(input: Record<string, unknown>, _context: ToolUseContext): Promise<PermissionResult> {
    const sql = input.sql as string
    if (sql.trim().toUpperCase().startsWith('DROP')) {
      return { behavior: 'deny', message: 'DROP statements are not allowed' }
    }
    return { behavior: 'allow' }
  }

  async call(input: Record<string, unknown>, _context: ToolUseContext): Promise<string> {
    const sql = input.sql as string
    const results = await executeSQL(sql)
    return JSON.stringify(results)
  }

  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object' as const,
        properties: { sql: { type: 'string', description: 'SQL query to execute' } },
        required: ['sql'],
      },
    }
  }
}
```

## 注册工具

### 使用 ToolRegistry

```typescript
import { ToolRegistry, createBuiltinTools } from 'SGA-Template'
import { DatabaseQueryTool } from './db-query-tool'

const registry = new ToolRegistry()

// 注册内置工具
for (const tool of createBuiltinTools()) {
  registry.register(tool)
}

// 注册自定义工具
registry.register(new DatabaseQueryTool())

// 查找工具
const tool = registry.get('DBQuery')

// 搜索工具
const results = registry.search('database')

// 获取所有工具定义（用于发送给 LLM）
const definitions = registry.getDefinitions()
```

### ToolRegistry API

> 📄 相关源文件：`src/tools/registry.ts`

| 方法 | 说明 |
|------|------|
| `register(tool)` | 注册工具 |
| `unregister(name)` | 取消注册 |
| `get(name)` | 按名称获取工具 |
| `getAll()` | 获取所有工具 |
| `getActiveTools()` | 获取已启用的工具 |
| `getDeferredTools()` | 获取延迟加载的工具 |
| `getDefinitions()` | 获取所有工具的 JSON Schema 定义 |
| `search(query)` | 按名称/描述/搜索提示搜索工具 |
| `loadDeferred(name)` | 加载延迟工具 |
| `clear()` | 清空注册表 |

## 工具执行管线

> 📄 相关源文件：`src/tools/execution.ts`

工具执行管线 (`createExecutionPipeline`) 提供了可插拔的前置/后置钩子，集成在 Agent 运行循环中：

```typescript
import { createExecutionPipeline } from 'SGA-Template'

const pipeline = createExecutionPipeline({
  preHooks: [
    { name: 'log', execute: async (input, ctx) => { console.log('before:', input) } },
  ],
  postHooks: [
    { name: 'audit', execute: async (result, ctx) => { console.log('after:', result) } },
  ],
  logExecution: true,
  measureTiming: true,
  maxResultSizeChars: 50000,
})

const result = await pipeline.execute(tool, input, context)
// result: { toolName, input, output, durationMs, error? }
```

### 管线配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `preHooks` | `ToolExecutionStep[]` | `[]` | 前置钩子列表 |
| `postHooks` | `ToolExecutionStep[]` | `[]` | 后置钩子列表 |
| `logExecution` | `boolean` | `true` | 是否记录执行日志 |
| `measureTiming` | `boolean` | `true` | 是否测量执行时间 |
| `maxResultSizeChars` | `number` | - | 结果最大字符数（超出截断） |

### 执行结果

管线返回 `ToolExecutionResult` 对象：

```typescript
interface ToolExecutionResult {
  toolName: string
  input: unknown
  output: unknown
  durationMs: number
  error?: ToolExecutionError
}
```

### 错误码

| 错误码 | 说明 |
|--------|------|
| `VALIDATION` | 输入验证失败 |
| `PERMISSION` | 权限拒绝 |
| `APPROVAL_REQUIRED` | 需要用户确认 |
| `EXECUTION` | 工具执行失败 |
| `UNKNOWN_TOOL` | 工具不存在 |

执行管线的处理流程：

1. **输入验证** — 调用 `tool.validateInput()`，失败返回 `VALIDATION` 错误
2. **权限检查** — 调用 `tool.checkPermissions()`，拒绝返回 `PERMISSION` 错误
3. **前置钩子** — 执行 preHooks（可修改输入）
4. **工具调用** — 调用 `tool.call()`，失败返回 `EXECUTION` 错误
5. **结果截断** — 如果配置了 `maxResultSizeChars`，超出时自动截断
6. **后置钩子** — 执行 postHooks

### 默认管线

```typescript
import { createDefaultPipeline } from 'SGA-Template'

// 创建带日志和计时的默认管线
const pipeline = createDefaultPipeline(50000)  // maxResultSizeChars = 50000
```

### 在 Agent 中使用自定义管线

```typescript
import { runAgent, createExecutionPipeline } from 'SGA-Template'

const pipeline = createExecutionPipeline({
  preHooks: [
    { name: 'audit', execute: async (input, ctx) => {
      await auditLog.record({ tool: ctx.toolName, input })
    }},
  ],
  postHooks: [
    { name: 'cache', execute: async (result, ctx) => {
      await cache.set(ctx.toolName, result)
    }},
  ],
  maxResultSizeChars: 100000,
})

const result = await runAgent({
  agentDefinition: agentDef,
  prompt: '用户输入',
  tools: myTools,
  model: 'gpt-4',
  provider: myProvider,
  pipeline,  // ← 传入自定义管线
})
```

## 工具编排

> 📄 相关源文件：`src/tools/execution.ts`

`orchestrateToolCalls` 函数负责并发/串行编排多个工具调用，已集成在 Agent 运行循环中：

```typescript
import { orchestrateToolCalls } from 'SGA-Template'

const calls = [
  { id: '1', name: 'Read', input: { file_path: '/a.ts' } },
  { id: '2', name: 'Read', input: { file_path: '/b.ts' } },
  { id: '3', name: 'Write', input: { file_path: '/c.ts', content: '...' } },
]

const results = await orchestrateToolCalls(calls, tools, context, pipeline)
// results: Array<{ id, name, result: ToolExecutionResult }>
```

编排策略：
- **只读工具并发执行** — `FileRead`、`Grep` 等只读工具通过 `Promise.all` 并行
- **写入工具串行执行** — `FileWrite`、`FileEdit` 等写入工具逐个执行
- **可配置最大并发数** — 通过 `maxConcurrency` 控制

### 编排配置

```typescript
import { orchestrateToolCalls, DEFAULT_ORCHESTRATION_CONFIG } from 'SGA-Template'

const config = {
  maxConcurrency: 10,    // 最大并发数
  readOnlyBatch: true,   // 只读工具批量并发
  serialWrite: true,     // 写入工具串行执行
}

const results = await orchestrateToolCalls(calls, tools, context, pipeline, config)
```

### 在 Agent 中使用自定义编排

```typescript
import { runAgent } from 'SGA-Template'

const result = await runAgent({
  agentDefinition: agentDef,
  prompt: '用户输入',
  tools: myTools,
  model: 'gpt-4',
  provider: myProvider,
  orchestrationConfig: {
    maxConcurrency: 5,
    readOnlyBatch: true,
    serialWrite: true,
  },
})
```

## 相关文档

- [内置工具一览](builtin-tools.md)
- [权限控制](permissions.md)
- [Hook 钩子系统](hooks.md)
- [自定义 Agent](custom-agent.md)
