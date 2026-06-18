import { CostTracker } from '../utils/cost-tracker.js'
import type { UsageMetrics } from '../core/types.js'
import type { ComfyUICostReport } from './types.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('comfyui-cost-manager')

export class ComfyUICostManager {
  private tracker: CostTracker
  private _abortController: AbortController | null = null

  constructor(maxBudgetUsd?: number) {
    this.tracker = new CostTracker({ maxBudgetUsd })
  }

  recordUsage(usage: UsageMetrics): void {
    this.tracker.addUsage({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
    })
  }

  shouldContinue(): boolean {
    if (this.tracker.isOverBudget()) {
      const report = this.tracker.getUsageReport()
      logger.warn(`Budget exceeded. ${report}`)
      return false
    }
    if (this.tracker.isNearBudget()) {
      logger.warn(`Approaching budget limit: $${this.tracker.getTotalCostUsd().toFixed(4)}`)
    }
    return true
  }

  getOverBudgetMessage(): string {
    const report = this.tracker.getUsageReport()
    return `[Budget Exceeded] Session has reached the spending limit.\n\n${report}`
  }

  getReport(): ComfyUICostReport {
    return {
      totalCostUsd: this.tracker.getTotalCostUsd(),
      totalInputTokens: this.tracker.getTotalInputTokens(),
      totalOutputTokens: this.tracker.getTotalOutputTokens(),
      isOverBudget: this.tracker.isOverBudget(),
      isNearBudget: this.tracker.isNearBudget(),
      remainingBudget: this.tracker.getRemainingBudget(),
      report: this.tracker.getUsageReport(),
    }
  }

  setAbortController(controller: AbortController): void {
    this._abortController = controller
  }

  abortIfOverBudget(): void {
    if (this.tracker.isOverBudget() && this._abortController) {
      logger.warn('Aborting agent run due to budget exceeded')
      this._abortController.abort()
    }
  }

  reset(): void {
    this.tracker.reset()
  }
}
