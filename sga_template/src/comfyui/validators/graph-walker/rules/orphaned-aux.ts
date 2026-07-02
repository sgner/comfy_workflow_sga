import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'
import { isNote, isPrimitive } from '../../../graph-utils.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
}

export const orphanedAuxRule: ValidationRule = {
  id: 'orphanedAux',
  run(graph: CompiledGraph): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []
    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      if (!isNote(node) && !isPrimitive(node)) continue
      const links = graph.linksByNode.get(ctx.id)
      const hasLinks = !!links && (links.incoming.length > 0 || links.outgoing.length > 0)
      if (!hasLinks) {
        issues.push({
          id: `unsupported_structure:${node.id}:orphaned_aux`,
          nodeId: ctx.id,
          severity: 'info',
          category: 'unsupported_structure',
          message: `${node.type} node ${node.id} is not connected to any other node.`,
          impact: 'Orphaned auxiliary nodes clutter the canvas and serve no purpose.',
          fixSuggestion: `Connect this node or remove it.`,
          source: 'native',
        })
      }
    }
    return issues
  },
}
