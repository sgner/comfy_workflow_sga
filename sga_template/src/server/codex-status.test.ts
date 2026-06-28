import { describe, expect, it, vi } from 'vitest'

import type { CodexCapabilityStatus } from './codex-status.js'

// 默认 mock: binary 不可用
vi.mock('../agents/codex/detect.js', () => ({
  detectCodexBinary: () => null,
}))

function mockBuildStatus(status: string, error: string | null = null, pid?: number) {
  vi.doMock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>()
    return {
      ...actual,
      existsSync: () => status !== 'idle',
      readFileSync: () => JSON.stringify({ status, error, pid, updated_at: '2026-06-28T00:00:00.000Z' }),
    }
  })
}

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

  it('reports failed when build status is failed', async () => {
    vi.resetModules()
    vi.stubEnv('SGA_ENABLE_CODEX', 'auto')
    vi.stubEnv('SGA_HOME', process.cwd())
    mockBuildStatus('failed', 'build error')

    const { getCodexCapabilityStatus, codexSwitchError } = await import('./codex-status.js')
    const status = getCodexCapabilityStatus()

    expect(status.state).toBe('failed')
    expect(status.canSwitchToCodex).toBe(false)
    expect(status.message).toBe('build error')
    const swErr = codexSwitchError(status)
    expect(swErr).toMatchObject({ code: 'CODEX_BUILD_FAILED' })
  })

  it('reports building when build status is building', async () => {
    vi.resetModules()
    vi.stubEnv('SGA_ENABLE_CODEX', 'auto')
    vi.stubEnv('SGA_HOME', process.cwd())
    mockBuildStatus('building')

    const { getCodexCapabilityStatus } = await import('./codex-status.js')
    const status = getCodexCapabilityStatus()

    expect(status.state).toBe('building')
    expect(status.canSwitchToCodex).toBe(false)
  })

  it('reports unavailable when no binary and no source', async () => {
    vi.resetModules()
    vi.stubEnv('SGA_ENABLE_CODEX', 'auto')
    vi.stubEnv('SGA_HOME', process.cwd())
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>()
      return {
        ...actual,
        existsSync: () => false,
        readFileSync: () => '',
      }
    })

    const { getCodexCapabilityStatus, codexSwitchError } = await import('./codex-status.js')
    const status = getCodexCapabilityStatus()

    expect(status.state).toBe('unavailable')
    expect(status.canSwitchToCodex).toBe(false)
    expect(codexSwitchError(status)).toMatchObject({ code: 'CODEX_NOT_READY' })
  })

  it('reports ready when binary is available', async () => {
    vi.resetModules()
    vi.stubEnv('SGA_ENABLE_CODEX', 'auto')
    vi.stubEnv('SGA_HOME', process.cwd())
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>()
      return {
        ...actual,
        existsSync: () => false,
        readFileSync: () => '',
      }
    })
    vi.doMock('../agents/codex/detect.js', () => ({
      detectCodexBinary: () => ({ path: '/fake/codex', source: 'test', revision: 'abc123' }),
    }))

    const { getCodexCapabilityStatus, codexSwitchError } = await import('./codex-status.js')
    const status = getCodexCapabilityStatus()

    expect(status.state).toBe('ready')
    expect(status.canSwitchToCodex).toBe(true)
    expect(codexSwitchError(status)).toBeNull()
  })
})
