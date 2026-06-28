import { describe, expect, it, vi } from 'vitest'
import { buildProviderDiagnostics, buildSystemDiagnostics } from './diagnostics.js'

vi.mock('../mcp/index.js', () => ({
  getAllMCPServers: () => [],
}))

vi.mock('../providers/provider-store.js', () => ({
  getAllProviderNames: () => [],
  getDefaultProviderName: () => undefined,
}))

vi.mock('./codex-status.js', () => ({
  getCodexCapabilityStatus: () => ({
    enabled: false,
    mode: 'false',
    state: 'disabled',
    build: { status: 'idle', lastCheckedAt: '2026-06-28T00:00:00.000Z', error: null },
    binary: { available: false },
    canSwitchToCodex: false,
    message: 'Codex disabled.',
  }),
}))

describe('provider diagnostics', () => {
  it('redacts provider secrets while reporting key presence', () => {
    const diagnostics = buildProviderDiagnostics({
      getConfigs: () => [
        {
          id: 'openai',
          name: 'OpenAI',
          provider: 'openai',
          api_key: 'sk-secret-value',
          is_default: true,
        },
        {
          id: 'local',
          name: 'Local',
          provider: 'openai-compatible',
          is_default: false,
        },
      ],
      getDefaultConfig: () => ({ id: 'openai', name: 'OpenAI' }),
      hasGitHubToken: () => true,
    })

    expect(JSON.stringify(diagnostics)).not.toContain('sk-secret-value')
    expect(diagnostics.providers[0]?.hasApiKey).toBe(true)
    expect(diagnostics.missingKeys).toEqual(['Local'])
    expect(diagnostics.hasGitHubToken).toBe(true)
  })
})

describe('buildSystemDiagnostics', () => {
  it('returns degraded status when no providers configured', () => {
    const diag = buildSystemDiagnostics({
      getConfigs: () => [],
      getDefaultConfig: () => undefined,
      hasGitHubToken: () => false,
    })

    expect(diag.status).toBe('degraded')
    expect(diag.errors.length).toBeGreaterThan(0)
    expect(diag.errors.some(e => e.includes('No ComfyUI AI provider'))).toBe(true)
  })

  it('returns degraded status when providers missing API keys', () => {
    const diag = buildSystemDiagnostics({
      getConfigs: () => [
        { id: 'p1', name: 'P1', provider: 'openai', is_default: true },
      ],
      getDefaultConfig: () => ({ id: 'p1', name: 'P1' }),
      hasGitHubToken: () => false,
    })

    expect(diag.status).toBe('degraded')
    expect(diag.providers.missingKeys).toEqual(['P1'])
    expect(diag.errors.some(e => e.includes('missing API keys'))).toBe(true)
  })

  it('returns ok status when providers have keys and session dir exists', () => {
    const diag = buildSystemDiagnostics({
      getConfigs: () => [
        { id: 'p1', name: 'P1', provider: 'openai', api_key: 'sk-test', is_default: true },
      ],
      getDefaultConfig: () => ({ id: 'p1', name: 'P1' }),
      hasGitHubToken: () => true,
    })

    expect(diag.status).toBe('ok')
    expect(diag.errors).toEqual([])
    expect(diag.backend.healthy).toBe(true)
    expect(diag.mcp.connected).toBe(0)
  })
})
