import { chromium, type Browser, type Page } from 'playwright'
import { createLogger } from '../utils/logger.js'
import {
  type ComputerUseConfig,
  type ComputerUseSessionState,
  type ComputerUseAction,
  type ComputerUseResult,
  type ComputerUseAdapter,
  type StepEvent,
  DEFAULT_COMPUTER_USE_CONFIG,
  isCanvasAction,
} from './types.js'
import { ActionExecutor } from './action-executor.js'
import type { CanvasBridge } from './canvas-bridge.js'

const logger = createLogger('computer-use:orchestrator')

export interface OrchestratorStatus {
  state: ComputerUseSessionState
  browserConnected: boolean
  extensionConnected: boolean
  startedAt?: number
  config: ComputerUseConfig
}

export class ComputerUseOrchestrator {
  private config: ComputerUseConfig
  private state: ComputerUseSessionState = 'idle'
  private browser: Browser | null = null
  private page: Page | null = null
  private startedAt: number | undefined
  private actionExecutor: ActionExecutor
  private extensionConnected = false
  private sessionTimeoutHandle: NodeJS.Timeout | null = null
  private activeAdapter: ComputerUseAdapter | null = null
  private cancelRequested = false

  constructor(config?: Partial<ComputerUseConfig>) {
    this.config = { ...DEFAULT_COMPUTER_USE_CONFIG, ...config }
    this.actionExecutor = new ActionExecutor()
  }

  getStatus(): OrchestratorStatus {
    return {
      state: this.state,
      browserConnected: this.browser !== null,
      extensionConnected: this.extensionConnected,
      startedAt: this.startedAt,
      config: this.config,
    }
  }

