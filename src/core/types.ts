export interface MessageContent {
  type: 'text' | 'image' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | MessageContent[]
  is_error?: boolean
}

export interface BaseMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: MessageContent[]
  timestamp: number
  metadata?: Record<string, unknown>
}

export type UserMessage = BaseMessage & { role: 'user' }
export type AssistantMessage = BaseMessage & { role: 'assistant' }
export type SystemMessage = BaseMessage & { role: 'system' }
export type Message = UserMessage | AssistantMessage | SystemMessage

export type ContentBlock = MessageContent
export type TextBlock = MessageContent & { type: 'text'; text: string }
export type ToolUseBlock = MessageContent & { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export type ToolResultBlock = MessageContent & { type: 'tool_result'; tool_use_id: string; content: string | MessageContent[] }
export type ThinkingBlock = MessageContent & { type: 'text'; text: string; thinking?: boolean }

export interface StreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop'
  message?: unknown
  index?: number
  content_block?: MessageContent
  delta?: { type: string; text?: string; partial_json?: string; stop_reason?: string }
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

export interface UsageMetrics {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
  totalCostUsd: number
}

export interface AgentId {
  id: string
  name?: string
  type?: string
}

export interface SessionId {
  id: string
  createdAt: number
}

export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'auto'
  | 'bubble'
  | 'dontAsk'

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max'

export interface ThinkingConfig {
  type: 'enabled' | 'disabled'
  budget_tokens?: number
  effort?: ThinkingEffort
}

export type ModelAlias = 'haiku' | 'sonnet' | 'opus' | string

export interface ModelConfig {
  model: string
  maxTokens?: number
  thinkingConfig?: ThinkingConfig
  temperature?: number
  topP?: number
  stopSequences?: string[]
}

export type ContinueReason =
  | { reason: 'next_turn' }
  | { reason: 'tool_use'; toolName: string }
  | { reason: 'recovery'; error: Error }
  | { reason: 'compact'; compactedMessages: Message[] }

export type StopReason =
  | { reason: 'end_turn' }
  | { reason: 'max_tokens' }
  | { reason: 'stop_sequence' }
  | { reason: 'tool_use' }
  | { reason: 'cancelled' }
  | { reason: 'error'; error: Error }

export interface QuerySource {
  source: string
  label?: string
}

export type AgentEvent =
  | { type: 'turn_start'; turnCount: number }
  | { type: 'turn_end'; turnCount: number }
  | { type: 'tool_use'; toolName: string }
  | { type: 'stop'; reason: StopReason }
