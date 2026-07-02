import { describe, expect, it } from 'vitest'
import { compileGraph } from './graph-walker.js'

describe('compileGraph', () => {
  it('returns empty graph for empty workflow', () => {
    const graph = compileGraph({ nodes: [], links: [] })
    expect(graph.nodes.size).toBe(0)
    expect(graph.links).toHaveLength(0)
    expect(graph.linksByNode.size).toBe(0)
  })

  it('builds nodes map from workflow nodes with null def', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'KSampler' },
        { id: 2, type: 'CLIPTextEncode' },
      ],
      links: [],
    })
    expect(graph.nodes.size).toBe(2)
    expect(graph.nodes.get(1)?.node.type).toBe('KSampler')
    expect(graph.nodes.get(1)?.def).toBeNull()
    expect(graph.nodes.get(2)?.id).toBe(2)
  })

  it('builds links array and linksByNode index with incoming/outgoing', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    expect(graph.links).toHaveLength(1)
    expect(graph.links[0]).toEqual({
      id: 1, fromNodeId: 1, fromSlot: 0, toNodeId: 2, toSlot: 0, type: 'MODEL',
    })
    expect(graph.linksByNode.get(1)?.outgoing).toHaveLength(1)
    expect(graph.linksByNode.get(1)?.incoming).toHaveLength(0)
    expect(graph.linksByNode.get(2)?.incoming).toHaveLength(1)
    expect(graph.linksByNode.get(2)?.outgoing).toHaveLength(0)
    // Same link object reference shared between incoming and outgoing
    expect(graph.linksByNode.get(1)?.outgoing[0]).toBe(graph.links[0])
    expect(graph.linksByNode.get(2)?.incoming[0]).toBe(graph.links[0])
  })

  it('handles multiple links per node', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1, 2] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
        { id: 3, type: 'C', inputs: [{ name: 'in', type: 'MODEL', link: 2 }] },
      ],
      links: [
        [1, 1, 0, 2, 0, 'MODEL'],
        [2, 1, 0, 3, 0, 'MODEL'],
      ],
    })
    expect(graph.linksByNode.get(1)?.outgoing).toHaveLength(2)
    expect(graph.linksByNode.get(2)?.incoming).toHaveLength(1)
    expect(graph.linksByNode.get(3)?.incoming).toHaveLength(1)
  })

  it('returns no linksByNode entry for nodes with no links', () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'A' }],
      links: [],
    })
    expect(graph.linksByNode.has(1)).toBe(false)
  })
})
