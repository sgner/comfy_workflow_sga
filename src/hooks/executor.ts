import type { HookDefinition, HookEventType, HookResult, HookExecutionContext } from './types.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('hook-executor')

export class HookRegistry {
  private hooks: Map<HookEventType, HookDefinition[]> = new Map()

  register(hook: HookDefinition): void {
    const existing = this.hooks.get(hook.event) ?? []
    existing.push(hook)
    this.hooks.set(hook.event, existing)
  }

  unregister(event: HookEventType, command: string): void {
    const existing = this.hooks.get(event) ?? []
    this.hooks.set(event, existing.filter(h => h.command !== command))
  }

  getHooks(event: HookEventType): HookDefinition[] {
    return this.hooks.get(event) ?? []
  }

  clear(): void {
    this.hooks.clear()
  }
}

export class HookExecutor {
  private registry: HookRegistry
  private executedOnce: Set<string> = new Set()
  private cancelled: boolean = false

  constructor(registry: HookRegistry) {
    this.registry = registry
  }

  isCancelled(): boolean {
    return this.cancelled
  }

  resetCancellation(): void {
    this.cancelled = false
  }

  async execute(
    event: HookEventType,
    context: HookExecutionContext,
  ): Promise<HookResult[]> {
    if (this.cancelled && event !== 'Cancel') {
      return []
    }

    const hooks = this.registry.getHooks(event)
    const results: HookResult[] = []

    for (const hook of hooks) {
      if (hook.matcher && context.toolName && !matchHookMatcher(hook.matcher, context.toolName)) {
        continue
      }

      if (hook.once) {
        const key = `${event}:${hook.command}`
        if (this.executedOnce.has(key)) continue
        this.executedOnce.add(key)
      }

      const result = await this.executeHook(hook, context)
      results.push(result)

      if (result.additionalContext) {
        logger.debug(`Hook provided additional context for ${event}`)
      }

      if (result.mcpOutput) {
        logger.debug(`Hook provided MCP output for ${event}`)
      }

      if (!result.proceed) {
        if (event === 'PreToolUse') {
          logger.info(`Hook blocked tool execution: ${context.toolName}`)
        }
        break
      }
    }

    return results
  }

  async executeFailureHooks(
    toolName: string,
    toolInput: Record<string, unknown>,
    error: string,
    context: Omit<HookExecutionContext, 'toolName' | 'toolInput' | 'toolError'>,
  ): Promise<HookResult[]> {
    return this.execute('PostToolUseFailure', {
      ...context,
      toolName,
      toolInput,
      toolError: error,
    })
  }

  async executeCancelHooks(
    context: Omit<HookExecutionContext, 'cancelled'>,
  ): Promise<HookResult[]> {
    this.cancelled = true
    return this.execute('Cancel', { ...context, cancelled: true })
  }

  private async executeHook(
    hook: HookDefinition,
    context: HookExecutionContext,
  ): Promise<HookResult> {
    try {
      const { execSync } = await import('child_process')
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        SGA_HOOK_EVENT: hook.event,
        SGA_TOOL_NAME: context.toolName ?? '',
        SGA_SESSION_ID: context.sessionId ?? '',
      }

      if (context.toolError) {
        env.SGA_TOOL_ERROR = context.toolError
      }

      if (context.cancelled) {
        env.SGA_CANCELLED = 'true'
      }

      const stdinData: Record<string, unknown> = {}
      if (context.toolInput) stdinData.toolInput = context.toolInput
      if (context.toolOutput) stdinData.toolOutput = context.toolOutput
      if (context.toolError) stdinData.toolError = context.toolError

      const stdinStr = Object.keys(stdinData).length > 0
        ? JSON.stringify(stdinData)
        : undefined

      const stdout = execSync(hook.command, {
        timeout: hook.timeout ?? 30000,
        encoding: 'utf-8',
        env,
        cwd: context.cwd,
        input: stdinStr,
      })

      const parsed = parseHookOutput(stdout)

      return {
        exitCode: 0,
        stdout,
        stderr: '',
        proceed: !parsed.block,
        additionalContext: parsed.additionalContext,
        mcpOutput: parsed.mcpOutput,
        modifiedData: parsed.modifiedData,
      }
    } catch (error: unknown) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      const exitCode = e.status ?? 1
      const stdout = e.stdout ?? ''
      const stderr = e.stderr ?? ''

      return {
        exitCode,
        stdout,
        stderr,
        proceed: exitCode !== 2,
      }
    }
  }
}

interface ParsedHookOutput {
  block?: boolean
  additionalContext?: string
  mcpOutput?: Record<string, unknown>
  modifiedData?: unknown
}

function parseHookOutput(stdout: string): ParsedHookOutput {
  const result: ParsedHookOutput = {}

  try {
    const lines = stdout.trim().split('\n')
    for (const line of lines) {
      if (!line.startsWith('{')) continue

      try {
        const parsed = JSON.parse(line)
        if (parsed.block === true) result.block = true
        if (typeof parsed.additionalContext === 'string') result.additionalContext = parsed.additionalContext
        if (parsed.mcpOutput && typeof parsed.mcpOutput === 'object') result.mcpOutput = parsed.mcpOutput
        if (parsed.modifiedData !== undefined) result.modifiedData = parsed.modifiedData
      } catch {
        // not JSON, skip
      }
    }
  } catch {
    // no structured output
  }

  return result
}

function matchHookMatcher(matcher: string, toolName: string): boolean {
  if (matcher === '*') return true
  if (matcher.includes('|')) return matcher.split('|').some(m => m.trim() === toolName)
  return matcher === toolName
}
