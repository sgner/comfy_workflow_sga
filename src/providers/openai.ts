import type {
  LLMProvider,
  ProviderConfig,
  ProviderRequestOptions,
  ProviderResponse,
  ProviderStreamChunk,
  ProviderContentBlock,
  ProviderMessage,
  ProviderToolDefinition,
  ModelConfig,
} from './types.js'
import { ProviderRequestError } from './anthropic.js'

export const OPENAI_MODEL_ALIASES: Record<string, string> = {
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
  'gpt-4-turbo': 'gpt-4-turbo',
  'o1': 'o1',
  'o1-mini': 'o1-mini',
  'o3-mini': 'o3-mini',
}

export const OPENAI_DEFAULT_MAX_TOKENS = 4096

export const OPENAI_MODEL_CONFIGS: Record<string, ModelConfig> = {
  'gpt-4o': {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputPricePerMToken: 2.5,
    outputPricePerMToken: 10,
    supportsVision: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: false,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputPricePerMToken: 0.15,
    outputPricePerMToken: 0.6,
    supportsVision: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: false,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
  'gpt-4-turbo': {
    id: 'gpt-4-turbo',
    displayName: 'GPT-4 Turbo',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputPricePerMToken: 10,
    outputPricePerMToken: 30,
    supportsVision: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: false,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
  'o1': {
    id: 'o1',
    displayName: 'o1',
    contextWindow: 200000,
    maxOutputTokens: 100000,
    inputPricePerMToken: 15,
    outputPricePerMToken: 60,
    supportsVision: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: true,
    defaultMaxTokens: 32768,
    defaultTemperature: 1,
  },
  'o1-mini': {
    id: 'o1-mini',
    displayName: 'o1 Mini',
    contextWindow: 128000,
    maxOutputTokens: 65536,
    inputPricePerMToken: 3,
    outputPricePerMToken: 12,
    supportsVision: false,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: true,
    defaultMaxTokens: 32768,
    defaultTemperature: 1,
  },
  'o3-mini': {
    id: 'o3-mini',
    displayName: 'o3 Mini',
    contextWindow: 200000,
    maxOutputTokens: 100000,
    inputPricePerMToken: 1.1,
    outputPricePerMToken: 4.4,
    supportsVision: false,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: true,
    defaultMaxTokens: 32768,
    defaultTemperature: 1,
  },
}

export const DEEPSEEK_MODEL_CONFIGS: Record<string, ModelConfig> = {
  'deepseek-chat': {
    id: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    contextWindow: 64000,
    maxOutputTokens: 8192,
    inputPricePerMToken: 0.14,
    outputPricePerMToken: 0.28,
    supportsVision: false,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: false,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
  'deepseek-reasoner': {
    id: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner',
    contextWindow: 64000,
    maxOutputTokens: 8192,
    inputPricePerMToken: 0.55,
    outputPricePerMToken: 2.19,
    supportsVision: false,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: true,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
}

export const ZHIPU_MODEL_CONFIGS: Record<string, ModelConfig> = {
  'glm-4': {
    id: 'glm-4',
    displayName: 'GLM-4',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputPricePerMToken: 14,
    outputPricePerMToken: 14,
    supportsVision: false,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: false,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
  'glm-4-plus': {
    id: 'glm-4-plus',
    displayName: 'GLM-4 Plus',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputPricePerMToken: 50,
    outputPricePerMToken: 50,
    supportsVision: false,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: false,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
  'glm-4-flash': {
    id: 'glm-4-flash',
    displayName: 'GLM-4 Flash',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputPricePerMToken: 0.1,
    outputPricePerMToken: 0.1,
    supportsVision: false,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: false,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
}

export const MOONSHOT_MODEL_CONFIGS: Record<string, ModelConfig> = {
  'moonshot-v1-8k': {
    id: 'moonshot-v1-8k',
    displayName: 'Moonshot V1 8K',
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputPricePerMToken: 12,
    outputPricePerMToken: 12,
    supportsVision: false,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: false,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
  'moonshot-v1-32k': {
    id: 'moonshot-v1-32k',
    displayName: 'Moonshot V1 32K',
    contextWindow: 32768,
    maxOutputTokens: 4096,
    inputPricePerMToken: 24,
    outputPricePerMToken: 24,
    supportsVision: false,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: false,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
}

export const QWEN_MODEL_CONFIGS: Record<string, ModelConfig> = {
  'qwen-turbo': {
    id: 'qwen-turbo',
    displayName: 'Qwen Turbo',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    inputPricePerMToken: 0.3,
    outputPricePerMToken: 0.6,
    supportsVision: false,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: false,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
  'qwen-plus': {
    id: 'qwen-plus',
    displayName: 'Qwen Plus',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    inputPricePerMToken: 0.8,
    outputPricePerMToken: 2,
    supportsVision: false,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: false,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
  'qwen-max': {
    id: 'qwen-max',
    displayName: 'Qwen Max',
    contextWindow: 32768,
    maxOutputTokens: 8192,
    inputPricePerMToken: 20,
    outputPricePerMToken: 60,
    supportsVision: false,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsThinking: false,
    defaultMaxTokens: 4096,
    defaultTemperature: 0,
  },
}

export class OpenAIProvider implements LLMProvider {
  readonly name: string
  readonly config: ProviderConfig

  constructor(config: Omit<ProviderConfig, 'name'> & { name?: string }) {
    this.name = config.name ?? 'openai'
    this.config = {
      name: this.name,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
      models: config.models ?? OPENAI_MODEL_ALIASES,
      modelConfigs: config.modelConfigs ?? OPENAI_MODEL_CONFIGS,
      defaultModel: config.defaultModel ?? 'gpt-4o',
      defaultMaxTokens: config.defaultMaxTokens ?? OPENAI_DEFAULT_MAX_TOKENS,
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
    return this.config.models?.[model] ?? OPENAI_MODEL_ALIASES[model] ?? model
  }

  getModelConfig(model: string): ModelConfig | undefined {
    if (this.config.modelConfigs?.[model]) {
      return this.config.modelConfigs[model]
    }
    const resolvedId = this.config.models?.[model] ?? OPENAI_MODEL_ALIASES[model]
    if (resolvedId) {
      for (const mc of Object.values(this.config.modelConfigs ?? OPENAI_MODEL_CONFIGS)) {
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
    if (trimmed.endsWith('/chat/completions')) {
      return trimmed.slice(0, -'/chat/completions'.length)
    }
    return trimmed
  }

  async createMessage(options: ProviderRequestOptions): Promise<ProviderResponse> {
    const model = this.resolveModel(options.model)
    const modelConfig = this.getModelConfig(options.model)
    const maxTokens = options.maxTokens ?? modelConfig?.defaultMaxTokens ?? this.config.defaultMaxTokens ?? OPENAI_DEFAULT_MAX_TOKENS

    const body = this.buildRequestBody(options, model, maxTokens, false)
    const reqConfig = this.resolveRequestConfig(options.model, false)

    const retries = this.config.retries ?? 2
    const retryDelay = this.config.retryDelay ?? 1000
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(`${reqConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${reqConfig.apiKey}`,
            ...reqConfig.headers,
          },
          body: JSON.stringify(body),
          signal: options.signal,
        })

        if (!response.ok) {
          const errorBody = await response.text()
          throw new ProviderRequestError(response.status, errorBody, this.name)
        }

        const data = await response.json() as OpenAIChatResponse
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
    const maxTokens = options.maxTokens ?? modelConfig?.defaultMaxTokens ?? this.config.defaultMaxTokens ?? OPENAI_DEFAULT_MAX_TOKENS

    const body = this.buildRequestBody(options, model, maxTokens, true)
    const reqConfig = this.resolveRequestConfig(options.model, true)

    const response = await fetch(`${reqConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${reqConfig.apiKey}`,
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

  private buildRequestBody(
    options: ProviderRequestOptions,
    model: string,
    maxTokens: number,
    stream: boolean,
  ): Record<string, unknown> {
    const messages = this.convertMessages(options.messages, options.systemPrompt)

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages,
      stream,
    }

    if (options.temperature !== undefined) {
      body.temperature = options.temperature
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = this.convertTools(options.tools)
      body.tool_choice = 'auto'
    }

    return body
  }

  private convertMessages(
    messages: ProviderMessage[],
    systemPrompt?: string | Array<{ type: 'text'; text: string }>,
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = []

    if (systemPrompt) {
      const text = typeof systemPrompt === 'string'
        ? systemPrompt
        : systemPrompt.map(b => b.text).join('\n')
      result.push({ role: 'system', content: text })
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        result.push({ role: 'system', content: this.extractTextFromContent(msg.content) })
        continue
      }

      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content })
        continue
      }

      const hasToolUse = msg.content.some(b => b.type === 'tool_use' || b.type === 'tool_result')
      if (!hasToolUse) {
        result.push({
          role: msg.role,
          content: msg.content.map(b => {
            if (b.type === 'text') return { type: 'text', text: b.text }
            return b
          }),
        })
        continue
      }

      const textParts = msg.content.filter(b => b.type === 'text')
      const toolUseParts = msg.content.filter(b => b.type === 'tool_use')
      const toolResultParts = msg.content.filter(b => b.type === 'tool_result')

      if (msg.role === 'assistant' && toolUseParts.length > 0) {
        // OpenAI format: assistant message with tool_calls at top level
        const assistantMsg: Record<string, unknown> = {
          role: 'assistant',
          content: textParts.map(b => b.text).join('\n') || null,
          tool_calls: toolUseParts.map(tu => ({
            id: tu.id,
            type: 'function',
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input ?? {}),
            },
          })),
        }
        result.push(assistantMsg)
      } else if (msg.role === 'assistant') {
        result.push({ role: 'assistant', content: this.extractTextFromContent(msg.content) })
      } else if (msg.role === 'user') {
        // User message with tool results: send text parts as user message first
        if (textParts.length > 0) {
          result.push({
            role: 'user',
            content: textParts.map(b => b.text).join('\n'),
          })
        }
      }

      // Tool results must follow the assistant message that made the tool call
      for (const tr of toolResultParts) {
        result.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
        })
      }
    }

    return result
  }

  private convertTools(tools: ProviderToolDefinition[]): unknown[] {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }))
  }

  private normalizeResponse(data: OpenAIChatResponse): ProviderResponse {
    const choice = data.choices?.[0]
    const message = choice?.message

    const content: ProviderContentBlock[] = []

    if (message?.content) {
      content.push({ type: 'text', text: message.content })
    }

    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: this.safeParseJSON(tc.function.arguments),
        })
      }
    }

    const stopReason = choice?.finish_reason ?? 'stop'
    const stopReasonMap: Record<string, string> = {
      stop: 'end_turn',
      length: 'max_tokens',
      tool_calls: 'tool_use',
      content_filter: 'end_turn',
    }

    return {
      id: data.id,
      model: data.model,
      content,
      stopReason: stopReasonMap[stopReason] ?? stopReason,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
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

  private extractTextFromContent(content: string | ProviderContentBlock[]): string {
    if (typeof content === 'string') return content
    return content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('\n')
  }

  private safeParseJSON(str: string): Record<string, unknown> {
    try {
      return JSON.parse(str) as Record<string, unknown>
    } catch {
      return {}
    }
  }
}

interface OpenAIChatResponse {
  id: string
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content?: string
      tool_calls?: Array<{
        id: string
        type: string
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
