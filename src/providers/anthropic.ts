import type {
  LLMProvider,
  ProviderConfig,
  ProviderRequestOptions,
  ProviderResponse,
  ProviderStreamChunk,
  ProviderContentBlock,
  ProviderUsage,
  ModelConfig,
  ProviderSystemPromptBlock,
} from './types.js'

export const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-4-20250514',
  opus: 'claude-opus-4-20250514',
}

export const ANTHROPIC_DEFAULT_MAX_TOKENS = 16384

export const ANTHROPIC_MODEL_CONFIGS: Record<string, ModelConfig> = {
  sonnet: {
    id: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4',
    contextWindow: 200000,
    maxOutputTokens: 16384,
    inputPricePerMToken: 3,
    outputPricePerMToken: 15,
    supportsVision: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: true,
    defaultMaxTokens: 16384,
    defaultTemperature: 0,
  },
  haiku: {
    id: 'claude-haiku-4-20250514',
    displayName: 'Claude Haiku 4',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    inputPricePerMToken: 0.8,
    outputPricePerMToken: 4,
    supportsVision: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: false,
    defaultMaxTokens: 8192,
    defaultTemperature: 0,
  },
  opus: {
    id: 'claude-opus-4-20250514',
    displayName: 'Claude Opus 4',
    contextWindow: 200000,
    maxOutputTokens: 16384,
    inputPricePerMToken: 15,
    outputPricePerMToken: 75,
    supportsVision: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: true,
    defaultMaxTokens: 16384,
    defaultTemperature: 0,
  },
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly config: ProviderConfig
  private promptHashCache: Map<string, string> = new Map()

  constructor(config: Omit<ProviderConfig, 'name'> & { name?: string }) {
    this.config = {
      name: 'anthropic',
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.anthropic.com/v1',
      models: config.models ?? ANTHROPIC_MODEL_ALIASES,
      modelConfigs: config.modelConfigs ?? ANTHROPIC_MODEL_CONFIGS,
      defaultModel: config.defaultModel ?? 'sonnet',
      defaultMaxTokens: config.defaultMaxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      defaultTemperature: config.defaultTemperature,
      retries: config.retries ?? 2,
      retryDelay: config.retryDelay ?? 1000,
      headers: config.headers,
      extra: config.extra,
    }
  }

  resolveModel(model: string): string {
    if (this.config.modelConfigs?.[model]) {
      return this.config.modelConfigs[model].id
    }
    return this.config.models?.[model] ?? ANTHROPIC_MODEL_ALIASES[model] ?? model
  }

  getModelConfig(model: string): ModelConfig | undefined {
    if (this.config.modelConfigs?.[model]) {
      return this.config.modelConfigs[model]
    }
    const resolvedId = this.config.models?.[model] ?? ANTHROPIC_MODEL_ALIASES[model]
    if (resolvedId) {
      for (const mc of Object.values(this.config.modelConfigs ?? ANTHROPIC_MODEL_CONFIGS)) {
        if (mc.id === resolvedId) return mc
      }
    }
    return undefined
  }

  validateConfig(): boolean {
    return !!this.config.apiKey
  }

  private resolveRequestConfig(model: string, stream: boolean): {
    baseUrl: string
    apiKey: string
    headers: Record<string, string>
  } {
    const modelConfig = this.getModelConfig(model)
    const rawBaseUrl = stream
      ? (modelConfig?.streamingBaseUrl ?? modelConfig?.baseUrl ?? this.config.baseUrl)
      : (modelConfig?.baseUrl ?? this.config.baseUrl)
    const baseUrl = this.normalizeBaseUrl(rawBaseUrl)
    const apiKey = modelConfig?.apiKey ?? this.config.apiKey
    const headers = { ...this.config.headers, ...modelConfig?.headers }
    return { baseUrl, apiKey, headers }
  }

  private normalizeBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/$/, '')
    if (trimmed.endsWith('/messages')) {
      return trimmed.slice(0, -'/messages'.length)
    }
    return trimmed
  }

  async createMessage(options: ProviderRequestOptions): Promise<ProviderResponse> {
    const model = this.resolveModel(options.model)
    const modelConfig = this.getModelConfig(options.model)
    const maxTokens = options.maxTokens ?? modelConfig?.defaultMaxTokens ?? this.config.defaultMaxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: options.messages,
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools
    }
    if (options.temperature !== undefined) {
      body.temperature = options.temperature
    }
    if (options.systemPrompt) {
      body.system = this.applyCacheBreakpoints(options.systemPrompt)
    }
    if (options.thinkingBudget) {
      body.thinking = { type: 'enabled', budget_tokens: options.thinkingBudget }
    }

    const reqConfig = this.resolveRequestConfig(options.model, false)

    const retries = this.config.retries ?? 2
    const retryDelay = this.config.retryDelay ?? 1000
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(`${reqConfig.baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': reqConfig.apiKey,
            'anthropic-version': '2023-06-01',
            ...reqConfig.headers,
          },
          body: JSON.stringify(body),
          signal: options.signal,
        })

        if (!response.ok) {
          const errorBody = await response.text()
          throw new ProviderRequestError(response.status, errorBody, this.name)
        }

        const data = await response.json() as AnthropicRawResponse
        return this.normalizeResponse(data)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < retries && !(error instanceof ProviderRequestError && error.status < 500)) {
          await sleep(retryDelay * (attempt + 1))
          continue
        }
      }
    }

    throw lastError ?? new Error('Unknown API error')
  }

  async *createStreamingMessage(options: ProviderRequestOptions): AsyncGenerator<ProviderStreamChunk> {
    const model = this.resolveModel(options.model)
    const modelConfig = this.getModelConfig(options.model)
    const maxTokens = options.maxTokens ?? modelConfig?.defaultMaxTokens ?? this.config.defaultMaxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: options.messages,
      stream: true,
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools
    }
    if (options.systemPrompt) {
      body.system = this.applyCacheBreakpoints(options.systemPrompt)
    }
    if (options.thinkingBudget) {
      body.thinking = { type: 'enabled', budget_tokens: options.thinkingBudget }
    }

    const reqConfig = this.resolveRequestConfig(options.model, true)

    const response = await fetch(`${reqConfig.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': reqConfig.apiKey,
        'anthropic-version': '2023-06-01',
        ...reqConfig.headers,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })

    if (!response.ok) {
      const errorBody = await response.text()
      throw new ProviderRequestError(response.status, errorBody, this.name)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data === '[DONE]') return
          try {
            const raw = JSON.parse(data)
            yield this.normalizeStreamChunk(raw)
          } catch {
            continue
          }
        }
      }
    }
  }

  private normalizeResponse(data: AnthropicRawResponse): ProviderResponse {
    return {
      id: data.id,
      model: data.model,
      content: data.content.map((block): ProviderContentBlock => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text }
        }
        if (block.type === 'tool_use') {
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
        }
        return block as unknown as ProviderContentBlock
      }),
      stopReason: data.stop_reason,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        cacheCreationInputTokens: data.usage.cache_creation_input_tokens,
        cacheReadInputTokens: data.usage.cache_read_input_tokens,
      },
    }
  }

  private normalizeStreamChunk(raw: Record<string, unknown>): ProviderStreamChunk {
    const type = raw.type as string
    const chunk: ProviderStreamChunk = { type, raw }

    if (type === 'content_block_delta' && raw.delta) {
      const delta = raw.delta as Record<string, unknown>
      chunk.delta = {
        type: (delta.type as string) ?? '',
        text: delta.text as string | undefined,
        partialJson: delta.partial_json as string | undefined,
        thinking: delta.thinking as string | undefined,
      }
    }

    if (type === 'message_start' && raw.message) {
      const message = raw.message as Record<string, unknown>
      if (message.usage) {
        const msgUsage = message.usage as Record<string, unknown>
        chunk.usage = {
          inputTokens: msgUsage.input_tokens as number | undefined,
        }
      }
    }

    if (type === 'message_delta') {
      const delta = raw.delta as Record<string, unknown> | undefined
      if (delta) {
        chunk.delta = {
          type: 'message_delta',
          stopReason: delta.stop_reason as string | undefined,
        }
      }
      if (raw.usage) {
        const usage = raw.usage as Record<string, unknown>
        chunk.usage = {
          outputTokens: usage.output_tokens as number | undefined,
        }
      }
    }

    if (type === 'content_block_start' && raw.content_block) {
      const block = raw.content_block as Record<string, unknown>
      chunk.contentBlock = {
        type: block.type as 'text' | 'tool_use',
        text: block.text as string | undefined,
        id: block.id as string | undefined,
        name: block.name as string | undefined,
      }
      chunk.index = raw.index as number | undefined
    }

    return chunk
  }

  private applyCacheBreakpoints(systemPrompt: string | ProviderSystemPromptBlock[] | Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    if (Array.isArray(systemPrompt)) return systemPrompt as Array<Record<string, unknown>>

    const DYNAMIC_BOUNDARY = '---DYNAMIC_BOUNDARY---'
    const parts = systemPrompt.split(DYNAMIC_BOUNDARY)

    const blocks: Array<Record<string, unknown>> = []

    if (parts[0]?.trim()) {
      blocks.push({
        type: 'text',
        text: parts[0].trim(),
        cache_control: { type: 'ephemeral' },
      })
    }

    if (parts.length > 1 && parts[1]?.trim()) {
      blocks.push({
        type: 'text',
        text: parts[1].trim(),
      })
    }

    if (blocks.length === 0) {
      blocks.push({
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      })
    }

    return blocks
  }

  private computePromptHash(content: string): string {
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return hash.toString(36)
  }

  detectPromptChange(promptKey: string, content: string): boolean {
    const newHash = this.computePromptHash(content)
    const oldHash = this.promptHashCache.get(promptKey)
    this.promptHashCache.set(promptKey, newHash)
    return oldHash !== undefined && oldHash !== newHash
  }
}

interface AnthropicRawResponse {
  id: string
  model: string
  content: Array<{
    type: 'text' | 'tool_use'
    text?: string
    id?: string
    name?: string
    input?: Record<string, unknown>
  }>
  stop_reason: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export class ProviderRequestError extends Error {
  status: number
  body: string
  provider: string

  constructor(status: number, body: string, provider: string) {
    super(`[${provider}] API Error ${status}: ${body}`)
    this.name = 'ProviderRequestError'
    this.status = status
    this.body = body
    this.provider = provider
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
