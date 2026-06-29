import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { compileGraph } from '../graph-walker.js'

const sampleObjectInfo = {
  CheckpointLoaderSimple: {
    name: 'CheckpointLoaderSimple', category: 'loaders',
    input: { required: { ckpt_name: [['model1.safetensors']] } },
    output: ['MODEL', 'CLIP', 'VAE'], output_name: ['MODEL', 'CLIP', 'VAE'],
  },
}

describe('missingModelRule', () => {
  let tmpHome: string
  let tmpBaseDir: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-mm-'))
    tmpBaseDir = await fs.mkdtemp(join(tmpdir(), 'sga-comfyui-'))
    vi.stubEnv('SGA_HOME', tmpHome)
    vi.stubEnv('COMFYUI_BASE_DIR', tmpBaseDir)
    vi.stubEnv('COMFYUI_API_HOST', '127.0.0.1')
    vi.stubEnv('COMFYUI_API_PORT', '8188')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    vi.resetModules()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fs.rm(tmpHome, { recursive: true, force: true })
    await fs.rm(tmpBaseDir, { recursive: true, force: true })
  })

  it('returns no issues when model exists on disk', async () => {
    const dir = join(tmpBaseDir, 'models', 'checkpoints')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'model1.safetensors'), 'fake')
    const { missingModelRule } = await import('./missing-model.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['model1.safetensors'] }],
      links: [],
    })
    expect(await missingModelRule.run(graph)).toEqual([])
  })

  it('detects missing model file', async () => {
    const { missingModelRule } = await import('./missing-model.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['nonexistent.safetensors'] }],
      links: [],
    })
    const issues = await missingModelRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('missing_model:1')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].category).toBe('missing_model')
    expect(issues[0].source).toBe('native')
  })

  it('skips nodes with no widgets_values', async () => {
    const { missingModelRule } = await import('./missing-model.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'CheckpointLoaderSimple' }],
      links: [],
    })
    expect(await missingModelRule.run(graph)).toEqual([])
  })

  it('skips unknown loader types', async () => {
    const { missingModelRule } = await import('./missing-model.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'SomeUnknownLoader', widgets_values: ['something'] }],
      links: [],
    })
    expect(await missingModelRule.run(graph)).toEqual([])
  })
})
