import { existsSync } from 'fs'
import { join } from 'path'
import { getSgaHome } from '../memory/paths.js'
import { getAllMCPServers } from '../mcp/index.js'
import { getAllProviderNames, getDefaultProviderName } from '../providers/provider-store.js'
import { getCodexCapabilityStatus, type CodexCapabilityStatus } from './codex-status.js'

export interface ComfyUIConfigDiagnostics {
  count: number
  defaultProvider: string | null
  missingKeys: string[]
  providers: Array<{
    id: string
    name: string
    provider: string
    isDefault: boolean
    hasApiKey: boolean
  }>
  hasGitHubToken: boolean
}

export interface SystemDiagnostics {
  status: 'ok' | 'degraded'
  backend: {
    healthy: boolean
    service: string
    nodeVersion: string
    cwdConfigured: boolean
    sgaHomeConfigured: boolean
    sessionDirExists: boolean
    configDirExists: boolean
  }
  providers: ComfyUIConfigDiagnostics & {
    sgaProviderCount: number
    sgaDefaultProvider: string | null
  }
  codex: Pick<CodexCapabilityStatus, 'enabled' | 'mode' | 'state' | 'build' | 'binary' | 'canSwitchToCodex' | 'message'>
  mcp: {
    connected: number
    total: number
    servers: Array<{ name: string; status: string; toolCount: number; error?: string }>
  }
  comfyui: {
    reachable: boolean | null
    baseUrl: string | null
    note?: string
  }
  errors: string[]
}

interface DiagnosticsConfigStore {
  getConfigs(): Array<{
    id: string
    name: string
    provider: string
    api_key?: string
    is_default: boolean
  }>
  getDefaultConfig(): { id: string; name: string } | undefined
  hasGitHubToken(): boolean
}

export function buildProviderDiagnostics(configStore: DiagnosticsConfigStore): ComfyUIConfigDiagnostics {
  const configs = configStore.getConfigs()
  const defaultConfig = configStore.getDefaultConfig()
  return {
    count: configs.length,
    defaultProvider: defaultConfig?.name ?? null,
    missingKeys: configs.filter(c => !c.api_key).map(c => c.name),
    providers: configs.map(c => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      isDefault: c.is_default,
      hasApiKey: !!c.api_key,
    })),
    hasGitHubToken: configStore.hasGitHubToken(),
  }
}

export function buildSystemDiagnostics(configStore: DiagnosticsConfigStore): SystemDiagnostics {
  const errors: string[] = []
  const sgaHome = safeSgaHome(errors)
  const sessionDir = process.env.SESSION_DIR ?? join(process.cwd(), 'data', 'sessions')
  const configDir = process.env.COMFYUI_CONFIG_DIR ?? join(sgaHome, 'comfyui')
  const providers = buildProviderDiagnostics(configStore)
  const codex = getCodexCapabilityStatus()
  const mcpServers = getAllMCPServers()
  const missingSessionDir = !existsSync(sessionDir)

  if (missingSessionDir) errors.push(`Session directory does not exist yet: ${sessionDir}`)
  if (providers.count === 0) errors.push('No ComfyUI AI provider is configured.')
  if (providers.missingKeys.length > 0) errors.push('One or more providers are missing API keys.')
  if (codex.state === 'failed') errors.push(codex.message)

  return {
    status: errors.length > 0 ? 'degraded' : 'ok',
    backend: {
      healthy: true,
      service: 'comfyui-workflow-agent',
      nodeVersion: process.version,
      cwdConfigured: process.cwd().length > 0,
      sgaHomeConfigured: sgaHome.length > 0,
      sessionDirExists: !missingSessionDir,
      configDirExists: existsSync(configDir),
    },
    providers: {
      ...providers,
      sgaProviderCount: getAllProviderNames().length,
      sgaDefaultProvider: getDefaultProviderName() || null,
    },
    codex,
    mcp: {
      connected: mcpServers.filter(s => s.status === 'connected').length,
      total: mcpServers.length,
      servers: mcpServers.map(s => ({
        name: s.name,
        status: s.status,
        toolCount: s.tools.length,
        ...(s.error ? { error: s.error } : {}),
      })),
    },
    comfyui: {
      reachable: null,
      baseUrl: process.env.COMFYUI_BASE_URL ?? null,
      note: 'Reachability is not probed by default to keep diagnostics side-effect free.',
    },
    errors,
  }
}

function safeSgaHome(errors: string[]): string {
  try {
    return getSgaHome()
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    errors.push(`Failed to resolve SGA_HOME: ${msg}`)
    return process.env.SGA_HOME ?? join(process.cwd(), 'data', '.sga')
  }
}
