import { v4 as uuidv4 } from 'uuid'
import type { Message, UsageMetrics, PermissionMode } from '../core/types.js'
import type { PendingAction, SuspendedContext } from './interaction.js'

export interface SessionConfig {
  model?: string
  permissionMode?: PermissionMode
  maxTurns?: number
  maxBudgetUsd?: number
  systemPrompt?: string
  agentType?: string
  mcpServers?: Record<string, unknown>
  providerName?: string
}

export interface Session {
  id: string
  createdAt: number
  updatedAt: number
  config: SessionConfig
  messages: Message[]
  usage: UsageMetrics
  status: 'active' | 'paused' | 'waiting_input' | 'completed' | 'error'
  error?: string
  pendingAction?: PendingAction
  suspendedContext?: SuspendedContext
}

export interface CreateSessionRequest {
  model?: string
  permissionMode?: PermissionMode
  maxTurns?: number
  maxBudgetUsd?: number
  systemPrompt?: string
  agentType?: string
  mcpServers?: Record<string, unknown>
  providerName?: string
}

export interface SendMessageRequest {
  content: string
  stream?: boolean | string
  agentType?: string
  providerName?: string
  model?: string
}

export interface UserInputRequest {
  actionId: string
  decision?: 'allow' | 'deny'
  value?: string
  optionValue?: string
  updatedInput?: Record<string, unknown>
  reason?: string
}

export interface SendMessageResponse {
  sessionId: string
  content: string
  usage: UsageMetrics
  messages: Message[]
  waitingForInput?: boolean
  pendingActionId?: string
}

export interface StreamEventPayload {
  type: 'text_delta' | 'tool_use_start' | 'tool_use_result' | 'thinking_delta' | 'turn_end' | 'error' | 'done' | 'approval_required' | 'human_input_required'
  data: unknown
}

export function createSession(config: SessionConfig = {}): Session {
  return {
    id: uuidv4(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config,
    messages: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    },
    status: 'active',
  }
}

export function addMessageToSession(session: Session, message: Message): Session {
  session.messages.push(message)
  session.updatedAt = Date.now()
  return session
}

export function updateSessionUsage(session: Session, usage: UsageMetrics): Session {
  session.usage = {
    inputTokens: session.usage.inputTokens + usage.inputTokens,
    outputTokens: session.usage.outputTokens + usage.outputTokens,
    cacheReadInputTokens: session.usage.cacheReadInputTokens + usage.cacheReadInputTokens,
    cacheCreationInputTokens: session.usage.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    totalTokens: session.usage.totalTokens + usage.totalTokens,
    totalCostUsd: session.usage.totalCostUsd + usage.totalCostUsd,
  }
  session.updatedAt = Date.now()
  return session
}

export function setSessionWaitingInput(session: Session, action: PendingAction, context: SuspendedContext): Session {
  session.status = 'waiting_input'
  session.pendingAction = action
  session.suspendedContext = context
  session.updatedAt = Date.now()
  return session
}

export function clearSessionWaitingInput(session: Session): Session {
  session.status = 'active'
  session.pendingAction = undefined
  session.suspendedContext = undefined
  session.updatedAt = Date.now()
  return session
}
