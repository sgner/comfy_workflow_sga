import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const sampleObjectInfo = {
  CLIPTextEncode: {
    name: 'CLIPTextEncode',
    category: 'conditioning',
    description: 'Encodes a text prompt.',
    input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
    output: ['CONDITIONING'],
    output_name: ['CONDITIONING'],
  },
  KSampler: {
    name: 'KSampler',
    category: 'sampling',
    input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT'] } },
    output: ['LATENT'],
    output_name: ['LATENT'],
  },
}

describe('node-def-index', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-node-def-'))
    vi.stubEnv('SGA_HOME', tmpHome)
    vi.stubEnv('COMFYUI_API_HOST', '127.0.0.1')
    vi.stubEnv('COMFYUI_API_PORT', '8188')
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('returns null when ComfyUI unreachable and no cache exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const { getNodeDef, getNodeDefIndexStats } = await import('./node-def-index.js')
    expect(await getNodeDef('CLIPTextEncode')).toBeNull()
    expect(getNodeDefIndexStats().source).toBe('empty')
  })

  it('fetches and normalizes /object_info on first access', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    const { getNodeDef, listNodeDefNames, getNodeDefIndexStats } = await import('./node-def-index.js')
    const def = await getNodeDef('CLIPTextEncode')
    expect(def).not.toBeNull()
    expect(def?.category).toBe('conditioning')
    expect(def?.inputs).toEqual([
      { name: 'text', type: 'STRING', required: true },
      { name: 'clip', type: 'CLIP', required: true },
    ])
    expect(def?.outputs).toEqual([{ name: 'CONDITIONING', type: 'CONDITIONING' }])
    expect(await listNodeDefNames()).toEqual(['CLIPTextEncode', 'KSampler'])
    expect(getNodeDefIndexStats().source).toBe('fresh')
    expect(getNodeDefIndexStats().size).toBe(2)
  })

  it('persists cache to <SGA_HOME>/node-defs.json after fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    const { refreshNodeDefIndex } = await import('./node-def-index.js')
    await refreshNodeDefIndex()
    const raw = await fs.readFile(join(tmpHome, 'node-defs.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.fetchedAt).toBeGreaterThan(0)
    expect(parsed.entries.CLIPTextEncode.name).toBe('CLIPTextEncode')
  })

  it('loads from cache file on startup when fresh enough', async () => {
    const past = Date.now() - 10_000
    await fs.writeFile(join(tmpHome, 'node-defs.json'), JSON.stringify({ fetchedAt: past, entries: sampleObjectInfo }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('should not fetch')))
    const { getNodeDef, getNodeDefIndexStats } = await import('./node-def-index.js')
    const def = await getNodeDef('KSampler')
    expect(def?.category).toBe('sampling')
    expect(getNodeDefIndexStats().source).toBe('cache-file')
  })

  it('re-fetches when TTL has expired', async () => {
    const stale = Date.now() - 180_000
    await fs.writeFile(join(tmpHome, 'node-defs.json'), JSON.stringify({ fetchedAt: stale, entries: sampleObjectInfo }))
    let calls = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      calls++
      return { ok: true, status: 200, json: async () => sampleObjectInfo } as unknown as Response
    }))
    const { getNodeDef } = await import('./node-def-index.js')
    await getNodeDef('CLIPTextEncode')
    expect(calls).toBe(1)
  })

  it('returns null for unknown node name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    const { getNodeDef } = await import('./node-def-index.js')
    expect(await getNodeDef('DoesNotExist')).toBeNull()
  })

  it('falls back to stale cache when fetch fails but cache exists', async () => {
    const stale = Date.now() - 180_000
    await fs.writeFile(join(tmpHome, 'node-defs.json'), JSON.stringify({ fetchedAt: stale, entries: sampleObjectInfo }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const { getNodeDef, getNodeDefIndexStats } = await import('./node-def-index.js')
    const def = await getNodeDef('CLIPTextEncode')
    expect(def?.name).toBe('CLIPTextEncode')
    expect(getNodeDefIndexStats().source).toBe('cache-file')
  })

  it('handles optional inputs and multi-output nodes', async () => {
    const multiOutput = {
      CheckpointLoaderSimple: {
        name: 'CheckpointLoaderSimple',
        category: 'loaders',
        input: {
          required: { ckpt_name: [['model1.safetensors', 'model2.safetensors']] },
          optional: { config_name: ['STRING', { default: '' }] },
        },
        output: ['MODEL', 'CLIP', 'VAE'],
        output_name: ['MODEL', 'CLIP', 'VAE'],
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => multiOutput,
    } as unknown as Response))
    const { getNodeDef } = await import('./node-def-index.js')
    const def = await getNodeDef('CheckpointLoaderSimple')
    expect(def?.inputs.find(i => i.name === 'config_name')?.required).toBe(false)
    expect(def?.outputs.length).toBe(3)
  })
})
