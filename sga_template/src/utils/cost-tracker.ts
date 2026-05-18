export interface CostTrackerConfig {
  maxBudgetUsd?: number
  warnAtPercent?: number
}

export class CostTracker {
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private totalCacheCreationTokens = 0
  private totalCacheReadTokens = 0
  private costPerInputToken: number
  private costPerOutputToken: number
  private costPerCacheCreationToken: number
  private costPerCacheReadToken: number
  private maxBudgetUsd: number | undefined
  private warnAtPercent: number

  constructor(config: CostTrackerConfig & {
    costPerInputToken?: number
    costPerOutputToken?: number
    costPerCacheCreationToken?: number
    costPerCacheReadToken?: number
  } = {}) {
    this.costPerInputToken = config.costPerInputToken ?? 0.000003
    this.costPerOutputToken = config.costPerOutputToken ?? 0.000015
    this.costPerCacheCreationToken = config.costPerCacheCreationToken ?? 0.00000375
    this.costPerCacheReadToken = config.costPerCacheReadToken ?? 0.0000003
    this.maxBudgetUsd = config.maxBudgetUsd
    this.warnAtPercent = config.warnAtPercent ?? 80
  }

  addUsage(usage: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens?: number
    cacheReadInputTokens?: number
  }): void {
    this.totalInputTokens += usage.inputTokens
    this.totalOutputTokens += usage.outputTokens
    this.totalCacheCreationTokens += usage.cacheCreationInputTokens ?? 0
    this.totalCacheReadTokens += usage.cacheReadInputTokens ?? 0
  }

  getTotalCostUsd(): number {
    return (
      this.totalInputTokens * this.costPerInputToken +
      this.totalOutputTokens * this.costPerOutputToken +
      this.totalCacheCreationTokens * this.costPerCacheCreationToken +
      this.totalCacheReadTokens * this.costPerCacheReadToken
    )
  }

  getTotalInputTokens(): number {
    return this.totalInputTokens
  }

  getTotalOutputTokens(): number {
    return this.totalOutputTokens
  }

  isOverBudget(): boolean {
    if (!this.maxBudgetUsd) return false
    return this.getTotalCostUsd() >= this.maxBudgetUsd
  }

  isNearBudget(): boolean {
    if (!this.maxBudgetUsd) return false
    return (this.getTotalCostUsd() / this.maxBudgetUsd) * 100 >= this.warnAtPercent
  }

  getRemainingBudget(): number | undefined {
    if (!this.maxBudgetUsd) return undefined
    return Math.max(0, this.maxBudgetUsd - this.getTotalCostUsd())
  }

  getUsageReport(): string {
    const cost = this.getTotalCostUsd()
    const lines = [
      `Input tokens: ${this.totalInputTokens.toLocaleString()}`,
      `Output tokens: ${this.totalOutputTokens.toLocaleString()}`,
      `Cache creation tokens: ${this.totalCacheCreationTokens.toLocaleString()}`,
      `Cache read tokens: ${this.totalCacheReadTokens.toLocaleString()}`,
      `Total cost: $${cost.toFixed(4)}`,
    ]
    if (this.maxBudgetUsd) {
      lines.push(`Budget: $${this.maxBudgetUsd.toFixed(2)}`)
      lines.push(`Remaining: $${this.getRemainingBudget()?.toFixed(4)}`)
    }
    return lines.join('\n')
  }

  reset(): void {
    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.totalCacheCreationTokens = 0
    this.totalCacheReadTokens = 0
  }
}
