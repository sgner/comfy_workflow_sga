import type { APIRequestOptions, APIResponse, APIStreamChunk } from './types.js'
import { MODEL_ALIASES, DEFAULT_MAX_TOKENS } from './types.js'
import type { LLMProvider, ProviderRequestOptions } from '../providers/types.js'
import { createProvider } from '../providers/registry.js'
import { resolveProvider } from '../providers/provider-store.js'

export interface APIClientConfig {
  apiKey?: string
  baseUrl?: string
  providerName?: string
  defaultModel?: string
  defaultMaxTokens?: number
  defaultTemperature?: number
  retries?: number
  retryDelay?: number
}

export class APIClient {
  private provider: LLMProvider

  constructor(config: APIClientConfig = {}) {
    if (config.providerName) {
      try {
        this.provider = resolveProvider(config.providerName)
      } catch {
        this.provider = createProvider({
          name: config.providerName,
          apiKey: config.apiKey ?? '',
          baseUrl: config.baseUrl ?? '',
          defaultModel: config.defaultModel,
          defaultMaxTokens: config.defaultMaxTokens,
          defaultTemperature: config.defaultTemperature,
          retries: config.retries,
          retryDelay: config.retryDelay,
        })
      }
    } else {
      try {
        this.provider = resolveProvider()
      } catch {
        this.provider = createProvider({
          name: 'anthropic',
          apiKey: config.apiKey ?? '',
          baseUrl: config.baseUrl ?? '',
          defaultModel: config.defaultModel,
          defaultMaxTokens: config.defaultMaxTokens,
          defaultTemperature: config.defaultTemperature,
          retries: config.retries,
          retryDelay: config.retryDelay,
        })
      }
    }
  }

  static fromProvider(provider: LLMProvider): APIClient {
    const client = Object.create(APIClient.prototype) as APIClient
    client.provider = provider
    return client
  }

  get providerName(): string {
    return this.provider.name
  }

  get apiKey(): string {
    return this.provider.config.apiKey
  }

  get baseUrl(): string {
    return this.provider.config.baseUrl
  }

  getProvider(): LLMProvider {
    return this.provider
  }

  setProvider(provider: LLMProvider): void {
    this.provider = provider
  }

  async createMessage(options: APIRequestOptions): Promise<APIResponse> {
    const providerOptions = this.toProviderOptions(options)
    const response = await this.provider.createMessage(providerOptions)
    return this.fromProviderResponse(response)
  }

  async *createStreamingMessage(options: APIRequestOptions): AsyncGenerator<APIStreamChunk> {
    const providerOptions = this.toProviderOptions(options)
    for await (const chunk of this.provider.createStreamingMessage(providerOptions)) {
      yield this.fromProviderStreamChunk(chunk)
    }
  }

  private toProviderOptions(options: APIRequestOptions): ProviderRequestOptions {
    const model = MODEL_ALIASES[options.model] ?? options.model
    return {
      model,
      messages: options.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : m.content as unknown as ProviderRequestOptions['messages'][number]['content'],
      })),
      tools: options.tools,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      stream: options.stream,
      signal: options.signal,
      systemPrompt: options.systemPrompt,
      thinkingBudget: options.thinkingBudget,
      reasoningEffort: options.reasoningEffort,
    }
  }

  private fromProviderResponse(response: import('../providers/types.js').ProviderResponse): APIResponse {
    return {
      id: response.id,
      model: response.model,
      content: response.content.map(block => {
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text ?? '' }
        }
        if (block.type === 'tool_use') {
          return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input }
        }
        return block as unknown as APIResponse['content'][number]
      }),
      stopReason: response.stopReason as APIResponse['stopReason'],
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
        cacheReadInputTokens: response.usage.cacheReadInputTokens,
      },
    }
  }

  private fromProviderStreamChunk(chunk: import('../providers/types.js').ProviderStreamChunk): APIStreamChunk {
    const result: APIStreamChunk = {
      type: (chunk.type as APIStreamChunk['type']) ?? 'content_block_delta',
    }

    if (chunk.index !== undefined) result.index = chunk.index
    if (chunk.contentBlock) {
      result.content_block = {
        type: (chunk.contentBlock.type ?? 'text') as 'text' | 'tool_use',
        text: chunk.contentBlock.text,
        name: chunk.contentBlock.name,
        id: chunk.contentBlock.id,
      }
    }
    if (chunk.delta) {
      result.delta = {
        type: (chunk.delta.type ?? 'text_delta') as APIStreamChunk['delta'] extends { type?: infer T } ? T : never,
        text: chunk.delta.text,
        partial_json: chunk.delta.partialJson,
        thinking: chunk.delta.thinking,
        stop_reason: chunk.delta.stopReason,
      }
    }
    if (chunk.usage) {
      result.usage = {
        output_tokens: chunk.usage.outputTokens ?? 0,
      }
    }

    return result
  }
}

export class APIError extends Error {
  status: number
  body: string

  constructor(status: number, body: string) {
    super(`API Error ${status}: ${body}`)
    this.name = 'APIError'
    this.status = status
    this.body = body
  }
}
