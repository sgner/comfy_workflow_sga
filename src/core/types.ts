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

export type ToolProgressData =
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | { type: 'progress'; message: string; percentage?: number }
  | { type: 'status'; message: string }
  | { type: 'custom'; [key: string]: unknown }

export type BashProgressData =
  | ToolProgressData
  | { type: 'bash_progress'; output: string; fullOutput: string; elapsedTimeSeconds: number; totalLines: number; totalBytes: number; taskId?: string; timeoutMs?: number }

export type AgentStreamEvent =
  | { type: 'session_start'; sessionId: string; model: string; agentType?: string }
  | { type: 'turn_start'; turnCount: number }
  | { type: 'api_call_start'; turnCount: number }
  | { type: 'stream_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; toolName: string; toolUseId: string }
  | { type: 'tool_progress'; toolName: string; toolUseId: string; data: ToolProgressData; parentToolUseId?: string }
  | { type: 'tool_use_end'; toolName: string; toolUseId: string; isError: boolean }
  | { type: 'tool_use_result'; toolName: string; result: { toolUseId: string; content: string; isError: boolean } }
  | { type: 'turn_end'; turnCount: number; usage: UsageMetrics }
  | { type: 'approval_required'; actionId: string; toolName: string; toolInput: Record<string, unknown>; toolCallId: string; message: string; suggestions?: string[] }
  | { type: 'human_input_required'; actionId: string; message: string; context?: string; options?: Array<{ label: string; value: string; description?: string }> }
  | { type: 'compact_start'; reason: string }
  | { type: 'compact_end'; messagesRemoved: number }
  | { type: 'task_started'; taskId: string; description: string; taskType?: string; toolUseId?: string }
  | { type: 'task_progress'; taskId: string; description: string; usage: { totalTokens: number; toolUses: number; durationMs: number }; lastToolName?: string; summary?: string }
  | { type: 'task_notification'; taskId: string; toolUseId?: string; status: 'completed' | 'failed' | 'stopped'; summary: string }
  | { type: 'recovery'; error: Error; attempt: number }
  | { type: 'stop'; reason: StopReason }
  | { type: 'done'; data: { content: string; usage: UsageMetrics } | null }
  | { type: 'error'; data: string }

export type SSEEventType = AgentStreamEvent['type']

export interface SSEEvent<T extends AgentStreamEvent = AgentStreamEvent> {
  event: SSEEventType
  data: T
  id?: string
  retry?: number
}
