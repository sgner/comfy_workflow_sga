import type { Message } from '../../core/types.js'
import type { LLMProvider } from '../../providers/types.js'
import { microCompactMessages, type MicroCompactConfig, type MicroCompactResult, DEFAULT_MICRO_COMPACT_CONFIG } from './micro-compact.js'
import { sessionMemoryCompact, type SessionMemoryCompactConfig, type SessionMemoryCompactResult, DEFAULT_SM_COMPACT_CONFIG } from './session-memory-compact.js'
import { compactConversation, shouldAutoCompact, calculateTokenWarningState, type FullCompactConfig, type CompactSummaryResult, DEFAULT_FULL_COMPACT_CONFIG } from './full-compact.js'
import { estimateMessageTokens } from './micro-compact.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('auto-compact')

export type CompactStrategy = 'micro' | 'session_memory' | 'full'

export interface AutoCompactConfig {
  micro: MicroCompactConfig
  sessionMemory: SessionMemoryCompactConfig
  full: FullCompactConfig
  modelMaxTokens: number
  preferSessionMemory: boolean
}

export const DEFAULT_AUTO_COMPACT_CONFIG: AutoCompactConfig = {
  micro: DEFAULT_MICRO_COMPACT_CONFIG,
  sessionMemory: DEFAULT_SM_COMPACT_CONFIG,
  full: DEFAULT_FULL_COMPACT_CONFIG,
  modelMaxTokens: 200_000,
  preferSessionMemory: true,
}

export interface AutoCompactResult {
  strategy: CompactStrategy
  messages: Message[]
  microResult?: MicroCompactResult
  smResult?: SessionMemoryCompactResult
  fullResult?: CompactSummaryResult
  wasCompacted: boolean
  consecutiveFailures: number
}

export class AutoCompactor {
  private config: AutoCompactConfig
  private consecutiveFailures = 0

  constructor(config: Partial<AutoCompactConfig> = {}) {
    this.config = { ...DEFAULT_AUTO_COMPACT_CONFIG, ...config }
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures
  }

  getTokenWarningState(tokenUsage: number) {
    return calculateTokenWarningState(tokenUsage, this.config.modelMaxTokens, this.config.full)
  }

  async compactIfNeeded(
    messages: Message[],
    provider?: LLMProvider,
    model?: string,
    sessionMemoryContent?: string,
  ): Promise<AutoCompactResult> {
    if (this.consecutiveFailures >= this.config.full.maxConsecutiveFailures) {
      logger.warn(`Auto-compact circuit breaker: ${this.consecutiveFailures} consecutive failures, skipping`)
      return { strategy: 'micro', messages, wasCompacted: false, consecutiveFailures: this.consecutiveFailures }
    }

    const microResult = microCompactMessages(messages, this.config.micro)
    if (microResult.trigger !== 'none' && microResult.tokensSaved > 0) {
      logger.info(`Micro-compact saved ≈${microResult.tokensSaved} tokens`)
      return {
        strategy: 'micro',
        messages: microResult.messages,
        microResult,
        wasCompacted: true,
        consecutiveFailures: this.consecutiveFailures,
      }
    }

    if (!shouldAutoCompact(messages, this.config.modelMaxTokens, this.config.full)) {
      return { strategy: 'micro', messages, wasCompacted: false, consecutiveFailures: this.consecutiveFailures }
    }

    if (this.config.preferSessionMemory && sessionMemoryContent?.trim()) {
      const smResult = sessionMemoryCompact(messages, sessionMemoryContent, this.config.sessionMemory)
      if (smResult) {
        this.consecutiveFailures = 0
        const compactedMessages = [smResult.summaryMessage, ...smResult.messagesToKeep]
        return {
          strategy: 'session_memory',
          messages: compactedMessages,
          smResult,
          wasCompacted: true,
          consecutiveFailures: 0,
        }
      }
    }

    if (provider && model) {
      try {
        const fullResult = await compactConversation(
          messages,
          provider,
          model,
          this.config.full,
          undefined,
          true,
        )
        this.consecutiveFailures = 0
        const compactedMessages = [fullResult.summaryMessage, ...fullResult.messagesToKeep]
        return {
          strategy: 'full',
          messages: compactedMessages,
          fullResult,
          wasCompacted: true,
          consecutiveFailures: 0,
        }
      } catch (error) {
        this.consecutiveFailures++
        logger.warn(`Full compact failed (attempt ${this.consecutiveFailures}): ${error instanceof Error ? error.message : String(error)}`)
        return {
          strategy: 'full',
          messages,
          wasCompacted: false,
          consecutiveFailures: this.consecutiveFailures,
        }
      }
    }

    return { strategy: 'micro', messages, wasCompacted: false, consecutiveFailures: this.consecutiveFailures }
  }
}

export { microCompactMessages, sessionMemoryCompact, compactConversation, shouldAutoCompact, estimateMessageTokens }
export type { MicroCompactConfig, MicroCompactResult, SessionMemoryCompactConfig, SessionMemoryCompactResult, FullCompactConfig, CompactSummaryResult }
