import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { rerouteUnconnectedRule } from './reroute-unconnected.js'

describe('rerouteUnconnectedRule', () => {
  it('returns no issues for connected reroute', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'Reroute', inputs: [{ name: '*', type: '*', link: 1 }], outputs: [{ name: '*', type: '*', links: [2] }] },
        { id: 2, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 3, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 2 }] },
      ],
      links: [
        [1, 2, 0, 1, 0, 'MODEL'],
        [2, 1, 0, 3, 0, 'MODEL'],
      ],
    })
    expect(rerouteUnconnectedRule.run(graph)).toEqual([])
  })

  it('detects reroute with no input', async () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'Reroute', inputs: [{ name: '*', type: '*', link: null }], outputs: [{ name: '*', type: '*', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    const issues = await rerouteUnconnectedRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('unsupported_structure:1:reroute_unconnected')
    expect(issues[0].severity).toBe('info')
    expect(issues[0].source).toBe('native')
  })

  it('detects reroute with no output', async () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'Reroute', inputs: [{ name: '*', type: '*', link: 1 }], outputs: [{ name: '*', type: '*', links: [] }] },
        { id: 2, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
      ],
      links: [[1, 2, 0, 1, 0, 'MODEL']],
    })
    const issues = await rerouteUnconnectedRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('unsupported_structure:1:reroute_unconnected')
  })

  it('skips non-reroute nodes', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'KSampler', inputs: [{ name: 'in', type: 'MODEL', link: null }] },
      ],
      links: [],
    })
    expect(rerouteUnconnectedRule.run(graph)).toEqual([])
  })
})
