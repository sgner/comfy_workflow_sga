import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'

export const danglingLinkRule: ValidationRule = {
  id: 'danglingLink',
  run(graph: CompiledGraph): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []
    for (const link of graph.links) {
      const fromCtx = graph.nodes.get(link.fromNodeId)
      const toCtx = graph.nodes.get(link.toNodeId)
      if (!fromCtx || !toCtx) {
        const missingId = !fromCtx ? link.fromNodeId : link.toNodeId
        issues.push({
          id: `illegal_link:${link.id}:dangling`,
          nodeId: null,
          nodeIds: [link.fromNodeId, link.toNodeId].filter(() => true),
          severity: 'error',
          category: 'illegal_link',
          message: `Link ${link.id} references node ${missingId} which does not exist in the workflow.`,
          impact: 'ComfyUI will crash or silently drop this connection at load time.',
          fixSuggestion: `Remove link ${link.id} or reconnect it to existing nodes.`,
          source: 'native',
        })
      }
    }
    return issues
  },
}
