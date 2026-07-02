import { describe, expect, it } from 'vitest'

describe('fixture-loader', () => {
  it('loads all 10 fixtures with required fields', async () => {
    const { loadFixture, listFixtures } = await import('./fixture-loader.js')
    const names = listFixtures()
    expect(names).toHaveLength(10)
    expect(names).toContain('txt2img-basic')
    expect(names).toContain('missing-model')
    expect(names).toContain('reroute-chain-deep')

    for (const name of names) {
      const fixture = loadFixture(name)
      expect(fixture.name).toBe(name)
      expect(typeof fixture.description).toBe('string')
      expect(fixture.objectInfo).toBeTypeOf('object')
      expect(fixture.workflow).toBeTypeOf('object')
      expect(Array.isArray(fixture.workflow.nodes)).toBe(true)
      expect(Array.isArray(fixture.workflow.links)).toBe(true)
      expect(Array.isArray(fixture.expectedIssueIds)).toBe(true)
      expect(typeof fixture.models).toBe('object')
      expect(Array.isArray(fixture.input)).toBe(true)
    }
  })
})
