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

export const bidirectionalLinkRule: ValidationRule = {
  id: 'bidirectionalLink',
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
      // Guard: skip slot_oob (parity with Approach A continue)
      if (link.fromSlot >= fromOutputs.length || link.toSlot >= toInputs.length) continue

      const fromOutputLinks = fromOutputs[link.fromSlot]?.links
      const toInputLink = toInputs[link.toSlot]?.link
      const fromReferences = Array.isArray(fromOutputLinks) && fromOutputLinks.includes(link.id)
      const toReferences = toInputLink === link.id
      if (!fromReferences && !toReferences) {
        issues.push({
          id: `illegal_link:${link.id}:bidirectional`,
          nodeId: link.fromNodeId,
          nodeIds: [link.fromNodeId, link.toNodeId],
          severity: 'error',
          category: 'illegal_link',
          message: `Link ${link.id} is declared in links[] but neither node ${link.fromNodeId} output ${link.fromSlot} nor node ${link.toNodeId} input ${link.toSlot} references it.`,
          impact: 'ComfyUI may silently drop this connection or display it incorrectly.',
          fixSuggestion: `Remove link ${link.id} or fix the node port references to include it.`,
          source: 'native',
        })
      }
    }
    return issues
  },
}
