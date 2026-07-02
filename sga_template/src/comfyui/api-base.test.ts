import { describe, expect, it, vi, afterEach } from 'vitest'

describe('api-base', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

  it('uses defaults when env unset', async () => {
    vi.stubEnv('COMFYUI_API_HOST', '')
    vi.stubEnv('COMFYUI_API_PORT', '')
    const { getComfyUIApiBaseUrl } = await import('./api-base.js')
    expect(getComfyUIApiBaseUrl()).toBe('http://127.0.0.1:8188')
  })

  it('honors env overrides', async () => {
    vi.stubEnv('COMFYUI_API_HOST', '10.0.0.5')
    vi.stubEnv('COMFYUI_API_PORT', '8199')
    const { getComfyUIApiBaseUrl } = await import('./api-base.js')
    expect(getComfyUIApiBaseUrl()).toBe('http://10.0.0.5:8199')
  })

  it('strips trailing slash from host', async () => {
    vi.stubEnv('COMFYUI_API_HOST', 'host.local/')
    vi.stubEnv('COMFYUI_API_PORT', '8188')
    const { getComfyUIApiBaseUrl } = await import('./api-base.js')
    expect(getComfyUIApiBaseUrl()).toBe('http://host.local:8188')
  })

  it('exports a 30s default timeout', async () => {
    const { COMFYUI_DEFAULT_TIMEOUT_MS } = await import('./api-base.js')
    expect(COMFYUI_DEFAULT_TIMEOUT_MS).toBe(30000)
  })
})
