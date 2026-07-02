import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { orphanedAuxRule } from './orphaned-aux.js'

describe('orphanedAuxRule', () => {
  it('returns no issues for connected Note', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'Note', widgets_values: ['a note'], outputs: [{ name: '*', type: '*', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    expect(orphanedAuxRule.run(graph)).toEqual([])
  })

  it('detects orphaned Note', async () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'Note', widgets_values: ['a note'] }],
      links: [],
    })
    const issues = await orphanedAuxRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('unsupported_structure:1:orphaned_aux')
    expect(issues[0].severity).toBe('info')
    expect(issues[0].source).toBe('native')
  })

  it('detects orphaned PrimitiveNode', async () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'PrimitiveNode', widgets_values: ['hello'], outputs: [{ name: '*', type: '*', links: [] }] }],
      links: [],
    })
    const issues = await orphanedAuxRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('unsupported_structure:1:orphaned_aux')
  })

  it('skips non-aux nodes with no links', () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'KSampler' }],
      links: [],
    })
    expect(orphanedAuxRule.run(graph)).toEqual([])
  })
})
