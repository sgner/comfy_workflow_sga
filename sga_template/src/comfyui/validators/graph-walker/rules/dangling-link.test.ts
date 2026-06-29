import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { danglingLinkRule } from './dangling-link.js'

describe('danglingLinkRule', () => {
  it('returns no issues for clean graph', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    expect(danglingLinkRule.run(graph)).toEqual([])
  })

  it('detects dangling link when toNodeId missing', async () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] }],
      links: [[1, 1, 0, 99, 0, 'MODEL']],
    })
    const issues = await danglingLinkRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('illegal_link:1:dangling')
    expect(issues[0].severity).toBe('error')
    expect(issues[0].category).toBe('illegal_link')
    expect(issues[0].source).toBe('native')
  })

  it('detects dangling link when fromNodeId missing', async () => {
    const graph = compileGraph({
      nodes: [{ id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] }],
      links: [[1, 99, 0, 2, 0, 'MODEL']],
    })
    const issues = await danglingLinkRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('illegal_link:1:dangling')
  })
})
