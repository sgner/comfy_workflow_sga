/**
 * Illegal-Link Validator — detects structural link issues.
 *
 * Four sub-rules (all severity: 'error', category: 'illegal_link'):
 *   a) Dangling link: from_node_id or to_node_id not in nodeMap
 *   b) Slot out of bounds: from_slot >= outputs.length or to_slot >= inputs.length
 *   c) Bidirectional inconsistency: link in links[] but neither endpoint references it
 *   d) Self-loop: from_node_id === to_node_id
 *
 * Pure graph topology — no async dependencies. Runs synchronously.
 */
import type { WorkflowIssue } from '../issue-types.js'
import { buildNodeMap, buildLinkList } from '../graph-utils.js'

interface GraphNode {
  id: number | string
  type: string
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
}

export function validateLinkStructure(workflow: Record<string, unknown>): WorkflowIssue[] {
  const nodeMap = buildNodeMap(workflow)
  const links = buildLinkList(workflow)
  const issues: WorkflowIssue[] = []

  for (const link of links) {
    const fromCtx = nodeMap.get(link.fromNodeId)
    const toCtx = nodeMap.get(link.toNodeId)

    // Rule a: dangling link
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
      continue
    }

    const fromNode = fromCtx.node as GraphNode
    const toNode = toCtx.node as GraphNode

    // Rule d: self-loop
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
      continue
    }

    // Rule b: slot out of bounds
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
      continue
    }

    // Rule c: bidirectional inconsistency
    // Link is in links[] but neither endpoint's inputs[].link nor outputs[].links references it
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
}
