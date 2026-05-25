import type { Tool, ToolUseContext, ValidationResult, PermissionResult, ToolProgressCallback } from './base.js'
import type { ToolProgressData } from '../core/types.js'
import { createLogger } from '../utils/logger.js'
import { HookRegistry, HookExecutor, loadHookConfig } from '../hooks/index.js'
import type { HookDefinition, HookExecutionContext } from '../hooks/index.js'
import { classifyError } from '../permissions/index.js'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const logger = createLogger('tool-execution')

export interface ToolExecutionStep {
  name: string
  execute: (input: unknown, context: ToolUseContext) => Promise<unknown>
}

export interface ToolExecutionResult {
  toolName: string
  input: unknown
  output: unknown
  durationMs: number
  error?: ToolExecutionError
}

export interface ToolExecutionPipeline {
  steps: ToolExecutionStep[]
  execute(tool: Tool, input: unknown, context: ToolUseContext, onProgress?: ToolProgressCallback): Promise<ToolExecutionResult>
}

export interface ToolExecutionPipelineConfig {
  preHooks?: ToolExecutionStep[]
  postHooks?: ToolExecutionStep[]
  hookDefinitions?: HookDefinition[]
  logExecution?: boolean
  measureTiming?: boolean
  maxResultSizeChars?: number
}

