export interface ModelInfo {
  id: string
  name: string
  maxTokens: number
  supportsVision: boolean
  supportsComputerUse: boolean
  supportsPromptCaching: boolean
  supportsStreaming: boolean
  costPerInputToken: number
  costPerOutputToken: number
}

export interface APIRequestOptions {
  model: string
  messages: Array<{
    role: 'system' | 'user' | 'assistant'
    content: string | Array<unknown>
  }>
  tools?: Array<{
    name: string
    description: string
    input_schema: Record<string, unknown>
  }>
  maxTokens?: number
  temperature?: number
  stream?: boolean
  signal?: AbortSignal
  systemPrompt?: Array<{
    type: 'text'
    text: string
    cache_control?: { type: 'ephemeral' }
  }>
  thinkingBudget?: number
}

export interface APIResponse {
  id: string
  model: string
  content: Array<{
    type: 'text' | 'tool_use'
    text?: string
    name?: string
    id?: string
    input?: Record<string, unknown>
  }>
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
  usage: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens?: number
    cacheReadInputTokens?: number
  }
}

export interface APIStreamChunk {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop'
  message?: APIResponse
  index?: number
  content_block?: {
    type: 'text' | 'tool_use'
    text?: string
    name?: string
    id?: string
  }
  delta?: {
    type: 'text_delta' | 'input_json_delta' | 'thinking_delta'
    text?: string
    partial_json?: string
    thinking?: string
    stop_reason?: string
  }
  usage?: {
    output_tokens: number
  }
}

export const MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-4-20250514',
  opus: 'claude-opus-4-20250514',
}

export const DEFAULT_MAX_TOKENS = 16384
export const DEFAULT_THINKING_BUDGET = 10000
