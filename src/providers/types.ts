export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ProviderContentBlock[]
}

export interface ProviderContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | ProviderContentBlock[]
  is_error?: boolean
}

export interface ProviderToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface ProviderRequestOptions {
  model: string
  messages: ProviderMessage[]
  tools?: ProviderToolDefinition[]
  maxTokens?: number
  temperature?: number
  stream?: boolean
  signal?: AbortSignal
  systemPrompt?: string | ProviderSystemPromptBlock[]
  thinkingBudget?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
}

export interface ProviderSystemPromptBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

export interface ProviderResponse {
  id: string
  model: string
  content: ProviderContentBlock[]
  stopReason: string
  usage: ProviderUsage
}

export interface ProviderUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

export interface ProviderStreamChunk {
  type: string
  index?: number
  contentBlock?: ProviderContentBlock
  delta?: {
    type: string
    text?: string
    partialJson?: string
    thinking?: string
    stopReason?: string
  }
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
  raw?: unknown
}

export interface ModelConfig {
  id: string
  displayName?: string
  contextWindow?: number
  maxOutputTokens?: number
  inputPricePerMToken?: number
  outputPricePerMToken?: number
  supportsVision?: boolean
  supportsToolUse?: boolean
  supportsStreaming?: boolean
  supportsThinking?: boolean
  supportsReasoningEffort?: boolean
  defaultMaxTokens?: number
  defaultTemperature?: number
  maxTemperature?: number
  thinkingBudget?: number
  baseUrl?: string
  streamingBaseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
  extra?: Record<string, unknown>
}

export type RequestTransformer = (
  body: Record<string, unknown>,
  headers: Record<string, string>,
) => { body: Record<string, unknown>; headers: Record<string, string> }

export type ResponseTransformer = (
  response: Record<string, unknown>,
) => Record<string, unknown>

export type StreamChunkTransformer = (
  chunk: Record<string, unknown>,
) => Record<string, unknown>

export interface ProviderExtension {
  providerModule?: string
  requestTransformer?: string
  responseTransformer?: string
  streamChunkTransformer?: string
}

export interface ProviderConfig {
  name: string
  apiKey: string
  baseUrl: string
  models?: Record<string, string>
  modelConfigs?: Record<string, ModelConfig>
  defaultModel?: string
  defaultMaxTokens?: number
  defaultTemperature?: number
  retries?: number
  retryDelay?: number
  headers?: Record<string, string>
  extra?: Record<string, unknown>
  extension?: ProviderExtension
}

export interface LLMProvider {
  readonly name: string
  readonly config: ProviderConfig

  createMessage(options: ProviderRequestOptions): Promise<ProviderResponse>
  createStreamingMessage(options: ProviderRequestOptions): AsyncGenerator<ProviderStreamChunk>
  resolveModel(model: string): string
  getModelConfig(model: string): ModelConfig | undefined
  validateConfig(): boolean
}
