import type { LLMProvider, ProviderConfig, ModelConfig } from './types.js'
import { AnthropicProvider, ANTHROPIC_MODEL_ALIASES, ANTHROPIC_MODEL_CONFIGS } from './anthropic.js'
import { OpenAIProvider, OPENAI_MODEL_ALIASES, OPENAI_MODEL_CONFIGS, DEEPSEEK_MODEL_CONFIGS, ZHIPU_MODEL_CONFIGS, MOONSHOT_MODEL_CONFIGS, QWEN_MODEL_CONFIGS } from './openai.js'
import { TransformableProvider } from './transformable-provider.js'
import { loadProviderModule, loadRequestTransformer, loadResponseTransformer, loadStreamChunkTransformer } from './provider-loader.js'

type ProviderConstructor = new (config: Omit<ProviderConfig, 'name'> & { name?: string }) => LLMProvider

const providerRegistry: Map<string, ProviderConstructor> = new Map([
  ['anthropic', AnthropicProvider as unknown as ProviderConstructor],
  ['openai', OpenAIProvider as unknown as ProviderConstructor],
])

interface ProviderDefaults {
  baseUrl?: string
  models?: Record<string, string>
  modelConfigs?: Record<string, ModelConfig>
  defaultModel?: string
  defaultMaxTokens?: number
}

const providerDefaults: Map<string, ProviderDefaults> = new Map([
  ['anthropic', {
    baseUrl: 'https://api.anthropic.com/v1',
    models: ANTHROPIC_MODEL_ALIASES,
    modelConfigs: ANTHROPIC_MODEL_CONFIGS,
    defaultModel: 'sonnet',
  }],
  ['openai', {
    baseUrl: 'https://api.openai.com/v1',
    models: OPENAI_MODEL_ALIASES,
    modelConfigs: OPENAI_MODEL_CONFIGS,
    defaultModel: 'gpt-4o',
  }],
  ['deepseek', {
    baseUrl: 'https://api.deepseek.com/v1',
    models: { 'deepseek-chat': 'deepseek-chat', 'deepseek-reasoner': 'deepseek-reasoner' },
    modelConfigs: DEEPSEEK_MODEL_CONFIGS,
    defaultModel: 'deepseek-chat',
  }],
  ['zhipu', {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: { 'glm-4': 'glm-4', 'glm-4-plus': 'glm-4-plus', 'glm-4-flash': 'glm-4-flash' },
    modelConfigs: ZHIPU_MODEL_CONFIGS,
    defaultModel: 'glm-4',
  }],
  ['moonshot', {
    baseUrl: 'https://api.moonshot.cn/v1',
    models: { 'moonshot-v1-8k': 'moonshot-v1-8k', 'moonshot-v1-32k': 'moonshot-v1-32k' },
    modelConfigs: MOONSHOT_MODEL_CONFIGS,
    defaultModel: 'moonshot-v1-8k',
  }],
  ['qwen', {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: { 'qwen-turbo': 'qwen-turbo', 'qwen-plus': 'qwen-plus', 'qwen-max': 'qwen-max' },
    modelConfigs: QWEN_MODEL_CONFIGS,
    defaultModel: 'qwen-plus',
  }],
])

export function registerProvider(name: string, constructor: ProviderConstructor, defaults?: ProviderDefaults): void {
  providerRegistry.set(name, constructor)
  if (defaults) {
    providerDefaults.set(name, defaults)
  }
}

export function unregisterProvider(name: string): void {
  providerRegistry.delete(name)
  providerDefaults.delete(name)
}

export function getRegisteredProviders(): string[] {
  return [...providerRegistry.keys()]
}

export function getProviderDefaults(name: string): ProviderDefaults | undefined {
  return providerDefaults.get(name)
}

export function createProvider(config: ProviderConfig): LLMProvider {
  const Constructor = providerRegistry.get(config.name)

  if (!Constructor) {
    const openaiLike = new OpenAIProvider({
      ...config,
      name: config.name,
    })
    return openaiLike
  }

  return new Constructor({
    ...config,
    name: config.name,
  })
}

export async function createProviderWithExtension(config: ProviderConfig): Promise<LLMProvider> {
  const extension = config.extension

  if (extension?.providerModule) {
    const ProviderClass = await loadProviderModule(extension.providerModule)
    return new ProviderClass({
      ...config,
      name: config.name,
    })
  }

  const inner = createProvider(config)

  if (extension?.requestTransformer || extension?.responseTransformer || extension?.streamChunkTransformer) {
    const [reqTransformer, resTransformer, streamTransformer] = await Promise.all([
      extension.requestTransformer ? loadRequestTransformer(extension.requestTransformer) : Promise.resolve(undefined),
      extension.responseTransformer ? loadResponseTransformer(extension.responseTransformer) : Promise.resolve(undefined),
      extension.streamChunkTransformer ? loadStreamChunkTransformer(extension.streamChunkTransformer) : Promise.resolve(undefined),
    ])

    return new TransformableProvider(inner, {
      requestTransformer: reqTransformer,
      responseTransformer: resTransformer,
      streamChunkTransformer: streamTransformer,
    })
  }

  return inner
}

export function createProviderFromEnv(providerName?: string): LLMProvider {
  const name = providerName ?? process.env.LLM_PROVIDER ?? 'anthropic'

  const defaults = providerDefaults.get(name) ?? {}
  const apiKey = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? ''
  const baseUrl = process.env.LLM_BASE_URL ?? defaults.baseUrl
  const defaultModel = process.env.LLM_MODEL ?? defaults.defaultModel

  return createProvider({
    name,
    apiKey,
    baseUrl: baseUrl ?? '',
    models: defaults.models as Record<string, string> | undefined,
    modelConfigs: defaults.modelConfigs,
    defaultModel,
    defaultMaxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? '', 10) || undefined,
    defaultTemperature: parseFloat(process.env.LLM_TEMPERATURE ?? '') || undefined,
    retries: parseInt(process.env.LLM_RETRIES ?? '2', 10),
    retryDelay: parseInt(process.env.LLM_RETRY_DELAY ?? '1000', 10),
    headers: process.env.LLM_EXTRA_HEADERS
      ? JSON.parse(process.env.LLM_EXTRA_HEADERS)
      : undefined,
  })
}

export { AnthropicProvider, ProviderRequestError, ANTHROPIC_MODEL_ALIASES, ANTHROPIC_MODEL_CONFIGS } from './anthropic.js'
export { OpenAIProvider, OPENAI_MODEL_ALIASES, OPENAI_MODEL_CONFIGS, DEEPSEEK_MODEL_CONFIGS, ZHIPU_MODEL_CONFIGS, MOONSHOT_MODEL_CONFIGS, QWEN_MODEL_CONFIGS } from './openai.js'
export { TransformableProvider } from './transformable-provider.js'
export { loadProviderModule, loadRequestTransformer, loadResponseTransformer, loadStreamChunkTransformer } from './provider-loader.js'
