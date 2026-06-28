import { describe, expect, it, vi } from 'vitest'

vi.mock('../agents/codex/detect.js', () => ({
  detectCodexBinary: () => null,
}))

describe('getCodexCapabilityStatus', () => {
  it('reports disabled when SGA_ENABLE_CODEX=false', async () => {
    vi.resetModules()
    vi.stubEnv('SGA_ENABLE_CODEX', 'false')
    vi.stubEnv('SGA_HOME', process.cwd())

    const { getCodexCapabilityStatus, codexSwitchError } = await import('./codex-status.js')
    const status = getCodexCapabilityStatus()

    expect(status.enabled).toBe(false)
    expect(status.state).toBe('disabled')
    expect(status.canSwitchToCodex).toBe(false)
    expect(codexSwitchError(status)).toMatchObject({ code: 'CODEX_DISABLED' })
  })
})
