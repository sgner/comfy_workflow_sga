import type { Page } from 'playwright'
import { createLogger } from '../utils/logger.js'
import type { ComputerUseAction, ComputerUseResult } from './types.js'
import type { CanvasBridge } from './canvas-bridge.js'

const logger = createLogger('computer-use:action-executor')

export class ActionExecutor {
  private canvasBridge: CanvasBridge | null = null

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
    if (!this.canvasBridge || !this.canvasBridge.isConnected) {
      return {
        success: false,
        error: 'Canvas bridge not connected (JS extension WS not available)',
        action,
      }
    }

    try {
      const data = await this.canvasBridge.executeAction(action)
      return {
        success: true,
        data,
        action,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        action,
      }
    }
  }

  setCanvasBridge(bridge: CanvasBridge): void {
    this.canvasBridge = bridge
    logger.info('Canvas bridge set')
  }
}
