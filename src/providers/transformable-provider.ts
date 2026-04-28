import type {
  LLMProvider,
  ProviderConfig,
  ProviderRequestOptions,
  ProviderResponse,
  ProviderStreamChunk,
  ModelConfig,
  RequestTransformer,
  ResponseTransformer,
  StreamChunkTransformer,
} from './types.js'
import { ProviderRequestError } from './anthropic.js'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class TransformableProvider implements LLMProvider {
  readonly name: string
  readonly config: ProviderConfig
  private inner: LLMProvider
  private requestTransformer?: RequestTransformer
  private responseTransformer?: ResponseTransformer
  private streamChunkTransformer?: StreamChunkTransformer

  constructor(
    inner: LLMProvider,
    transformers?: {
      requestTransformer?: RequestTransformer
      responseTransformer?: ResponseTransformer
      streamChunkTransformer?: StreamChunkTransformer
    },
  ) {
    this.inner = inner
    this.name = inner.name
    this.config = inner.config
    this.requestTransformer = transformers?.requestTransformer
    this.responseTransformer = transformers?.responseTransformer
    this.streamChunkTransformer = transformers?.streamChunkTransformer
  }

  resolveModel(model: string): string {
    return this.inner.resolveModel(model)
  }

  getModelConfig(model: string): ModelConfig | undefined {
    return this.inner.getModelConfig(model)
  }

  validateConfig(): boolean {
    return this.inner.validateConfig()
  }

  async createMessage(options: ProviderRequestOptions): Promise<ProviderResponse> {
    const model = this.inner.resolveModel(options.model)
    const maxTokens = options.maxTokens ?? this.config.defaultMaxTokens ?? 4096

    let body = this.buildRawBody(options, model, maxTokens)
    let headers = this.buildHeaders()

    if (this.requestTransformer) {
      const transformed = this.requestTransformer(body, headers)
      body = transformed.body
      headers = transformed.headers
    }

    const retries = this.config.retries ?? 2
    const retryDelay = this.config.retryDelay ?? 1000
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const endpoint = this.getEndpoint()
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: options.signal,
        })

        if (!response.ok) {
          const errorBody = await response.text()
          throw new ProviderRequestError(response.status, errorBody, this.name)
        }

        let data = await response.json() as Record<string, unknown>

        if (this.responseTransformer) {
          data = this.responseTransformer(data)
        }

        return this.normalizeOpenAIResponse(data)
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
    const model = this.inner.resolveModel(options.model)
    const maxTokens = options.maxTokens ?? this.config.defaultMaxTokens ?? 4096

    let body = this.buildRawBody(options, model, maxTokens)
    body.stream = true
    let headers = this.buildHeaders()

    if (this.requestTransformer) {
      const transformed = this.requestTransformer(body, headers)
      body = transformed.body
      headers = transformed.headers
    }

    const endpoint = this.getEndpoint()
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
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
            let raw = JSON.parse(data) as Record<string, unknown>
            if (this.streamChunkTransformer) {
              raw = this.streamChunkTransformer(raw)
            }
            yield this.normalizeStreamChunk(raw)
          } catch {
            continue
          }
        }
      }
    }
  }

  private getEndpoint(): string {
    const base = this.config.baseUrl.replace(/\/$/, '')
    return `${base}/chat/completions`
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
      ...this.config.headers,
    }
  }

  private buildRawBody(options: ProviderRequestOptions, model: string, maxTokens: number): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = []

    if (options.systemPrompt) {
      const text = typeof options.systemPrompt === 'string'
        ? options.systemPrompt
        : options.systemPrompt.map(b => b.text).join('\n')
      messages.push({ role: 'system', content: text })
    }

    for (const msg of options.messages) {
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content })
      } else {
        const textParts = msg.content
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('\n')
        messages.push({ role: msg.role, content: textParts })
      }
    }

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages,
    }

    if (options.temperature !== undefined) {
      body.temperature = options.temperature
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }))
      body.tool_choice = 'auto'
    }

    return body
  }

  private normalizeOpenAIResponse(data: Record<string, unknown>): ProviderResponse {
    const choices = data.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0]
    const message = choice?.message as Record<string, unknown> | undefined

    const content: ProviderResponse['content'] = []

    if (message?.content) {
      content.push({ type: 'text', text: message.content as string })
    }

    const toolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown> | undefined
        content.push({
          type: 'tool_use',
          id: tc.id as string,
          name: fn?.name as string,
          input: this.safeParseJSON(fn?.arguments as string ?? '{}'),
        })
      }
    }

    const stopReason = choice?.finish_reason as string ?? 'stop'
    const stopReasonMap: Record<string, string> = {
      stop: 'end_turn',
      length: 'max_tokens',
      tool_calls: 'tool_use',
    }

    const usage = data.usage as Record<string, unknown> | undefined

    return {
      id: data.id as string ?? '',
      model: data.model as string ?? '',
      content,
      stopReason: stopReasonMap[stopReason] ?? stopReason,
      usage: {
        inputTokens: (usage?.prompt_tokens as number) ?? 0,
        outputTokens: (usage?.completion_tokens as number) ?? 0,
      },
    }
  }

  private normalizeStreamChunk(raw: Record<string, unknown>): ProviderStreamChunk {
    const chunk: ProviderStreamChunk = { type: 'stream_chunk', raw }

    const choices = raw.choices as Array<Record<string, unknown>> | undefined
    if (!choices || choices.length === 0) return chunk

    const choice = choices[0]
    const delta = choice.delta as Record<string, unknown> | undefined

    if (delta) {
      if (delta.content) {
        chunk.delta = { type: 'text_delta', text: delta.content as string }
      }

      const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined
      if (toolCalls && toolCalls.length > 0) {
        const tc = toolCalls[0]
        const fn = tc.function as Record<string, unknown> | undefined
        chunk.delta = {
          type: 'input_json_delta',
          partialJson: fn?.arguments as string | undefined,
        }
        if (tc.id) {
          chunk.contentBlock = {
            type: 'tool_use',
            id: tc.id as string,
            name: fn?.name as string | undefined,
          }
        }
      }
    }

    const finishReason = choice.finish_reason as string | undefined
    if (finishReason) {
      const stopReasonMap: Record<string, string> = {
        stop: 'end_turn',
        length: 'max_tokens',
        tool_calls: 'tool_use',
      }
      chunk.delta = {
        type: 'message_delta',
        stopReason: stopReasonMap[finishReason] ?? finishReason,
      }
    }

    return chunk
  }

  private safeParseJSON(str: string): Record<string, unknown> {
    try {
      return JSON.parse(str) as Record<string, unknown>
    } catch {
      return {}
    }
  }
}
