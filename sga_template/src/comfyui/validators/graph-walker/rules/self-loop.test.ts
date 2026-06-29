import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { selfLoopRule } from './self-loop.js'

describe('selfLoopRule', () => {
  it('returns no issues for clean graph', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    expect(selfLoopRule.run(graph)).toEqual([])
  })

  it('detects self-loop', async () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', inputs: [{ name: 'in', type: 'MODEL', link: 1 }], outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
      ],
      links: [[1, 1, 0, 1, 0, 'MODEL']],
    })
    const issues = await selfLoopRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('illegal_link:1:self_loop')
    expect(issues[0].severity).toBe('error')
    expect(issues[0].source).toBe('native')
  })

  it('skips dangling links (parity with Approach A continue pattern)', () => {
    const graph = compileGraph({
      nodes: [],
      links: [[1, 1, 0, 1, 0, 'MODEL']],
    })
    expect(selfLoopRule.run(graph)).toEqual([])
  })
})
