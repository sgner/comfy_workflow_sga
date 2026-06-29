import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { deepRerouteChainRule } from './deep-reroute-chain.js'

function makeChain(depth: number) {
  const nodes: any[] = []
  const links: any[] = []
  for (let i = 1; i <= depth; i++) {
    nodes.push({
      id: i, type: 'Reroute',
      inputs: [{ name: '*', type: '*', link: i > 1 ? i - 1 : null }],
      outputs: [{ name: '*', type: '*', links: i < depth ? [i] : [] }],
    })
    if (i < depth) links.push([i, i, 0, i + 1, 0, '*'])
  }
  return { nodes, links }
}

describe('deepRerouteChainRule', () => {
  it('returns no issues for chain at depth 8 (default threshold)', () => {
    const wf = makeChain(8)
    const graph = compileGraph(wf)
    expect(deepRerouteChainRule.run(graph)).toEqual([])
  })

  it('detects chain deeper than 8', async () => {
    const wf = makeChain(10)
    const graph = compileGraph(wf)
    const issues = await deepRerouteChainRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('unsupported_structure:1:deep_reroute_chain')
    expect(issues[0].severity).toBe('info')
    expect(issues[0].source).toBe('native')
  })

  it('terminates on cycle (visited set prevents infinite loop)', () => {
    // Two reroutes pointing at each other — cycle
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'Reroute', inputs: [{ name: '*', type: '*', link: 2 }], outputs: [{ name: '*', type: '*', links: [1] }] },
        { id: 2, type: 'Reroute', inputs: [{ name: '*', type: '*', link: 1 }], outputs: [{ name: '*', type: '*', links: [2] }] },
      ],
      links: [
        [1, 1, 0, 2, 0, '*'],
        [2, 2, 0, 1, 0, '*'],
      ],
    })
    // Must not hang — visited set breaks the cycle
    const issues = deepRerouteChainRule.run(graph)
    // Depth 2, below threshold of 8 — no issue
    expect(issues).toEqual([])
  })

  it('returns no issues when no reroutes exist', () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'KSampler' }],
      links: [],
    })
    expect(deepRerouteChainRule.run(graph)).toEqual([])
  })
})
