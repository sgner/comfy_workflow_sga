import type { Page } from 'playwright'
import { createLogger } from '../utils/logger.js'
import type { ComputerUseAction, ComputerUseResult } from './types.js'

const logger = createLogger('computer-use:action-executor')

export class ActionExecutor {
  private canvasOpResponseHandler: ((response: unknown) => void) | null = null
  private bridgeConnected = false

  /** Execute a visual/UI action via Playwright. */
  async executeVisualAction(
    action: ComputerUseAction,
    page: Page,
  ): Promise<ComputerUseResult> {
    switch (action.type) {
      case 'screenshot': {
        const buffer = action.variant === 'canvas'
          ? await page.locator('#graph-canvas').screenshot()
          : await page.screenshot({ fullPage: true })
        return {
          success: true,
          screenshot: buffer.toString('base64'),
          action,
        }
      }

      case 'click':
      case 'type':
      case 'scroll':
      case 'drag':
      case 'key':
      case 'wait':
        // Phase 3 — not implemented yet
        return {
          success: false,
          error: `Visual action "${action.type}" not implemented (Phase 3)`,
          action,
        }

      default:
        return {
          success: false,
          error: `Unknown visual action type: ${(action as ComputerUseAction).type}`,
          action,
        }
    }
  }

  /** Execute a canvas action via the JS extension WS bridge. */
  async executeCanvasAction(action: ComputerUseAction): Promise<ComputerUseResult> {
    if (!this.bridgeConnected) {
      return {
        success: false,
        error: 'Canvas bridge not connected (JS extension WS not available)',
        action,
      }
    }

    // Phase 1 will implement the actual WS round-trip here.
    // For now, this is a stub that returns not-implemented.
    return {
      success: false,
      error: `Canvas action "${action.type}" not yet wired to WS bridge`,
      action,
    }
  }

  setBridgeConnected(connected: boolean): void {
    this.bridgeConnected = connected
    logger.info(`Canvas bridge ${connected ? 'connected' : 'disconnected'}`)
  }

  setCanvasOpResponseHandler(handler: (response: unknown) => void): void {
    this.canvasOpResponseHandler = handler
  }
}
