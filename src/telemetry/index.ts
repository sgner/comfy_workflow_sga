import { createLogger } from '../utils/logger.js'

const logger = createLogger('telemetry')

export interface TelemetryEvent {
  name: string
  properties: Record<string, unknown>
  timestamp: number
  sessionId?: string
}

export interface TelemetryExporter {
  export(events: TelemetryEvent[]): Promise<void>
  flush?(): Promise<void>
}

class ConsoleExporter implements TelemetryExporter {
  async export(events: TelemetryEvent[]): Promise<void> {
    for (const event of events) {
      logger.debug(`[Telemetry] ${event.name}`, event.properties)
    }
  }
}

class NoOpExporter implements TelemetryExporter {
  async export(): Promise<void> {}
}

export class TelemetryManager {
  private static instance: TelemetryManager | null = null
  private exporters: TelemetryExporter[] = []
  private eventQueue: TelemetryEvent[] = []
  private flushInterval: ReturnType<typeof setInterval> | null = null
  private enabled: boolean = true
  private sessionId: string

  private constructor() {
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  static getInstance(): TelemetryManager {
    if (!TelemetryManager.instance) {
      TelemetryManager.instance = new TelemetryManager()
    }
    return TelemetryManager.instance
  }

  enable(): void {
    this.enabled = true
  }

  disable(): void {
    this.enabled = false
  }

  isEnabled(): boolean {
    return this.enabled
  }

  addExporter(exporter: TelemetryExporter): void {
    this.exporters.push(exporter)
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId
  }

  trackEvent(name: string, properties: Record<string, unknown> = {}): void {
    if (!this.enabled) return

    const event: TelemetryEvent = {
      name,
      properties,
      timestamp: Date.now(),
      sessionId: this.sessionId,
    }

    this.eventQueue.push(event)

    if (this.eventQueue.length >= 50) {
      this.flush()
    }
  }

  trackToolUse(toolName: string, durationMs: number, success: boolean, errorCategory?: string): void {
    this.trackEvent('tool_use', {
      toolName,
      durationMs,
      success,
      errorCategory,
    })
  }

  trackAgentRun(agentType: string, durationMs: number, success: boolean, tokenUsage?: { input: number; output: number }): void {
    this.trackEvent('agent_run', {
      agentType,
      durationMs,
      success,
      inputTokens: tokenUsage?.input,
      outputTokens: tokenUsage?.output,
    })
  }

  trackPermissionDecision(toolName: string, decision: string, ruleId?: string): void {
    this.trackEvent('permission_decision', {
      toolName,
      decision,
      ruleId,
    })
  }

  trackHookExecution(event: string, toolName: string, proceed: boolean, durationMs: number): void {
    this.trackEvent('hook_execution', {
      hookEvent: event,
      toolName,
      proceed,
      durationMs,
    })
  }

  trackCacheHit(hit: boolean, cacheType: string): void {
    this.trackEvent('cache', {
      hit,
      cacheType,
    })
  }

  trackError(category: string, message: string, context?: Record<string, unknown>): void {
    this.trackEvent('error', {
      category,
      message: message.slice(0, 200),
      ...context,
    })
  }

  startAutoFlush(intervalMs: number = 30000): void {
    if (this.flushInterval) return
    this.flushInterval = setInterval(() => this.flush(), intervalMs)
  }

  stopAutoFlush(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval)
      this.flushInterval = null
    }
  }

  async flush(): Promise<void> {
    if (this.eventQueue.length === 0) return

    const events = [...this.eventQueue]
    this.eventQueue = []

    for (const exporter of this.exporters) {
      try {
        await exporter.export(events)
      } catch (error) {
        logger.warn(`Telemetry exporter failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  static reset(): void {
    if (TelemetryManager.instance) {
      TelemetryManager.instance.stopAutoFlush()
      TelemetryManager.instance.flush()
    }
    TelemetryManager.instance = null
  }
}

export function initTelemetry(options?: { enabled?: boolean; exporters?: TelemetryExporter[] }): TelemetryManager {
  const manager = TelemetryManager.getInstance()

  if (options?.enabled === false) {
    manager.disable()
  }

  if (options?.exporters) {
    for (const exporter of options.exporters) {
      manager.addExporter(exporter)
    }
  } else if (manager.isEnabled()) {
    manager.addExporter(new ConsoleExporter())
  }

  manager.startAutoFlush()
  return manager
}

export { ConsoleExporter, NoOpExporter }
