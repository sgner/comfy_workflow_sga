import type { HookDefinition, HookEventType, HookResult, HookExecutionContext } from './types.js'

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

  constructor(registry: HookRegistry) {
    this.registry = registry
  }

  async execute(
    event: HookEventType,
    context: HookExecutionContext,
  ): Promise<HookResult[]> {
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

      if (!result.proceed) break
    }

    return results
  }

  private async executeHook(
    hook: HookDefinition,
    context: HookExecutionContext,
  ): Promise<HookResult> {
    try {
      const { execSync } = await import('child_process')
      const env = {
        ...process.env,
        CLAUDE_HOOK_EVENT: hook.event,
        CLAUDE_TOOL_NAME: context.toolName ?? '',
        CLAUDE_SESSION_ID: context.sessionId ?? '',
      }

      const stdout = execSync(hook.command, {
        timeout: hook.timeout ?? 30000,
        encoding: 'utf-8',
        env,
        cwd: context.cwd,
      })

      return {
        exitCode: 0,
        stdout,
        stderr: '',
        proceed: true,
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

function matchHookMatcher(matcher: string, toolName: string): boolean {
  if (matcher === '*') return true
  if (matcher.includes('|')) return matcher.split('|').some(m => m.trim() === toolName)
  return matcher === toolName
}
