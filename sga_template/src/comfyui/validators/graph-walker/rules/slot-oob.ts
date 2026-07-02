import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
}

export const slotOobRule: ValidationRule = {
  id: 'slotOob',
  run(graph: CompiledGraph): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []
    for (const link of graph.links) {
      const fromCtx = graph.nodes.get(link.fromNodeId)
      const toCtx = graph.nodes.get(link.toNodeId)
      // Guard: skip dangling (parity with Approach A continue)
      if (!fromCtx || !toCtx) continue
      // Guard: skip self-loop (parity with Approach A continue)
      if (link.fromNodeId === link.toNodeId) continue

      const fromNode = fromCtx.node as GraphNode
      const toNode = toCtx.node as GraphNode
      const fromOutputs = Array.isArray(fromNode.outputs) ? fromNode.outputs : []
      const toInputs = Array.isArray(toNode.inputs) ? toNode.inputs : []
      if (link.fromSlot >= fromOutputs.length || link.toSlot >= toInputs.length) {
        issues.push({
          id: `illegal_link:${link.id}:slot_oob`,
          nodeId: link.fromNodeId,
          nodeIds: [link.fromNodeId, link.toNodeId],
          severity: 'error',
          category: 'illegal_link',
          message: `Link ${link.id}: slot index out of bounds (from_slot ${link.fromSlot} >= ${fromOutputs.length} outputs, or to_slot ${link.toSlot} >= ${toInputs.length} inputs).`,
          impact: 'ComfyUI will crash or misconnect ports when loading this workflow.',
          fixSuggestion: `Reconnect link ${link.id} to valid ports on nodes ${link.fromNodeId} and ${link.toNodeId}.`,
          source: 'native',
        })
      }
    }
    return issues
  },
}
