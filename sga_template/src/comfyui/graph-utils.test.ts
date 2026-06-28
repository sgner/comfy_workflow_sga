import { describe, expect, it } from 'vitest'

function makeWorkflow(nodes: any[], links: any[]) {
  return { nodes, links, last_node_id: nodes.length, last_link_id: links.length }
}

describe('graph-utils', () => {
  it('buildNodeMap indexes nodes by numeric id with null def', async () => {
    const { buildNodeMap } = await import('./graph-utils.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'KSampler' },
        { id: 2, type: 'CLIPTextEncode' },
      ],
      [],
    )
    const map = buildNodeMap(wf)
    expect(map.size).toBe(2)
    expect(map.get(1)?.node.type).toBe('KSampler')
    expect(map.get(1)?.def).toBeNull()
    expect(map.get(2)?.id).toBe(2)
  })

  it('buildNodeMap skips nodes without id', async () => {
    const { buildNodeMap } = await import('./graph-utils.js')
    const wf = makeWorkflow([{ id: 1, type: 'X' }, { type: 'NoId' }], [])
    const map = buildNodeMap(wf)
    expect(map.size).toBe(1)
  })

  it('buildLinkList parses link arrays into GraphLink objects', async () => {
    const { buildLinkList } = await import('./graph-utils.js')
    const wf = makeWorkflow([], [
      [1, 10, 0, 20, 1, 'MODEL'],
      [2, 11, 0, 21, 0, 'CONDITIONING'],
    ])
    const links = buildLinkList(wf)
    expect(links).toHaveLength(2)
    expect(links[0]).toEqual({
      id: 1, fromNodeId: 10, fromSlot: 0, toNodeId: 20, toSlot: 1, type: 'MODEL',
    })
  })

  it('buildLinkList skips malformed links', async () => {
    const { buildLinkList } = await import('./graph-utils.js')
    const wf = makeWorkflow([], [
      [1, 10, 0, 20, 1, 'MODEL'],
      [2, 11],  // too short
      'not-an-array',
    ])
    const links = buildLinkList(wf)
    expect(links).toHaveLength(1)
  })

  it('isReroute, isPrimitive, isNote identify node types', async () => {
    const { isReroute, isPrimitive, isNote } = await import('./graph-utils.js')
    expect(isReroute({ type: 'Reroute' })).toBe(true)
    expect(isReroute({ type: 'KSampler' })).toBe(false)
    expect(isPrimitive({ type: 'PrimitiveNode' })).toBe(true)
    expect(isPrimitive({ type: 'Reroute' })).toBe(false)
    expect(isNote({ type: 'Note' })).toBe(true)
    expect(isNote({ type: 'PrimitiveNode' })).toBe(false)
  })
})