export function createExecutionPipeline(
  config: ToolExecutionPipelineConfig = {},
): ToolExecutionPipeline {
  const {
    preHooks = [],
    postHooks = [],
    hookDefinitions = [],
    logExecution = true,
    measureTiming = true,
    maxResultSizeChars,
  } = config

  const hookRegistry = new HookRegistry()
  for (const hookDef of hookDefinitions) {
    hookRegistry.register(hookDef)
  }
  const hookExecutor = new HookExecutor(hookRegistry)

  return {
    steps: [...preHooks, { name: 'execute', execute: async () => {} }, ...postHooks],

    async execute(tool: Tool, input: unknown, context: ToolUseContext, onProgress?: ToolProgressCallback): Promise<ToolExecutionResult> {
      const startTime = measureTiming ? Date.now() : 0
      let currentInput = input

      if (logExecution) {
        logger.info(`[Pipeline] Executing tool: ${tool.name}`)
      }

      const validation = tool.validateInput(currentInput)
      if (!validation.success) {
        const error = new ToolExecutionError(
          `Validation failed for ${tool.name}: ${validation.error}`,
          'VALIDATION',
        )
        if (logExecution) {
          logger.warn(`[Pipeline] Validation failed for ${tool.name}: ${validation.error}`)
        }
        return {
          toolName: tool.name,
          input: currentInput,
          output: null,
          durationMs: measureTiming ? Date.now() - startTime : 0,
          error,
        }
      }

      const hookContext: HookExecutionContext = {
        toolName: tool.name,
        toolInput: currentInput as Record<string, unknown>,
        cwd: process.cwd(),
        sessionId: context.agentId,
      }

      const preToolUseResults = await hookExecutor.execute('PreToolUse', hookContext)
      const blockedByHook = preToolUseResults.find(r => !r.proceed)
      if (blockedByHook) {
        const error = new ToolExecutionError(
          `Blocked by PreToolUse hook: ${blockedByHook.stderr || blockedByHook.stdout}`,
          'HOOK_BLOCKED',
        )
        if (logExecution) {
          logger.warn(`[Pipeline] Tool ${tool.name} blocked by PreToolUse hook`)
        }
        return {
          toolName: tool.name,
          input: currentInput,
          output: null,
          durationMs: measureTiming ? Date.now() - startTime : 0,
          error,
        }
      }

      for (const hookResult of preToolUseResults) {
        if (hookResult.modifiedData && typeof hookResult.modifiedData === 'object') {
          const modified = hookResult.modifiedData as { input?: unknown }
          if (modified.input !== undefined) {
            currentInput = modified.input
          }
        }
      }

      const toolPermission = await tool.checkPermissions(currentInput as Record<string, unknown>, context)

      let finalPermission = context.permissionChecker
        ? context.permissionChecker.resolveWithToolPermission(toolPermission, tool.name, currentInput as Record<string, unknown>)
        : toolPermission

      const hookPermissionBehavior = extractHookPermissionBehavior(preToolUseResults)
      if (hookPermissionBehavior) {
        finalPermission = mergeHookWithPermission(hookPermissionBehavior, finalPermission, tool.name)
      }

      if (tool.requiresUserInteraction() && finalPermission.behavior === 'allow') {
        finalPermission = {
          behavior: 'ask',
          message: `${tool.name} requires user interaction`,
        }
      }

      if (finalPermission.behavior === 'deny') {
        const error = new ToolExecutionError(
          `Permission denied for ${tool.name}: ${finalPermission.message ?? 'No reason provided'}`,
          'PERMISSION',
        )
        if (logExecution) {
          logger.warn(`[Pipeline] Permission denied for ${tool.name}: ${finalPermission.message}`)
        }
        return {
          toolName: tool.name,
          input: currentInput,
          output: null,
          durationMs: measureTiming ? Date.now() - startTime : 0,
          error,
        }
      }
      if (finalPermission.behavior === 'ask') {
        const error = new ToolExecutionError(
          `Requires user approval for ${tool.name}: ${finalPermission.message}`,
          'APPROVAL_REQUIRED',
        )
        if (logExecution) {
          logger.info(`[Pipeline] Approval required for ${tool.name}: ${finalPermission.message}`)
        }
        return {
          toolName: tool.name,
          input: currentInput,
          output: null,
          durationMs: measureTiming ? Date.now() - startTime : 0,
          error,
        }
      }

      if (finalPermission.behavior === 'allow' && finalPermission.updatedInput) {
        currentInput = finalPermission.updatedInput
        if (logExecution) {
          logger.debug(`[Pipeline] Input updated by permission check for ${tool.name}`)
        }
      }

      for (const hook of preHooks) {
        try {
          const hookResult = await hook.execute(currentInput, context)
          if (hookResult && typeof hookResult === 'object' && 'input' in hookResult) {
            currentInput = (hookResult as { input: unknown }).input
          }
        } catch (hookError) {
          logger.warn(`[Pipeline] Pre-hook "${hook.name}" failed for ${tool.name}: ${hookError instanceof Error ? hookError.message : String(hookError)}`)
        }
      }

      let result: unknown
      let executionError: ToolExecutionError | null = null
      try {
        result = await tool.call(currentInput as Record<string, unknown>, context, onProgress)
      } catch (callError) {
        const errorCategory = classifyError(callError instanceof Error ? callError.message : String(callError))
        const stderr = (callError as { stderr?: string })?.stderr
        const stdout = (callError as { stdout?: string })?.stdout
        const exitCode = (callError as { code?: number })?.code

        executionError = new ToolExecutionError(
          callError instanceof Error ? callError.message : String(callError),
          'EXECUTION',
          { stderr, stdout, exitCode, errorCategory },
        )
        if (logExecution) {
          logger.error(`[Pipeline] Tool ${tool.name} execution failed: ${executionError.message}`)
        }

        const failureContext: HookExecutionContext = {
          toolName: tool.name,
          toolInput: currentInput as Record<string, unknown>,
          toolError: executionError.message,
          cwd: process.cwd(),
          sessionId: context.agentId,
        }
        const failureHookResults = await hookExecutor.execute('PostToolUseFailure', failureContext)

        const additionalContexts: string[] = []
        for (const hr of failureHookResults) {
          if (hr.stdout) additionalContexts.push(hr.stdout)
          if (hr.stderr) additionalContexts.push(hr.stderr)
          if (hr.modifiedData && typeof hr.modifiedData === 'object') {
            const md = hr.modifiedData as { additionalContext?: string; suggestion?: string }
            if (md.additionalContext) additionalContexts.push(md.additionalContext)
            if (md.suggestion) additionalContexts.push(`Suggestion: ${md.suggestion}`)
          }
        }
        if (additionalContexts.length > 0) {
          executionError.additionalContext = additionalContexts.join('\n')
        }

        return {
          toolName: tool.name,
          input: currentInput,
          output: null,
          durationMs: measureTiming ? Date.now() - startTime : 0,
          error: executionError,
        }
      }

      if (maxResultSizeChars && typeof result === 'string' && result.length > maxResultSizeChars) {
        const persisted = await persistOversizedResult(result, tool.name)
        if (persisted) {
          result = `[Result too large (${result.length} chars), saved to ${persisted}]\n\nFirst ${Math.min(500, maxResultSizeChars)} chars:\n${result.slice(0, Math.min(500, maxResultSizeChars))}`
        } else {
          result = result.slice(0, maxResultSizeChars) + `\n...[truncated, original size: ${result.length} chars]`
        }
      } else if (maxResultSizeChars && typeof result === 'object' && result !== null) {
        const serialized = JSON.stringify(result)
        if (serialized.length > maxResultSizeChars) {
          const persisted = await persistOversizedResult(serialized, tool.name)
          if (persisted) {
            result = `[Result too large (${serialized.length} chars), saved to ${persisted}]\n\nFirst ${Math.min(500, maxResultSizeChars)} chars:\n${serialized.slice(0, Math.min(500, maxResultSizeChars))}`
          } else {
            result = serialized.slice(0, maxResultSizeChars) + `\n...[truncated, original size: ${serialized.length} chars]`
          }
        }
      }

      const postHookContext: HookExecutionContext = {
        toolName: tool.name,
        toolInput: currentInput as Record<string, unknown>,
        toolOutput: result,
        cwd: process.cwd(),
        sessionId: context.agentId,
      }
      await hookExecutor.execute('PostToolUse', postHookContext)

      for (const hook of postHooks) {
        try {
          await hook.execute(result, context)
        } catch (hookError) {
          logger.warn(`[Pipeline] Post-hook "${hook.name}" failed for ${tool.name}: ${hookError instanceof Error ? hookError.message : String(hookError)}`)
        }
      }

      const durationMs = measureTiming ? Date.now() - startTime : 0
      if (logExecution) {
        const resultLen = typeof result === 'string' ? result.length : JSON.stringify(result).length
        logger.info(`[Pipeline] Tool ${tool.name} completed in ${durationMs}ms, result size=${resultLen}`)
      }

      return {
        toolName: tool.name,
        input: currentInput,
        output: result,
        durationMs,
      }
    },
  }
}

