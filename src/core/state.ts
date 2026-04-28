import type { Message, UsageMetrics, ContinueReason, StopReason, ThinkingConfig, ModelAlias, PermissionMode, AgentId } from './types.js'

export interface AgentState {
  messages: Message[]
  turnCount: number
  usage: UsageMetrics
  transition: ContinueReason | undefined
  stopReason: StopReason | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  pendingToolUseSummary: Promise<string | null> | null
  stopHookActive: boolean
  maxOutputTokensOverride: number | undefined
}

export function createInitialState(messages: Message[] = []): AgentState {
  return {
    messages,
    turnCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    },
    transition: undefined,
    stopReason: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    pendingToolUseSummary: null,
    stopHookActive: false,
    maxOutputTokensOverride: undefined,
  }
}

export function transitionState(prev: AgentState, updates: Partial<AgentState>): AgentState {
  return { ...prev, ...updates }
}
