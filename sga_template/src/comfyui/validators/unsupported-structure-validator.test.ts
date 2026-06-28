import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const sampleObjectInfo = {
  Reroute: {
    name: 'Reroute', category: 'utils',
    input: { required: {} },
    output: ['*'], output_name: ['*'],
  },
  PrimitiveNode: {
    name: 'PrimitiveNode', category: 'utils',
    input: { required: { "value": ["STRING"] } },
    output: ['*'], output_name: ['*'],
  },
  Note: {
    name: 'Note', category: 'utils',
    input: { required: { "text": ["STRING"] } },
    output: [], output_name: [],
  },
  KSampler: {
    name: 'KSampler', category: 'sampling',
    input: { required: { "seed": ["INT"] } },
    output: ['LATENT'], output_name: ['LATENT'],
  },
}

function makeWorkflow(nodes: any[], links: any[]) {
  return { nodes, links, last_node_id: nodes.length, last_link_id: links.length }
}

describe('unsupported-structure-validator', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-unsup-str-'))
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

  it('returns empty for clean workflow', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const wf = makeWorkflow([], [])
    expect(await validateUnsupportedStructures(wf)).toEqual([])
  })

  it('detects unconnected Reroute (input null, output empty)', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'Reroute', inputs: [{ name: '*', type: '*', link: null }], outputs: [{ name: '*', type: '*', links: [] }] }],
      [],
    )
    const issues = await validateUnsupportedStructures(wf)
    const unconnected = issues.find(i => i.id.endsWith(':reroute_unconnected'))
    expect(unconnected).toBeDefined()
    expect(unconnected?.severity).toBe('info')
    expect(unconnected?.category).toBe('unsupported_structure')
  })

  it('detects orphaned Note', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'Note', widgets_values: ['a note'] }],
      [],
    )
    const issues = await validateUnsupportedStructures(wf)
    const orphaned = issues.find(i => i.id.endsWith(':orphaned_aux'))
    expect(orphaned).toBeDefined()
    expect(orphaned?.severity).toBe('info')
  })

  it('detects orphaned PrimitiveNode', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'PrimitiveNode', widgets_values: ['hello'], outputs: [{ name: '*', type: '*', links: [] }] }],
      [],
    )
    const issues = await validateUnsupportedStructures(wf)
    const orphaned = issues.find(i => i.id.endsWith(':orphaned_aux'))
    expect(orphaned).toBeDefined()
  })

  it('allows reroute chain at depth 8 (default threshold)', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const nodes: any[] = []
    const links: any[] = []
    for (let i = 1; i <= 8; i++) {
      nodes.push({ id: i, type: 'Reroute', inputs: [{ name: '*', type: '*', link: i > 1 ? i - 1 : null }], outputs: [{ name: '*', type: '*', links: i < 8 ? [i] : [] }] })
      if (i < 8) links.push([i, i, 0, i + 1, 0, '*'])
    }
    const wf = makeWorkflow(nodes, links)
    const issues = await validateUnsupportedStructures(wf)
    const deep = issues.find(i => i.id.endsWith(':deep_reroute_chain'))
    expect(deep).toBeUndefined()
  })

  it('detects reroute chain deeper than 8', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const nodes: any[] = []
    const links: any[] = []
    for (let i = 1; i <= 10; i++) {
      nodes.push({ id: i, type: 'Reroute', inputs: [{ name: '*', type: '*', link: i > 1 ? i - 1 : null }], outputs: [{ name: '*', type: '*', links: i < 10 ? [i] : [] }] })
      if (i < 10) links.push([i, i, 0, i + 1, 0, '*'])
    }
    const wf = makeWorkflow(nodes, links)
    const issues = await validateUnsupportedStructures(wf)
    const deep = issues.find(i => i.id.endsWith(':deep_reroute_chain'))
    expect(deep).toBeDefined()
    expect(deep?.severity).toBe('info')
  })

  it('terminates on cyclic reroute chain (does not infinite-loop)', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    // Cyclic: 1→2→3→2 (node 1 has no incoming reroute link; 3→2 creates a cycle)
    const wf = makeWorkflow(
      [
        { id: 1, type: 'Reroute', inputs: [{ name: '*', type: '*', link: null }], outputs: [{ name: '*', type: '*', links: [1] }] },
        { id: 2, type: 'Reroute', inputs: [{ name: '*', type: '*', link: 1 }], outputs: [{ name: '*', type: '*', links: [2] }] },
        { id: 3, type: 'Reroute', inputs: [{ name: '*', type: '*', link: 2 }], outputs: [{ name: '*', type: '*', links: [3] }] },
      ],
      [[1, 1, 0, 2, 0, '*'], [2, 2, 0, 3, 0, '*'], [3, 3, 0, 2, 0, '*']],
    )
    // Should terminate (not hang). Walk: 1→2→3, then next=2 is already visited → break. Depth=3 ≤ 8.
    const issues = await validateUnsupportedStructures(wf)
    const deep = issues.find(i => i.id.endsWith(':deep_reroute_chain'))
    expect(deep).toBeUndefined()
  })

  it('detects PrimitiveNode multi-type output', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'PrimitiveNode', widgets_values: ['hello'], outputs: [{ name: '*', type: '*', links: [1, 2] }] },
        { id: 2, type: 'KSampler', inputs: [{ name: 'seed', type: 'INT', link: 1 }] },
        { id: 3, type: 'KSampler', inputs: [{ name: 'seed', type: 'STRING', link: 2 }] },
      ],
      [[1, 1, 0, 2, 0, 'INT'], [2, 1, 0, 3, 0, 'STRING']],
    )
    const issues = await validateUnsupportedStructures(wf)
    const multiType = issues.find(i => i.id.endsWith(':primitive_multi_type'))
    expect(multiType).toBeDefined()
    expect(multiType?.severity).toBe('info')
  })

  it('issues carry source: native', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'Reroute', inputs: [{ name: '*', type: '*', link: null }], outputs: [{ name: '*', type: '*', links: [] }] }],
      [],
    )
    const issues = await validateUnsupportedStructures(wf)
    expect(issues.every(i => i.source === 'native')).toBe(true)
    expect(issues.every(i => typeof i.id === 'string' && i.id.length > 0)).toBe(true)
  })
})
