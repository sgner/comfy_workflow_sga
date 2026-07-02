import { describe, expect, it } from 'vitest'

function makeWorkflow(nodes: any[], links: any[]) {
  return { nodes, links, last_node_id: nodes.length, last_link_id: links.length }
}

describe('illegal-link-validator', () => {
  it('returns empty for clean valid links', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      [[1, 1, 0, 2, 0, 'MODEL']],
    )
    expect(validateLinkStructure(wf)).toEqual([])
  })

  it('detects dangling link (to_node_id not in nodeMap)', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] }],
      [[1, 1, 0, 99, 0, 'MODEL']],
    )
    const issues = validateLinkStructure(wf)
    const dangling = issues.find(i => i.id.endsWith(':dangling'))
    expect(dangling).toBeDefined()
    expect(dangling?.severity).toBe('error')
    expect(dangling?.category).toBe('illegal_link')
  })

  it('detects slot out of bounds (from_slot >= outputs.length)', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      [[1, 1, 5, 2, 0, 'MODEL']],
    )
    const issues = validateLinkStructure(wf)
    const oob = issues.find(i => i.id.endsWith(':slot_oob'))
    expect(oob).toBeDefined()
    expect(oob?.severity).toBe('error')
  })

  it('detects bidirectional inconsistency', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [null] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: null }] },
      ],
      [[1, 1, 0, 2, 0, 'MODEL']],
    )
    const issues = validateLinkStructure(wf)
    const bidi = issues.find(i => i.id.endsWith(':bidirectional'))
    expect(bidi).toBeDefined()
    expect(bidi?.severity).toBe('error')
  })

  it('detects self-loop', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'A', inputs: [{ name: 'in', type: 'MODEL', link: 1 }], outputs: [{ name: 'X', type: 'MODEL', links: [1] }] }],
      [[1, 1, 0, 1, 0, 'MODEL']],
    )
    const issues = validateLinkStructure(wf)
    const selfLoop = issues.find(i => i.id.endsWith(':self_loop'))
    expect(selfLoop).toBeDefined()
    expect(selfLoop?.severity).toBe('error')
  })

  it('detects multiple violations in one workflow', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1, 2] }] }],
      [
        [1, 1, 0, 99, 0, 'MODEL'],   // dangling
        [2, 1, 0, 1, 0, 'MODEL'],    // self-loop
      ],
    )
    const issues = validateLinkStructure(wf)
    expect(issues.length).toBeGreaterThanOrEqual(2)
    expect(issues.every(i => i.category === 'illegal_link')).toBe(true)
  })

  it('skips malformed link entries', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [] }] }],
      ['not-an-array', [1], [2, 1, 0, 2, 0]],
    )
    expect(validateLinkStructure(wf)).toEqual([])
  })

  it('issues carry source: native', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] }],
      [[1, 1, 0, 99, 0, 'MODEL']],
    )
    const issues = validateLinkStructure(wf)
    expect(issues.every(i => i.source === 'native')).toBe(true)
    expect(issues.every(i => typeof i.id === 'string' && i.id.length > 0)).toBe(true)
  })
})
