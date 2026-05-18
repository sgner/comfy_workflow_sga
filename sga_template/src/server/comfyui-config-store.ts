import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { join, resolve } from 'path'
import { createLogger } from '../utils/logger.js'
import { getSgaHome } from '../memory/paths.js'

const logger = createLogger('comfyui-config-store')

export interface ComfyUIProviderConfig {
  id: string
  provider: string
  name: string
  api_key: string
  default_model: string
  base_url?: string
  is_default: boolean
  default_max_tokens?: number
  default_temperature?: number
  retries?: number
  retry_delay?: number
  headers?: Record<string, string>
  custom_config?: Record<string, unknown>
  created_at: number
  updated_at: number
}

export interface ChatHistoryEntry {
  sender: 'user' | 'ai' | 'system'
  text: string
  timestamp: number
  metadata?: Record<string, unknown>
}

export class ComfyUIConfigStore {
  private configDir: string
  private configFile: string
  private githubTokenFile: string

  constructor() {
    const baseDir = process.env.COMFYUI_CONFIG_DIR ?? join(getSgaHome(), 'comfyui')
    this.configDir = join(baseDir, 'api_configs')
    this.configFile = join(this.configDir, 'providers.json')
    this.githubTokenFile = join(this.configDir, 'github_token.json')

    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true })
    }
  }

  private loadConfigs(): ComfyUIProviderConfig[] {
    if (!existsSync(this.configFile)) {
      return []
    }

    try {
      const content = readFileSync(this.configFile, 'utf-8')
      const data = JSON.parse(content)
      return Array.isArray(data) ? data : []
    } catch (e) {
      logger.error(`Error loading configs: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }

  private saveConfigs(configs: ComfyUIProviderConfig[]): void {
    try {
      writeFileSync(this.configFile, JSON.stringify(configs, null, 2), 'utf-8')
    } catch (e) {
      logger.error(`Error saving configs: ${e instanceof Error ? e.message : String(e)}`)
      throw new Error(`Error saving configs: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  getConfigs(): ComfyUIProviderConfig[] {
    return this.loadConfigs()
  }

  getConfigById(id: string): ComfyUIProviderConfig | undefined {
    return this.loadConfigs().find(c => c.id === id)
  }

  getDefaultConfig(): ComfyUIProviderConfig | undefined {
    const configs = this.loadConfigs()
    const defaultConfig = configs.find(c => c.is_default)
    if (defaultConfig) return defaultConfig
    return configs.length > 0 ? configs[0] : undefined
  }

  createConfig(input: {
    provider: string
    name: string
    api_key: string
    default_model: string
    base_url?: string
    is_default: boolean
    default_max_tokens?: number
    default_temperature?: number
    retries?: number
    retry_delay?: number
    headers?: Record<string, string>
    custom_config?: Record<string, unknown>
  }): ComfyUIProviderConfig {
    const configs = this.loadConfigs()
    const now = Date.now() / 1000
    const id = crypto.randomUUID()

    if (input.is_default) {
      for (const c of configs) {
        c.is_default = false
      }
    }

    const newConfig: ComfyUIProviderConfig = {
      id,
      provider: input.provider,
      name: input.name,
      api_key: input.api_key,
      default_model: input.default_model,
      base_url: input.base_url,
      is_default: input.is_default,
      default_max_tokens: input.default_max_tokens,
      default_temperature: input.default_temperature,
      retries: input.retries,
      retry_delay: input.retry_delay,
      headers: input.headers,
      custom_config: input.custom_config,
      created_at: now,
      updated_at: now,
    }

    configs.push(newConfig)
    this.saveConfigs(configs)
    return newConfig
  }

  updateConfig(id: string, updates: Partial<ComfyUIProviderConfig>): ComfyUIProviderConfig | undefined {
    const configs = this.loadConfigs()
    const index = configs.findIndex(c => c.id === id)

    if (index === -1) return undefined

    const config = configs[index]

    if (updates.name !== undefined) config.name = updates.name
    if (updates.api_key !== undefined) config.api_key = updates.api_key
    if (updates.default_model !== undefined) config.default_model = updates.default_model
    if (updates.base_url !== undefined) config.base_url = updates.base_url
    if (updates.default_max_tokens !== undefined) config.default_max_tokens = updates.default_max_tokens
    if (updates.default_temperature !== undefined) config.default_temperature = updates.default_temperature
    if (updates.retries !== undefined) config.retries = updates.retries
    if (updates.retry_delay !== undefined) config.retry_delay = updates.retry_delay
    if (updates.headers !== undefined) config.headers = updates.headers
    if (updates.custom_config !== undefined && config.provider === 'custom') {
      config.custom_config = updates.custom_config
    }

    if (updates.is_default !== undefined) {
      if (updates.is_default) {
        for (const c of configs) {
          c.is_default = false
        }
      }
      config.is_default = updates.is_default
    }

    config.updated_at = Date.now() / 1000
    configs[index] = config
    this.saveConfigs(configs)
    return config
  }

  deleteConfig(id: string): boolean {
    const configs = this.loadConfigs()
    const index = configs.findIndex(c => c.id === id)

    if (index === -1) return false

    configs.splice(index, 1)
    this.saveConfigs(configs)
    return true
  }

  setDefaultConfig(id: string): ComfyUIProviderConfig | undefined {
    const configs = this.loadConfigs()
    const target = configs.find(c => c.id === id)

    if (!target) return undefined

    for (const c of configs) {
      c.is_default = false
    }

    target.is_default = true
    target.updated_at = Date.now() / 1000
    this.saveConfigs(configs)
    return target
  }

  hasGitHubToken(): boolean {
    return existsSync(this.githubTokenFile)
  }

  getGitHubToken(): string | undefined {
    if (!existsSync(this.githubTokenFile)) return undefined

    try {
      const content = readFileSync(this.githubTokenFile, 'utf-8')
      const data = JSON.parse(content)
      return data.token as string
    } catch {
      return undefined
    }
  }

  updateGitHubToken(token: string): void {
    const data = { token, created_at: Date.now() / 1000, updated_at: Date.now() / 1000 }
    writeFileSync(this.githubTokenFile, JSON.stringify(data, null, 2), 'utf-8')

    process.env.GITHUB_TOKEN = token
  }

  deleteGitHubToken(): void {
    if (existsSync(this.githubTokenFile)) {
      unlinkSync(this.githubTokenFile)
    }
    delete process.env.GITHUB_TOKEN
  }
}
