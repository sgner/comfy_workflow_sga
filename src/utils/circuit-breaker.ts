import { createLogger } from '../utils/logger.js'

const logger = createLogger('circuit-breaker')

export interface CircuitBreakerConfig {
  maxConsecutiveFailures: number
  cooldownMs: number
  halfOpenMaxAttempts: number
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  maxConsecutiveFailures: 3,
  cooldownMs: 5 * 60 * 1000,
  halfOpenMaxAttempts: 1,
}

export type CircuitState = 'closed' | 'open' | 'half_open'

export class CircuitBreaker {
  private consecutiveFailures = 0
  private lastFailureTime = 0
  private state: CircuitState = 'closed'
  private halfOpenAttempts = 0
  private config: CircuitBreakerConfig

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config }
  }

  getState(): CircuitState {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime
      if (elapsed >= this.config.cooldownMs) {
        this.state = 'half_open'
        this.halfOpenAttempts = 0
        logger.info('Circuit breaker entering half-open state')
      }
    }
    return this.state
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures
  }

  canExecute(): boolean {
    const state = this.getState()

    switch (state) {
      case 'closed':
        return true
      case 'open':
        return false
      case 'half_open':
        return this.halfOpenAttempts < this.config.halfOpenMaxAttempts
    }
  }

  recordSuccess(): void {
    if (this.state === 'half_open') {
      logger.info('Circuit breaker: half-open → closed (success)')
    }

    this.consecutiveFailures = 0
    this.state = 'closed'
    this.halfOpenAttempts = 0
  }

  recordFailure(error?: Error): void {
    this.consecutiveFailures++
    this.lastFailureTime = Date.now()

    if (this.state === 'half_open') {
      this.state = 'open'
      logger.warn(`Circuit breaker: half-open → open (failure: ${error?.message ?? 'unknown'})`)
      return
    }

    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.state = 'open'
      logger.warn(
        `Circuit breaker: closed → open (${this.consecutiveFailures} consecutive failures)` +
        (error ? ` — last error: ${error.message}` : ''),
      )
    }
  }

  reset(): void {
    this.consecutiveFailures = 0
    this.state = 'closed'
    this.halfOpenAttempts = 0
    this.lastFailureTime = 0
    logger.info('Circuit breaker reset')
  }

  getStats(): {
    state: CircuitState
    consecutiveFailures: number
    lastFailureTime: number
    timeUntilCooldown: number
  } {
    const state = this.getState()
    const elapsed = Date.now() - this.lastFailureTime
    const timeUntilCooldown = state === 'open'
      ? Math.max(0, this.config.cooldownMs - elapsed)
      : 0

    return {
      state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureTime: this.lastFailureTime,
      timeUntilCooldown,
    }
  }
}

export class CompactCircuitBreaker extends CircuitBreaker {
  constructor() {
    super({
      maxConsecutiveFailures: 3,
      cooldownMs: 5 * 60 * 1000,
      halfOpenMaxAttempts: 1,
    })
  }
}

export class ConsolidationCircuitBreaker extends CircuitBreaker {
  constructor() {
    super({
      maxConsecutiveFailures: 2,
      cooldownMs: 30 * 60 * 1000,
      halfOpenMaxAttempts: 1,
    })
  }
}
