import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { bidirectionalLinkRule } from './bidirectional-link.js'

describe('bidirectionalLinkRule', () => {
  it('returns no issues for clean graph', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    expect(bidirectionalLinkRule.run(graph)).toEqual([])
  })

  it('detects bidirectional inconsistency', async () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [null] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: null }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    const issues = await bidirectionalLinkRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('illegal_link:1:bidirectional')
    expect(issues[0].severity).toBe('error')
    expect(issues[0].source).toBe('native')
  })

  it('skips dangling and self-loop and slot_oob links (parity guards)', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: null }] },
      ],
      links: [
        [1, 1, 0, 99, 0, 'MODEL'],   // dangling — skip
        [2, 1, 0, 1, 0, 'MODEL'],    // self-loop — skip
        [3, 1, 5, 2, 0, 'MODEL'],    // slot_oob — skip
      ],
    })
    expect(bidirectionalLinkRule.run(graph)).toEqual([])
  })
})
