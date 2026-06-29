import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'

export const selfLoopRule: ValidationRule = {
  id: 'selfLoop',
  run(graph: CompiledGraph): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []
    for (const link of graph.links) {
      const fromCtx = graph.nodes.get(link.fromNodeId)
      const toCtx = graph.nodes.get(link.toNodeId)
      // Guard: skip dangling (parity with Approach A continue)
      if (!fromCtx || !toCtx) continue
      if (link.fromNodeId === link.toNodeId) {
        issues.push({
          id: `illegal_link:${link.id}:self_loop`,
          nodeId: link.fromNodeId,
          nodeIds: [link.fromNodeId],
          severity: 'error',
          category: 'illegal_link',
          message: `Link ${link.id} connects node ${link.fromNodeId} to itself.`,
          impact: 'Creates an infinite cycle; ComfyUI will reject this workflow.',
          fixSuggestion: `Remove link ${link.id} or connect it to a different node.`,
          source: 'native',
        })
      }
    }
    return issues
  },
}
