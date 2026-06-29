import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WorkflowIssue } from '../../issue-types.js'

describe('validate-workflow', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns empty issues for empty workflow', async () => {
    const { validateWorkflow } = await import('./validate-workflow.js')
    const issues = await validateWorkflow({ nodes: [], links: [] })
    expect(issues).toEqual([])
  })

  it('deduplicates issues by id', async () => {
    const { RULES } = await import('./validator-registry.js')
    const mockIssue: WorkflowIssue = {
      id: 'test:1', nodeId: 1, severity: 'info', message: 'test', source: 'native',
    }
    RULES.push({
      id: 'mockDuplicate',
      run: () => [mockIssue, { ...mockIssue }],
    })
    const { validateWorkflow } = await import('./validate-workflow.js')
    const issues = await validateWorkflow({ nodes: [], links: [] })
    expect(issues.filter(i => i.id === 'test:1')).toHaveLength(1)
  })
})
