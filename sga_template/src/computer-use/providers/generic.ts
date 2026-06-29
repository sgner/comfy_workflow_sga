import type { ComputerUseAction, ComputerUseResult } from '../types.js'

/**
 * Generic fallback provider adapter.
 *
 * Placeholder — full implementation is Phase 3 (out of scope for this plan).
 * Throws to make clear it's not yet available.
 */
export class GenericComputerUseAdapter {
  readonly name = 'generic'

  async sendScreenshotAndGetCurrentAction(
    _screenshotBase64: string,
    _instructions: string,
  ): Promise<ComputerUseAction> {
    throw new Error('GenericComputerUseAdapter not implemented (Phase 3)')
  }

  async interpretActionResult(_result: ComputerUseResult): Promise<string> {
    throw new Error('GenericComputerUseAdapter not implemented (Phase 3)')
  }
}
