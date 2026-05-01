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
      const extraProviders = JSON.parse(extraProvidersEnv) as StoredProviderConfig[]
      for (const p of extraProviders) {
        try {
          await addProvider(p)
        } catch (error) {
          logger.error(`Failed to load provider "${p.name}" from SGA_PROVIDERS: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch {
      // ignore invalid JSON
    }
  }
}

export async function loadProvidersFromConfig(configs: StoredProviderConfig[], defaultName?: string): Promise<void> {
  for (const config of configs) {
    try {
      const setAsDefault = defaultName ? config.name === defaultName : false
      await addProvider(config, setAsDefault)
    } catch (error) {
      logger.error(`Failed to load provider "${config.name}" from config file: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (defaultName) {
    setDefaultProvider(defaultName)
  }
}