export class ToolExecutionError extends Error {
  code: string
  stderr?: string
  stdout?: string
  exitCode?: number
  additionalContext?: string
  errorCategory?: string

  constructor(message: string, code: string, details?: { stderr?: string; stdout?: string; exitCode?: number; additionalContext?: string; errorCategory?: string }) {
    super(message)
    this.name = 'ToolExecutionError'
    this.code = code
    if (details) {
      this.stderr = details.stderr
      this.stdout = details.stdout
      this.exitCode = details.exitCode
      this.additionalContext = details.additionalContext
      this.errorCategory = details.errorCategory
    }
  }

  toFormattedString(): string {
    const parts: string[] = [`<tool_use_error>`]
    parts.push(`Error Code: ${this.code}`)
    if (this.errorCategory) {
      parts.push(`Category: ${this.errorCategory}`)
    }
    parts.push(`Message: ${this.message}`)
    if (this.exitCode !== undefined) {
      parts.push(`Exit Code: ${this.exitCode}`)
    }
    if (this.stderr) {
      const truncated = this.stderr.length > 3000
        ? this.stderr.slice(0, 1500) + `\n... [${this.stderr.length - 3000} chars truncated] ...\n` + this.stderr.slice(-1500)
        : this.stderr
      parts.push(`Stderr:\n${truncated}`)
    }
    if (this.stdout) {
      const truncated = this.stdout.length > 3000
        ? this.stdout.slice(0, 1500) + `\n... [${this.stdout.length - 3000} chars truncated] ...\n` + this.stdout.slice(-1500)
        : this.stdout
      parts.push(`Stdout:\n${truncated}`)
    }
    if (this.additionalContext) {
      parts.push(`Additional Context:\n${this.additionalContext}`)
    }
    parts.push(`</tool_use_error>`)
    return parts.join('\n')
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

export interface OrchestratedResult {
  id: string
  name: string
  result: ToolExecutionResult
}

export async function orchestrateToolCalls(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  tools: Tool[],
  context: ToolUseContext,
  pipeline: ToolExecutionPipeline,
  config: ToolOrchestrationConfig = DEFAULT_ORCHESTRATION_CONFIG,
  onProgress?: (toolUseId: string, data: ToolProgressData) => void,
): Promise<OrchestratedResult[]> {
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

  const results: OrchestratedResult[] = []

  if (readOnly.length > 0 && config.readOnlyBatch) {
    logger.info(`[Orchestrator] Executing ${readOnly.length} read-only tool(s) in parallel`)

    const batchResults = await Promise.all(
      readOnly.map(async (call) => {
        const tool = tools.find(t => t.name === call.name)
        if (!tool) {
          return {
            id: call.id,
            name: call.name,
            result: {
              toolName: call.name,
              input: call.input,
              output: null,
              durationMs: 0,
              error: new ToolExecutionError(`Unknown tool: ${call.name}`, 'UNKNOWN_TOOL'),
            },
          }
        }
        const toolProgress = onProgress
          ? (data: ToolProgressData) => onProgress(call.id, data)
          : undefined
        const result = await pipeline.execute(tool, call.input, context, toolProgress)
        return { id: call.id, name: call.name, result }
      }),
    )
    results.push(...batchResults)
  }

  if (write.length > 0) {
    logger.info(`[Orchestrator] Executing ${write.length} write tool(s) serially`)
    for (const call of write) {
      const tool = tools.find(t => t.name === call.name)
      if (!tool) {
        results.push({
          id: call.id,
          name: call.name,
          result: {
            toolName: call.name,
            input: call.input,
            output: null,
            durationMs: 0,
            error: new ToolExecutionError(`Unknown tool: ${call.name}`, 'UNKNOWN_TOOL'),
          },
        })
        continue
      }
      const toolProgress = onProgress
        ? (data: ToolProgressData) => onProgress(call.id, data)
        : undefined
      const result = await pipeline.execute(tool, call.input, context, toolProgress)
      results.push({ id: call.id, name: call.name, result })
    }
  }

  return results
}

export function createDefaultPipeline(maxResultSizeChars?: number): ToolExecutionPipeline {
  let hookDefinitions: HookDefinition[] = []
  try {
    const config = loadHookConfig()
    hookDefinitions = config.hooks
  } catch {
    logger.debug('No hook config loaded, using empty hooks')
  }

  return createExecutionPipeline({
    logExecution: true,
    measureTiming: true,
    maxResultSizeChars,
    hookDefinitions,
  })
}

function extractHookPermissionBehavior(
  hookResults: Array<{ modifiedData?: unknown }>,
): 'allow' | 'deny' | 'ask' | null {
  for (const result of hookResults) {
    if (result.modifiedData && typeof result.modifiedData === 'object') {
      const md = result.modifiedData as { permissionBehavior?: string }
      if (md.permissionBehavior === 'allow' || md.permissionBehavior === 'deny' || md.permissionBehavior === 'ask') {
        return md.permissionBehavior
      }
    }
  }
  return null
}

function mergeHookWithPermission(
  hookBehavior: 'allow' | 'deny' | 'ask',
  permissionResult: PermissionResult,
  toolName: string,
): PermissionResult {
  if (hookBehavior === 'deny') {
    return {
      behavior: 'deny',
      message: `Denied by PreToolUse hook for ${toolName}`,
      decisionReason: 'hook_deny',
    }
  }

  if (hookBehavior === 'ask') {
    if (permissionResult.behavior === 'deny') {
      return permissionResult
    }
    const msg = permissionResult.behavior === 'allow'
      ? `Hook requests confirmation for ${toolName}`
      : (permissionResult as { message: string }).message ?? `Hook requests confirmation for ${toolName}`
    return {
      behavior: 'ask',
      message: msg,
      decisionReason: 'hook_ask',
    }
  }

  if (hookBehavior === 'allow') {
    if (permissionResult.behavior === 'deny') {
      logger.warn(`[Pipeline] Hook allows ${toolName} but rule-based deny takes precedence`)
      return permissionResult
    }
    if (permissionResult.behavior === 'ask' && permissionResult.decisionReason?.startsWith('rule_')) {
      logger.warn(`[Pipeline] Hook allows ${toolName} but rule-based ask takes precedence`)
      return permissionResult
    }
    return {
      behavior: 'allow',
      decisionReason: 'hook_allow',
    }
  }

  return permissionResult
}

async function persistOversizedResult(content: string, toolName: string): Promise<string | null> {
  try {
    const dir = join(tmpdir(), 'sga-oversized-results')
    mkdirSync(dir, { recursive: true })
    const filename = `${toolName}-${Date.now()}.txt`
    const filepath = join(dir, filename)
    writeFileSync(filepath, content, 'utf-8')
    logger.info(`[Pipeline] Persisted oversized result from ${toolName} to ${filepath} (${content.length} chars)`)
    return filepath
  } catch (error) {
    logger.warn(`[Pipeline] Failed to persist oversized result: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
