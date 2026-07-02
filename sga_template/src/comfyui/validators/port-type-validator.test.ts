import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const sampleObjectInfo = {
  CLIPTextEncode: {
    name: 'CLIPTextEncode',
    category: 'conditioning',
    input: { required: { text: ['STRING'], clip: ['CLIP'] } },
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

function makeWorkflow(nodes: any[], links: any[]) {
  return { nodes, links, last_node_id: nodes.length, last_link_id: links.length }
}

describe('port-type-validator', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-port-val-'))
    vi.stubEnv('SGA_HOME', tmpHome)
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

  it('returns empty array for a clean workflow', async () => {
    const { validatePortTypes } = await import('./port-type-validator.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'CLIPTextEncode', outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [1] }] },
        { id: 2, type: 'KSampler', inputs: [{ name: 'positive', type: 'CONDITIONING', link: 1 }] },
      ],
      [[1, 1, 0, 2, 0, 'CONDITIONING']],
    )
    const issues = await validatePortTypes(wf)
    expect(issues).toEqual([])
  })

  it('detects port type mismatch on incompatible link', async () => {
    const { validatePortTypes } = await import('./port-type-validator.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'KSampler', outputs: [{ name: 'LATENT', type: 'LATENT', links: [1] }] },
        { id: 2, type: 'CLIPTextEncode', inputs: [{ name: 'clip', type: 'CLIP', link: 1 }] },
      ],
      [[1, 1, 0, 2, 0, 'LATENT']],
    )
    const issues = await validatePortTypes(wf)
    expect(issues.length).toBe(1)
    expect(issues[0].severity).toBe('error')
    expect(issues[0].category).toBe('port_type_mismatch')
    expect(issues[0].nodeIds).toEqual([1, 2])
    expect(issues[0].message).toMatch(/LATENT.*CLIP/)
  })

  it('flags orphaned outputs as info', async () => {
    const { validatePortTypes } = await import('./port-type-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'CLIPTextEncode', outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: null }] }],
      [],
    )
    const issues = await validatePortTypes(wf)
    const orphan = issues.find(i => i.category === 'orphaned_output')
    expect(orphan).toBeDefined()
    expect(orphan?.severity).toBe('info')
    expect(orphan?.nodeId).toBe(1)
  })

  it('skips muted nodes (mode === 4)', async () => {
    const { validatePortTypes } = await import('./port-type-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'CLIPTextEncode', mode: 4, outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: null }] }],
      [],
    )
    const issues = await validatePortTypes(wf)
    expect(issues.find(i => i.category === 'orphaned_output')).toBeUndefined()
  })

  it('warns on unknown node type', async () => {
    const { validatePortTypes } = await import('./port-type-validator.js')
    const wf = makeWorkflow([{ id: 1, type: 'SomeCustomNode', outputs: [], inputs: [] }], [])
    const issues = await validatePortTypes(wf)
    const unknown = issues.find(i => i.category === 'unknown_node_type')
    expect(unknown).toBeDefined()
    expect(unknown?.severity).toBe('warning')
    expect(unknown?.nodeType).toBe('SomeCustomNode')
  })

  it('issues carry source: native so UI renders them', async () => {
    const { validatePortTypes } = await import('./port-type-validator.js')
    const wf = makeWorkflow([{ id: 1, type: 'Unknown', outputs: [], inputs: [] }], [])
    const issues = await validatePortTypes(wf)
    expect(issues.every(i => i.source === 'native')).toBe(true)
    expect(issues.every(i => typeof i.id === 'string' && i.id.length > 0)).toBe(true)
  })
})