  /**
   * Start the computer use session. NOT safe for concurrent invocation —
   * callers must await start() before calling stop() and vice versa.
   * Phase 1 should add a generation counter or mutex to serialize lifecycle ops.
   */
  async start(): Promise<void> {
    if (this.state === 'ready' || this.state === 'starting') {
      throw new Error(`Computer use session already running (state: ${this.state})`)
    }

    this.state = 'starting'
    logger.info(`Starting computer use session, navigating to ${this.config.comfyuiUrl}`)

    try {
      this.browser = await chromium.launch({
        headless: this.config.headless,
      })
      this.page = await this.browser.newPage()
      await this.page.goto(this.config.comfyuiUrl, { waitUntil: 'domcontentloaded' })

      // Wait briefly for the JS extension to connect via WS.
      // In Phase 1, the WS server will signal this; for Phase 0, we just wait.
      await this.page.waitForTimeout(2000)

      this.startedAt = Date.now()
      this.state = 'ready'

      // Set session timeout
      this.sessionTimeoutHandle = setTimeout(
        () => this.stop().catch(err => logger.error('Session timeout stop failed', err)),
        this.config.sessionTimeoutMs,
      )

      logger.info('Computer use session ready')
    } catch (error) {
      this.state = 'error'
      logger.error('Failed to start computer use session', error)
      await this.cleanup()
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') {
      return
    }

    // If a run is in progress, signal cancellation so the loop can
    // yield a 'stopped' event and break before we tear down the browser.
    if (this.state === 'running') {
      this.cancelRun()
      // Give the loop a brief window to observe the flag and exit gracefully.
      // The loop checks cancelRequested at the top of each iteration.
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    this.state = 'stopping'
    logger.info('Stopping computer use session')

    await this.cleanup()

    this.state = 'stopped'
    logger.info('Computer use session stopped')
  }

  private async cleanup(): Promise<void> {
    if (this.sessionTimeoutHandle) {
      clearTimeout(this.sessionTimeoutHandle)
      this.sessionTimeoutHandle = null
    }

    if (this.page) {
      try {
        await this.page.close()
      } catch (err) {
        logger.warn('Failed to close page', err)
      }
      this.page = null
    }

    if (this.browser) {
      try {
        await this.browser.close()
      } catch (err) {
        logger.warn('Failed to close browser', err)
      }
      this.browser = null
    }

    this.extensionConnected = false
  }

  async takeScreenshot(variant: 'full' | 'canvas' = 'full'): Promise<string> {
    if (!this.page) {
      throw new Error('Cannot take screenshot: browser not started (state: ' + this.state + ')')
    }

    const buffer = variant === 'canvas'
      ? await this.page.locator('#graph-canvas').screenshot()
      : await this.page.screenshot({ fullPage: true })

    return buffer.toString('base64')
  }

  async executeAction(action: ComputerUseAction): Promise<ComputerUseResult> {
    if (this.state !== 'ready' && this.state !== 'running') {
      throw new Error(`Cannot execute action: session not active (state: ${this.state})`)
    }

    // For Phase 0, only screenshot is fully implemented.
    // Canvas actions require the WS bridge (Phase 1).
    if (isCanvasAction(action)) {
      return this.actionExecutor.executeCanvasAction(action)
    }

    // Visual actions use Playwright
    return this.actionExecutor.executeVisualAction(action, this.page!)
  }

  /** Called by the WS server when the JS extension connects. */
  setExtensionConnected(connected: boolean): void {
    this.extensionConnected = connected
    logger.info(`JS extension ${connected ? 'connected' : 'disconnected'}`)
  }

  /** Called by the route handler to inject the canvas bridge for canvas actions. */
  setCanvasBridge(bridge: CanvasBridge): void {
    this.actionExecutor.setCanvasBridge(bridge)
  }

  /** Set the provider adapter for autopilot mode. */
  setActiveAdapter(adapter: ComputerUseAdapter): void {
    this.activeAdapter = adapter
    logger.info(`Active adapter set: ${adapter.name}`)
  }

  /** Get the active provider adapter (or null if none set). */
  getActiveAdapter(): ComputerUseAdapter | null {
    return this.activeAdapter
  }

  /** Request cancellation of the current autopilot run. */
  cancelRun(): void {
    this.cancelRequested = true
    logger.info('Run cancellation requested')
  }

  /**
   * Run the autopilot loop: screenshot → adapter → execute → feedback.
   * Yields StepEvents for real-time streaming.
   * Terminates on: done action, maxSteps, 3 consecutive failures, or cancel.
   */
  async *runGoal(
    goal: string,
    opts: { adapter: ComputerUseAdapter; maxSteps?: number },
  ): AsyncIterable<StepEvent> {
    if (this.state !== 'ready') {
      throw new Error(`Cannot run goal: session not ready (state: ${this.state})`)
    }

    const adapter = opts.adapter
    const maxSteps = Math.min(opts.maxSteps ?? 20, 50)
    let history = ''
    let consecutiveFailures = 0
    let step = 0

    this.state = 'running'
    this.cancelRequested = false
    logger.info(`Starting autopilot run: "${goal}" (max ${maxSteps} steps)`)

    try {
      while (step < maxSteps) {
        if (this.cancelRequested) {
          yield { step, type: 'stopped', timestamp: Date.now() }
          break
        }

        yield { step, type: 'step_start', timestamp: Date.now() }

        // 1. Take screenshot
        const screenshot = await this.takeScreenshot('full')
        yield { step, type: 'screenshot_taken', screenshot, timestamp: Date.now() }

        // 2. Ask adapter for next action
        const action = await adapter.sendScreenshotAndGetCurrentAction(screenshot, goal, history)
        yield { step, type: 'action_decided', action, timestamp: Date.now() }

        // 3. Check for terminal actions
        if (action.type === 'done') {
          yield { step, type: 'loop_done', summary: action.summary, timestamp: Date.now() }
          break
        }

        if (action.type === 'require_approval') {
          yield { step, type: 'approval_required', question: action.question, timestamp: Date.now() }
          // MVP: auto-stop on approval request
          break
        }

        if (action.type === 'run_goal') {
          yield { step, type: 'error', error: 'Nested run_goal not allowed', timestamp: Date.now() }
          break
        }

        // 4. Execute the action
        const result = await this.executeAction(action)
        yield { step, type: 'action_executed', action, result, timestamp: Date.now() }

        // 5. Track failures
        if (!result.success) {
          consecutiveFailures++
          if (consecutiveFailures >= 3) {
            yield {
              step,
              type: 'error',
              error: `Autopilot stopped: 3 consecutive failures`,
              timestamp: Date.now(),
            }
            break
          }
        } else {
          consecutiveFailures = 0
        }

        // 6. Accumulate feedback
        const feedback = adapter.interpretActionResult(result)
        history += `\nStep ${step + 1}: ${feedback}`

        yield { step, type: 'step_done', timestamp: Date.now() }
        step++
      }

      if (step >= maxSteps && !this.cancelRequested) {
        yield { step, type: 'loop_done', summary: `Max steps reached (${maxSteps})`, timestamp: Date.now() }
      }
    } finally {
      this.state = 'ready'
      this.cancelRequested = false
      logger.info(`Autopilot run ended after ${step} steps`)
    }
  }
}
