import type { Tool, ToolUseContext, ValidationResult, ToolInputSchema, PermissionResult } from './base.js'

export interface ToolExecutionStep {
  name: string
  execute: (input: unknown, context: ToolUseContext) => Promise<unknown>
}

export interface ToolExecutionPipeline {
  steps: ToolExecutionStep[]
  execute: (tool: Tool, input: unknown, context: ToolUseContext) => Promise<unknown>
}

export function createExecutionPipeline(
  preHooks: ToolExecutionStep[] = [],
  postHooks: ToolExecutionStep[] = [],
): ToolExecutionPipeline {
  return {
    steps: [...preHooks, { name: 'execute', execute: async () => {} }, ...postHooks],

    async execute(tool: Tool, input: unknown, context: ToolUseContext): Promise<unknown> {
      const validation = tool.validateInput(input)
      if (!validation.success) {
        throw new ToolExecutionError(`Validation failed: ${validation.error}`, 'VALIDATION')
      }

      const permission = await tool.checkPermissions(input as Record<string, unknown>, context)
      if (permission.behavior === 'deny') {
        throw new ToolExecutionError(`Permission denied: ${permission.message}`, 'PERMISSION')
      }
      if (permission.behavior === 'ask') {
        throw new ToolExecutionError(`Requires user approval: ${permission.message}`, 'APPROVAL_REQUIRED')
      }

      let currentInput = input
      if (permission.behavior === 'allow' && permission.updatedInput) {
        currentInput = permission.updatedInput
      }

      for (const hook of preHooks) {
        const result = await hook.execute(currentInput, context)
        if (result && typeof result === 'object' && 'input' in result) {
          currentInput = (result as { input: unknown }).input
        }
      }

      const result = await tool.call(currentInput as Record<string, unknown>, context)

      for (const hook of postHooks) {
        await hook.execute(result, context)
      }

      return result
    },
  }
}

export class ToolExecutionError extends Error {
  code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ToolExecutionError'
    this.code = code
  }
}

export interface ToolOrchestrationConfig {
  maxConcurrency: number
  readOnlyBatch: boolean
  serialWrite: boolean
}

export const DEFAULT_ORCHESTRATION_CONFIG: ToolOrchestrationConfig = {
  maxConcurrency: 10,
  readOnlyBatch: true,
  serialWrite: true,
}

export async function* orchestrateToolCalls(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  tools: Tool[],
  context: ToolUseContext,
  pipeline: ToolExecutionPipeline,
  config: ToolOrchestrationConfig = DEFAULT_ORCHESTRATION_CONFIG,
): AsyncGenerator<{ id: string; result: unknown; error?: Error }> {
  const readOnly: typeof calls = []
  const write: typeof calls = []

  for (const call of calls) {
    const tool = tools.find(t => t.name === call.name)
    if (tool?.isReadOnly(call.input)) {
      readOnly.push(call)
    } else {
      write.push(call)
    }
  }

  if (readOnly.length > 0 && config.readOnlyBatch) {
    const results = await Promise.all(
      readOnly.map(async (call) => {
        try {
          const tool = tools.find(t => t.name === call.name)
          if (!tool) throw new ToolExecutionError(`Unknown tool: ${call.name}`, 'UNKNOWN_TOOL')
          const result = await pipeline.execute(tool, call.input, context)
          return { id: call.id, result }
        } catch (error) {
          return { id: call.id, result: null, error: error instanceof Error ? error : new Error(String(error)) }
        }
      }),
    )
    for (const r of results) yield r
  }

  for (const call of write) {
    try {
      const tool = tools.find(t => t.name === call.name)
      if (!tool) throw new ToolExecutionError(`Unknown tool: ${call.name}`, 'UNKNOWN_TOOL')
      const result = await pipeline.execute(tool, call.input, context)
      yield { id: call.id, result }
    } catch (error) {
      yield { id: call.id, result: null, error: error instanceof Error ? error : new Error(String(error)) }
    }
  }
}
