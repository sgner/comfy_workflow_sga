/**
 * Unsupported-Structure Validator — detects fragile graph patterns.
 *
 * Four sub-rules (all severity: 'info', category: 'unsupported_structure'):
 *   a) Reroute unconnected: input[0].link === null OR outputs[0].links empty
 *   b) Note/Primitive orphaned: not connected to any other node
 *   c) Deep Reroute chain: chain longer than SGA_MAX_REROUTE_DEPTH (default 8)
 *   d) Primitive multi-type: single output connected to inputs of different types
 *
 * Rule (d) requires NodeDef lookups → validator is async overall.
 */
import type { WorkflowIssue } from '../issue-types.js'
import type { NodeDef } from '../node-def-index.js'
import { getNodeDef } from '../node-def-index.js'
import { buildNodeMap, buildLinkList, isReroute, isPrimitive, isNote } from '../graph-utils.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
  widgets_values?: unknown[]
}

function getMaxRerouteDepth(): number {
  return Number(process.env.SGA_MAX_REROUTE_DEPTH) || 8
}

/** @deprecated Use graph-walker/rules/reroute-unconnected.ts, orphaned-aux.ts, deep-reroute-chain.ts, and primitive-multi-type.ts instead. Will be removed after the next release. */
export async function validateUnsupportedStructures(workflow: Record<string, unknown>): Promise<WorkflowIssue[]> {
  const nodeMap = buildNodeMap(workflow)
  const links = buildLinkList(workflow)
  const issues: WorkflowIssue[] = []

  // Build link lookup: nodeId → linkIds that touch this node
  const linksByNode = new Map<number, Set<number>>()
  for (const link of links) {
    if (!linksByNode.has(link.fromNodeId)) linksByNode.set(link.fromNodeId, new Set())
    if (!linksByNode.has(link.toNodeId)) linksByNode.set(link.toNodeId, new Set())
    linksByNode.get(link.fromNodeId)!.add(link.id)
    linksByNode.get(link.toNodeId)!.add(link.id)
  }

  // Rule a: Reroute unconnected
  for (const ctx of nodeMap.values()) {
    const node = ctx.node as GraphNode
    if (!isReroute(node)) continue
    const inputLink = node.inputs?.[0]?.link
    const outputLinks = node.outputs?.[0]?.links
    const hasInput = inputLink != null && inputLink !== undefined
    const hasOutput = Array.isArray(outputLinks) && outputLinks.some(l => l !== null)
    if (!hasInput || !hasOutput) {
      issues.push({
        id: `unsupported_structure:${node.id}:reroute_unconnected`,
        nodeId: ctx.id,
        severity: 'info',
        category: 'unsupported_structure',
        message: `Reroute node ${node.id} is not fully connected (input: ${hasInput ? 'yes' : 'no'}, output: ${hasOutput ? 'yes' : 'no'}).`,
        impact: 'An unconnected Reroute serves no purpose and may indicate an incomplete edit.',
        fixSuggestion: `Connect both sides of the Reroute or remove it.`,
        source: 'native',
      })
    }
  }

  // Rule b: Note/Primitive orphaned (no links at all)
  for (const ctx of nodeMap.values()) {
    const node = ctx.node as GraphNode
    if (!isNote(node) && !isPrimitive(node)) continue
    const connectedLinks = linksByNode.get(ctx.id)
    if (!connectedLinks || connectedLinks.size === 0) {
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

  // Rule c: Deep Reroute chain
  const rerouteNodes = Array.from(nodeMap.values()).filter(ctx => isReroute(ctx.node))
  if (rerouteNodes.length > 0) {
    const maxDepth = getMaxRerouteDepth()
    const rerouteLinks = links.filter(l => {
      const fromCtx = nodeMap.get(l.fromNodeId)
      const toCtx = nodeMap.get(l.toNodeId)
      return fromCtx && toCtx && isReroute(fromCtx.node) && isReroute(toCtx.node)
    })

    // Build adjacency: fromNodeId → [toNodeId]
    const adjacency = new Map<number, number[]>()
    for (const link of rerouteLinks) {
      if (!adjacency.has(link.fromNodeId)) adjacency.set(link.fromNodeId, [])
      adjacency.get(link.fromNodeId)!.push(link.toNodeId)
    }

    // Find the longest chain starting from each reroute with no incoming reroute link
    const visited = new Set<number>()
    for (const start of rerouteNodes) {
      if (visited.has(start.id)) continue
      // Check if this node has an incoming reroute link
      const hasIncoming = rerouteLinks.some(l => l.toNodeId === start.id)
      if (hasIncoming) continue

      // Walk the chain
      let depth = 1
      let current = start.id
      visited.add(start.id)
      while (true) {
        const neighbors = adjacency.get(current)
        if (!neighbors || neighbors.length === 0) break
        const next = neighbors[0]
        if (visited.has(next)) break  // cycle detected — stop walking
        current = next
        depth++
        visited.add(current)
      }
      if (depth > maxDepth) {
        issues.push({
          id: `unsupported_structure:${start.id}:deep_reroute_chain`,
          nodeId: start.id,
          severity: 'info',
          category: 'unsupported_structure',
          message: `Reroute chain starting at node ${start.id} has depth ${depth} (max ${maxDepth}).`,
          impact: 'Deep Reroute chains make workflows harder to read and debug.',
          fixSuggestion: `Reduce the chain length to ${maxDepth} or fewer, or use a direct connection.`,
          source: 'native',
        })
      }
    }
  }

  // Rule d: Primitive multi-type output
  for (const ctx of nodeMap.values()) {
    const node = ctx.node as GraphNode
    if (!isPrimitive(node)) continue
    const outputLinks = node.outputs?.[0]?.links
    if (!Array.isArray(outputLinks)) continue

    const linkIds = outputLinks.filter((l): l is number => l !== null)
    if (linkIds.length < 2) continue  // need at least 2 connections to have multi-type

    // Look up the input type of each connected destination
    const inputTypes = new Set<string>()
    for (const linkId of linkIds) {
      const link = links.find(l => l.id === linkId)
      if (!link) continue
      const toCtx = nodeMap.get(link.toNodeId)
      if (!toCtx) continue
      const toNode = toCtx.node as GraphNode
      const inputDef = toNode.inputs?.[link.toSlot]
      if (inputDef) {
        inputTypes.add(inputDef.type)
      } else {
        // Fall back to NodeDef
        const def: NodeDef | null = await getNodeDef(toNode.type)
        const defInput = def?.inputs[link.toSlot]
        if (defInput) inputTypes.add(defInput.type)
      }
    }

    // Also check NodeDef for more accurate types
    if (inputTypes.size <= 1) {
      // Try harder with NodeDef lookups
      const defTypes = new Set<string>()
      for (const linkId of linkIds) {
        const link = links.find(l => l.id === linkId)
        if (!link) continue
        const toCtx = nodeMap.get(link.toNodeId)
        if (!toCtx) continue
        const toNode = toCtx.node as GraphNode
        const def: NodeDef | null = await getNodeDef(toNode.type)
        const defInput = def?.inputs[link.toSlot]
        if (defInput) defTypes.add(defInput.type)
      }
      if (defTypes.size > 1) {
        issues.push({
          id: `unsupported_structure:${node.id}:primitive_multi_type`,
          nodeId: ctx.id,
          severity: 'info',
          category: 'unsupported_structure',
          message: `PrimitiveNode ${node.id} output is connected to inputs of different types: ${Array.from(defTypes).join(', ')}.`,
          impact: 'PrimitiveNode outputs a single type; connecting to incompatible types may cause runtime errors.',
          fixSuggestion: `Ensure all connections from this PrimitiveNode go to the same input type.`,
          source: 'native',
        })
      }
    } else {
      issues.push({
        id: `unsupported_structure:${node.id}:primitive_multi_type`,
        nodeId: ctx.id,
        severity: 'info',
        category: 'unsupported_structure',
        message: `PrimitiveNode ${node.id} output is connected to inputs of different types: ${Array.from(inputTypes).join(', ')}.`,
        impact: 'PrimitiveNode outputs a single type; connecting to incompatible types may cause runtime errors.',
        fixSuggestion: `Ensure all connections from this PrimitiveNode go to the same input type.`,
        source: 'native',
      })
    }
  }

  return issues
}
