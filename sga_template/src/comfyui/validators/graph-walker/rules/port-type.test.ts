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
  CLIPTextEncode: {
    name: 'CLIPTextEncode', category: 'conditioning',
    input: { required: { text: ['STRING'], clip: ['CLIP'] } },
    output: ['CONDITIONING'], output_name: ['CONDITIONING'],
  },
  KSampler: {
    name: 'KSampler', category: 'sampling',
    input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT'] } },
    output: ['LATENT'], output_name: ['LATENT'],
  },
}

describe('portTypeRule', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-pt-'))
    vi.stubEnv('SGA_HOME', tmpHome)
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
  })

  it('emits unknown_node_type when getNodeDef returns null', async () => {
    const { portTypeRule } = await import('./port-type.js')
    const graph = compileGraph({
      nodes: [{ id: 2, type: 'CustomNode_X', inputs: [{ name: 'model', type: 'MODEL', link: null }] }],
      links: [],
    })
    const issues = await portTypeRule.run(graph)
    const unknown = issues.find(i => i.id === 'unknown_node_type:2:CustomNode_X')
    expect(unknown).toBeDefined()
    expect(unknown?.severity).toBe('warning')
    expect(unknown?.source).toBe('native')
  })

  it('emits port_type_mismatch with link id only (not nodeId:slot)', async () => {
    const { portTypeRule } = await import('./port-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['model1.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: null }, { name: 'VAE', type: 'VAE', links: null }] },
        { id: 2, type: 'CLIPTextEncode', widgets_values: ['prompt'],
          inputs: [{ name: 'text', type: 'STRING', link: 1 }, { name: 'clip', type: 'CLIP', link: null }],
          outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: null }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    const issues = await portTypeRule.run(graph)
    const mismatch = issues.find(i => i.id === 'port_type_mismatch:1')
    expect(mismatch).toBeDefined()
    expect(mismatch?.severity).toBe('error')
    expect(mismatch?.source).toBe('native')
  })

  it('emits orphaned_output for unconnected output slot', async () => {
    const { portTypeRule } = await import('./port-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['model1.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: null }, { name: 'CLIP', type: 'CLIP', links: null }, { name: 'VAE', type: 'VAE', links: null }] },
      ],
      links: [],
    })
    const issues = await portTypeRule.run(graph)
    const orphaned = issues.find(i => i.id === 'orphaned_output:1:0')
    expect(orphaned).toBeDefined()
    expect(orphaned?.severity).toBe('info')
    expect(orphaned?.source).toBe('native')
  })

  it('skips orphaned_output for muted nodes (mode === 4)', async () => {
    const { portTypeRule } = await import('./port-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', mode: 4, widgets_values: ['model1.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: null }, { name: 'CLIP', type: 'CLIP', links: null }, { name: 'VAE', type: 'VAE', links: null }] },
      ],
      links: [],
    })
    const issues = await portTypeRule.run(graph)
    expect(issues.find(i => i.id.startsWith('orphaned_output:1'))).toBeUndefined()
  })

  it('emits missing_required_widget when widgets_values too short', async () => {
    const { portTypeRule } = await import('./port-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'KSampler', widgets_values: [],
          inputs: [{ name: 'model', type: 'MODEL', link: null }, { name: 'positive', type: 'CONDITIONING', link: null }, { name: 'negative', type: 'CONDITIONING', link: null }, { name: 'latent_image', type: 'LATENT', link: null }, { name: 'seed', type: 'INT', link: null }],
          outputs: [{ name: 'LATENT', type: 'LATENT', links: null }] },
      ],
      links: [],
    })
    const issues = await portTypeRule.run(graph)
    const missing = issues.find(i => i.id === 'missing_required_widget:1')
    expect(missing).toBeDefined()
    expect(missing?.severity).toBe('warning')
    expect(missing?.source).toBe('native')
  })

  it('returns no issues for clean compatible workflow', async () => {
    const { portTypeRule } = await import('./port-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['model1.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: null }, { name: 'CLIP', type: 'CLIP', links: [1] }, { name: 'VAE', type: 'VAE', links: null }] },
        { id: 2, type: 'CLIPTextEncode', widgets_values: ['prompt'],
          inputs: [{ name: 'text', type: 'STRING', link: null }, { name: 'clip', type: 'CLIP', link: 1 }],
          outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: null }] },
      ],
      links: [[1, 1, 1, 2, 1, 'CLIP']],
    })
    const issues = await portTypeRule.run(graph)
    // CLIP -> CLIP is compatible; no mismatch
    expect(issues.find(i => i.id.startsWith('port_type_mismatch'))).toBeUndefined()
    expect(issues.find(i => i.id.startsWith('unknown_node_type'))).toBeUndefined()
  })
})
