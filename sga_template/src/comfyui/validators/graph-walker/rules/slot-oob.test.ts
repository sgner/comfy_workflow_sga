import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { slotOobRule } from './slot-oob.js'

describe('slotOobRule', () => {
  it('returns no issues for clean graph', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    expect(slotOobRule.run(graph)).toEqual([])
  })

  it('detects slot out of bounds (fromSlot >= outputs.length)', async () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 5, 2, 0, 'MODEL']],
    })
    const issues = await slotOobRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('illegal_link:1:slot_oob')
    expect(issues[0].severity).toBe('error')
    expect(issues[0].source).toBe('native')
  })

  it('detects slot out of bounds (toSlot >= inputs.length)', async () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 5, 'MODEL']],
    })
    const issues = await slotOobRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('illegal_link:1:slot_oob')
  })

  it('skips dangling links (parity with Approach A continue pattern)', () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] }],
      links: [[1, 1, 5, 99, 5, 'MODEL']],
    })
    // Dangling + slot oob — slotOobRule must skip because fromCtx/toCtx missing
    expect(slotOobRule.run(graph)).toEqual([])
  })
})
