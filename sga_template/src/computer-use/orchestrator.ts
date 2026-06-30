import { chromium, type Browser, type Page } from 'playwright'
import { createLogger } from '../utils/logger.js'
import {
  type ComputerUseConfig,
  type ComputerUseSessionState,
  type ComputerUseAction,
  type ComputerUseResult,
  DEFAULT_COMPUTER_USE_CONFIG,
  isCanvasAction,
} from './types.js'
import { ActionExecutor } from './action-executor.js'

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
    if (this.state !== 'ready') {
      throw new Error(`Cannot execute action: session not ready (state: ${this.state})`)
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

  /** Called by the WS server when a canvas op response arrives. */
  setCanvasOpResponseHandler(handler: (response: unknown) => void): void {
    this.actionExecutor.setCanvasOpResponseHandler(handler)
  }
}
