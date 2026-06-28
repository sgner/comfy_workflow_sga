import { describe, expect, it, vi } from 'vitest'
import { buildProviderDiagnostics } from './diagnostics.js'

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
