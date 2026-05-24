import type { LLMProvider, ProviderConfig, ModelConfig, ProviderExtension } from './types.js'
import { createProvider, createProviderWithExtension, getProviderDefaults, getRegisteredProviders } from './registry.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('provider-store')

export interface StoredProviderConfig {
  name: string
  apiKey: string
  baseUrl?: string
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

export interface ProviderValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export function isStoredProviderConfig(value: unknown): value is StoredProviderConfig {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return typeof obj.name === 'string' && typeof obj.apiKey === 'string'
}

export function normalizeProviderConfig(raw: Record<string, unknown>): StoredProviderConfig {
  const name = (raw.name ?? raw.provider ?? '') as string
  const apiKey = (raw.apiKey ?? raw.api_key ?? '') as string
  const baseUrl = (raw.baseUrl ?? raw.base_url) as string | undefined
  const defaultModel = (raw.defaultModel ?? raw.default_model) as string | undefined
  const modelConfigs = (raw.modelConfigs ?? raw.model_configs) as Record<string, ModelConfig> | undefined
  const headers = (raw.headers ?? raw.custom_config_headers) as Record<string, string> | undefined
  const extension = raw.extension as ProviderExtension | undefined

  const result: StoredProviderConfig = {
    name,
    apiKey,
    baseUrl,
    defaultModel,
    modelConfigs,
    headers,
    extra: raw.extra as Record<string, unknown> | undefined,
    extension,
  }

  if (raw.defaultMaxTokens ?? raw.default_max_tokens) {
    result.defaultMaxTokens = (raw.defaultMaxTokens ?? raw.default_max_tokens) as number
  }
  if (raw.defaultTemperature ?? raw.default_temperature) {
    result.defaultTemperature = (raw.defaultTemperature ?? raw.default_temperature) as number
  }
  if (raw.retries) {
    result.retries = raw.retries as number
  }
  if (raw.retryDelay ?? raw.retry_delay) {
    result.retryDelay = (raw.retryDelay ?? raw.retry_delay) as number
  }
  if (raw.models) {
    result.models = raw.models as Record<string, string>
  }

  const customConfig = raw.custom_config as Record<string, unknown> | undefined
  if (customConfig) {
    if (customConfig.endpoint && result.baseUrl) {
      const endpoint = customConfig.endpoint as string
      if (endpoint.startsWith('/')) {
        result.baseUrl = result.baseUrl.replace(/\/+$/, '') + endpoint
      }
    }

    if (customConfig.headers) {
      const rawHeaders = customConfig.headers
      let parsedHeaders: Record<string, string>
      if (typeof rawHeaders === 'string') {
        try {
          parsedHeaders = JSON.parse(rawHeaders)
        } catch {
          parsedHeaders = {}
        }
      } else if (typeof rawHeaders === 'object' && rawHeaders !== null) {
        parsedHeaders = rawHeaders as Record<string, string>
      } else {
        parsedHeaders = {}
      }

      for (const [key, value] of Object.entries(parsedHeaders)) {
        if (typeof value === 'string' && value.includes('$apiKey')) {
          parsedHeaders[key] = value.replace(/\$apiKey/g, apiKey)
        }
      }

      result.headers = { ...result.headers, ...parsedHeaders }
    }
  }

  return result
}

export function validateProviderConfig(config: Partial<StoredProviderConfig> & { name?: string }): ProviderValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!config.name || typeof config.name !== 'string' || config.name.trim() === '') {
    errors.push('name is required and must be a non-empty string')
  }

  if (!config.apiKey || typeof config.apiKey !== 'string' || config.apiKey.trim() === '') {
    errors.push('apiKey is required and must be a non-empty string')
  }

  const defaults = config.name ? getProviderDefaults(config.name) : undefined
  const effectiveBaseUrl = config.baseUrl ?? defaults?.baseUrl
  if (!effectiveBaseUrl) {
    errors.push('baseUrl is required when the provider is not a built-in type (anthropic, openai, deepseek, zhipu, moonshot, qwen)')
  }

  const effectiveDefaultModel = config.defaultModel ?? defaults?.defaultModel
  if (!effectiveDefaultModel) {
    errors.push('defaultModel is required (either explicitly set or available as a built-in default)')
  }

  const effectiveModelConfigs = config.modelConfigs ?? defaults?.modelConfigs
  if (!effectiveModelConfigs || Object.keys(effectiveModelConfigs).length === 0) {
    warnings.push(
      'No modelConfigs provided and no built-in defaults available. ' +
      'The provider will not have model capability information (context window, pricing, etc.). ' +
      'Consider adding modelConfigs for better functionality.'
    )
  }

  if (config.modelConfigs) {
    for (const [key, mc] of Object.entries(config.modelConfigs)) {
      if (!mc.id) {
        errors.push(`modelConfigs["${key}"].id is required`)
      }
    }
  }

  if (config.extension) {
    if (config.extension.providerModule && (config.extension.requestTransformer || config.extension.responseTransformer || config.extension.streamChunkTransformer)) {
      warnings.push('Both providerModule and transformers are configured. providerModule takes precedence; transformers will be ignored.')
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

interface ProviderEntry {
  config: StoredProviderConfig
  instance: LLMProvider
}

const providerStore: Map<string, ProviderEntry> = new Map()
let defaultProviderName: string = ''

export async function addProvider(config: StoredProviderConfig, setAsDefault?: boolean): Promise<LLMProvider> {
  const validation = validateProviderConfig(config)

  for (const warning of validation.warnings) {
    logger.warn(`Provider "${config.name}": ${warning}`)
  }

  if (!validation.valid) {
    for (const error of validation.errors) {
      logger.error(`Provider "${config.name}" validation failed: ${error}`)
    }
    throw new Error(
      `Provider "${config.name}" does not meet minimum configuration requirements: ${validation.errors.join('; ')}. ` +
      `This provider will be discarded.`
    )
  }

  const defaults = getProviderDefaults(config.name)
  const fullConfig: ProviderConfig = {
    name: config.name,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? defaults?.baseUrl ?? '',
    models: config.models ?? defaults?.models as Record<string, string> | undefined,
    modelConfigs: config.modelConfigs ?? defaults?.modelConfigs,
    defaultModel: config.defaultModel ?? defaults?.defaultModel,
    defaultMaxTokens: config.defaultMaxTokens,
    defaultTemperature: config.defaultTemperature,
    retries: config.retries ?? 2,
    retryDelay: config.retryDelay ?? 1000,
    headers: config.headers,
    extra: config.extra,
    extension: config.extension,
  }

  const instance = config.extension
    ? await createProviderWithExtension(fullConfig)
    : createProvider(fullConfig)

  providerStore.set(config.name, { config, instance })

  if (setAsDefault || providerStore.size === 1) {
    defaultProviderName = config.name
  }

  return instance
}

export function replaceProviderInstance(name: string, instance: LLMProvider): boolean {
  const entry = providerStore.get(name)
  if (!entry) return false
  entry.instance = instance
  return true
}

export function removeProvider(name: string): boolean {
  if (!providerStore.has(name)) return false
  providerStore.delete(name)
  if (defaultProviderName === name) {
    const first = providerStore.keys().next()
    defaultProviderName = first.done ? '' : first.value
  }
  return true
}

export function getProvider(name: string): LLMProvider | undefined {
  return providerStore.get(name)?.instance
}

export function getProviderConfig(name: string): StoredProviderConfig | undefined {
  return providerStore.get(name)?.config
}

export function getDefaultProvider(): LLMProvider | undefined {
  if (defaultProviderName) {
    return providerStore.get(defaultProviderName)?.instance
  }
  return undefined
}

export function getDefaultProviderName(): string {
  return defaultProviderName
}

export function setDefaultProvider(name: string): boolean {
  if (!providerStore.has(name)) return false
  defaultProviderName = name
  return true
}

export function getAllProviderNames(): string[] {
  return [...providerStore.keys()]
}

export function getAllProviders(): Array<{ name: string; config: StoredProviderConfig; isDefault: boolean }> {
  return [...providerStore.entries()].map(([name, entry]) => ({
    name,
    config: entry.config,
    isDefault: name === defaultProviderName,
  }))
}

export function resolveProvider(providerName?: string): LLMProvider {
  if (providerName) {
    const provider = getProvider(providerName)
    if (provider) return provider
  }

  const defaultProvider = getDefaultProvider()
  if (defaultProvider) return defaultProvider

  throw new Error(
    `No provider configured. Please configure at least one provider via .env, sga-providers.json, or the API. ` +
    `Available provider types: ${getRegisteredProviders().join(', ')}`
  )
}

export async function loadProvidersFromEnv(): Promise<void> {
  const defaultName = process.env.LLM_PROVIDER ?? 'anthropic'
  const apiKey = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? ''

  if (!apiKey) return

  const defaults = getProviderDefaults(defaultName) ?? {}
  const baseUrl = process.env.LLM_BASE_URL ?? defaults.baseUrl
  const defaultModel = process.env.LLM_MODEL ?? defaults.defaultModel

  try {
    await addProvider({
      name: defaultName,
      apiKey,
      baseUrl: baseUrl ?? undefined,
      models: defaults.models as Record<string, string> | undefined,
      modelConfigs: defaults.modelConfigs,
      defaultModel: defaultModel ?? undefined,
      defaultMaxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? '', 10) || undefined,
      defaultTemperature: parseFloat(process.env.LLM_TEMPERATURE ?? '') || undefined,
      retries: parseInt(process.env.LLM_RETRIES ?? '2', 10) || undefined,
      retryDelay: parseInt(process.env.LLM_RETRY_DELAY ?? '1000', 10) || undefined,
      headers: process.env.LLM_EXTRA_HEADERS
        ? JSON.parse(process.env.LLM_EXTRA_HEADERS)
        : undefined,
    }, true)
  } catch (error) {
    logger.error(`Failed to load default provider from env: ${error instanceof Error ? error.message : String(error)}`)
  }

  const extraProvidersEnv = process.env.SGA_PROVIDERS
  if (extraProvidersEnv) {
    try {
      const extraProviders = JSON.parse(extraProvidersEnv) as Array<StoredProviderConfig | Record<string, unknown>>
      for (const p of extraProviders) {
        try {
          const config = isStoredProviderConfig(p) ? p : normalizeProviderConfig(p)
          await addProvider(config)
        } catch (error) {
          logger.error(`Failed to load provider "${p.name}" from SGA_PROVIDERS: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch {
      // ignore invalid JSON
    }
  }
}

export async function loadProvidersFromConfig(configs: Array<StoredProviderConfig | Record<string, unknown>>, defaultName?: string): Promise<void> {
  for (const raw of configs) {
    let configName = 'unknown'
    try {
      const config = isStoredProviderConfig(raw) ? raw : normalizeProviderConfig(raw)
      configName = config.name
      const setAsDefault = defaultName ? config.name === defaultName : false
      await addProvider(config, setAsDefault)
    } catch (error) {
      logger.error(`Failed to load provider "${configName}" from config file: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (defaultName) {
    setDefaultProvider(defaultName)
  }
}
