import type { WorkflowIssue } from '../../../issue-types.js'
import type { NodeDef } from '../../../node-def-index.js'
import { getNodeDef } from '../../../node-def-index.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'
import type { GraphLink } from '../../../graph-utils.js'
import { isPrimitive } from '../../../graph-utils.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
  widgets_values?: unknown[]
}

export const primitiveMultiTypeRule: ValidationRule = {
  id: 'primitiveMultiType',
  async run(graph: CompiledGraph): Promise<WorkflowIssue[]> {
    const issues: WorkflowIssue[] = []

    // Build link lookup Map for O(1) access by link id
    const linkMap = new Map<number, GraphLink>()
    for (const link of graph.links) {
      linkMap.set(link.id, link)
    }

    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      if (!isPrimitive(node)) continue
      const outputLinks = node.outputs?.[0]?.links
      if (!Array.isArray(outputLinks)) continue

      const linkIds = outputLinks.filter((l): l is number => l !== null)
      if (linkIds.length < 2) continue  // need at least 2 connections to have multi-type

      // Look up the input type of each connected destination.
      // Double-check pattern (parity with Approach A):
      //   1. Try workflow-declared input types first.
      //   2. If ≤1 types found, retry with NodeDef lookups.
      const inputTypes = new Set<string>()
      for (const linkId of linkIds) {
        const link = linkMap.get(linkId)
        if (!link) continue
        const toCtx = graph.nodes.get(link.toNodeId)
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

      // Also check NodeDef for more accurate types (double-check pattern)
      if (inputTypes.size <= 1) {
        const defTypes = new Set<string>()
        for (const linkId of linkIds) {
          const link = linkMap.get(linkId)
          if (!link) continue
          const toCtx = graph.nodes.get(link.toNodeId)
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
  },
}
