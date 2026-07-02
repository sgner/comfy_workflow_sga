import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { compileGraph } from '../graph-walker.js'

const sampleObjectInfo = {
  PrimitiveNode: {
    name: 'PrimitiveNode', category: 'utils',
    input: { required: { value: ['STRING'] } },
    output: ['*'], output_name: ['*'],
  },
  KSampler: {
    name: 'KSampler', category: 'sampling',
    input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT'] } },
    output: ['LATENT'], output_name: ['LATENT'],
  },
  CLIPTextEncode: {
    name: 'CLIPTextEncode', category: 'conditioning',
    input: { required: { text: ['STRING'], clip: ['CLIP'] } },
    output: ['CONDITIONING'], output_name: ['CONDITIONING'],
  },
}

describe('primitiveMultiTypeRule', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-pmt-'))
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

  it('returns no issues for PrimitiveNode with single output type', async () => {
    const { primitiveMultiTypeRule } = await import('./primitive-multi-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'PrimitiveNode', widgets_values: ['hello'],
          outputs: [{ name: '*', type: '*', links: [1] }] },
        { id: 2, type: 'KSampler',
          inputs: [{ name: 'seed', type: 'INT', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 4, 'INT']],
    })
    expect(await primitiveMultiTypeRule.run(graph)).toEqual([])
  })

  it('detects PrimitiveNode multi-type via workflow-declared types', async () => {
    const { primitiveMultiTypeRule } = await import('./primitive-multi-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'PrimitiveNode', widgets_values: ['hello'],
          outputs: [{ name: '*', type: '*', links: [1, 2] }] },
        { id: 2, type: 'CLIPTextEncode',
          inputs: [{ name: 'text', type: 'STRING', link: 1 }, { name: 'clip', type: 'CLIP', link: null }] },
        { id: 3, type: 'KSampler',
          inputs: [{ name: 'seed', type: 'INT', link: 2 }] },
      ],
      links: [
        [1, 1, 0, 2, 0, 'STRING'],
        [2, 1, 0, 3, 4, 'INT'],
      ],
    })
    const issues = await primitiveMultiTypeRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('unsupported_structure:1:primitive_multi_type')
    expect(issues[0].severity).toBe('info')
    expect(issues[0].source).toBe('native')
  })

  it('skips PrimitiveNode with fewer than 2 output links', async () => {
    const { primitiveMultiTypeRule } = await import('./primitive-multi-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'PrimitiveNode', widgets_values: ['hello'],
          outputs: [{ name: '*', type: '*', links: [1] }] },
        { id: 2, type: 'KSampler',
          inputs: [{ name: 'seed', type: 'INT', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 4, 'INT']],
    })
    expect(await primitiveMultiTypeRule.run(graph)).toEqual([])
  })

  it('skips non-Primitive nodes', async () => {
    const { primitiveMultiTypeRule } = await import('./primitive-multi-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'KSampler',
          outputs: [{ name: 'LATENT', type: 'LATENT', links: [1, 2] }] },
        { id: 2, type: 'KSampler', inputs: [{ name: 'seed', type: 'INT', link: 1 }] },
        { id: 3, type: 'KSampler', inputs: [{ name: 'seed', type: 'INT', link: 2 }] },
      ],
      links: [[1, 1, 0, 2, 4, 'INT'], [2, 1, 0, 3, 4, 'INT']],
    })
    expect(await primitiveMultiTypeRule.run(graph)).toEqual([])
  })
})
