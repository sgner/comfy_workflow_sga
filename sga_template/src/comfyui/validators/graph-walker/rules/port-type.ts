import type { WorkflowIssue } from '../../../issue-types.js'
import type { NodeDef } from '../../../node-def-index.js'
import { getNodeDef } from '../../../node-def-index.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'

const PRIMITIVE_WIDGET_TYPES = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN'])

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  mode?: number
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
  widgets_values?: unknown[]
}

function typesCompatible(a: string, b: string): boolean {
  // ComfyUI has subtyping (MODEL -> MODEL*) but reproducing it is out of scope.
  // For v1, only exact match counts as compatible (parity with Approach A).
  return a === b
}

export const portTypeRule: ValidationRule = {
  id: 'portType',
  async run(graph: CompiledGraph): Promise<WorkflowIssue[]> {
    const issues: WorkflowIssue[] = []
    const defCache = new Map<string, NodeDef | null>()
    async function getDef(type: string): Promise<NodeDef | null> {
      if (!defCache.has(type)) defCache.set(type, await getNodeDef(type))
      return defCache.get(type) ?? null
    }

    // Rule 1: unknown node type — iterate graph.nodes
    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      const def = await getDef(node.type)
      if (!def) {
        issues.push({
          id: `unknown_node_type:${node.id}:${node.type}`,
          nodeId: typeof node.id === 'number' ? node.id : null,
          nodeIds: [typeof node.id === 'number' ? node.id : null].filter((x): x is number => x !== null),
          severity: 'warning',
          category: 'unknown_node_type',
          message: `Node type "${node.type}" is not in the ComfyUI node definition index. Port-type checks skipped for this node.`,
          impact: 'Cannot validate connections or widgets for this node.',
          fixSuggestion: `Ensure the custom node providing "${node.type}" is installed and ComfyUI is reachable.`,
          nodeType: node.type,
          source: 'native',
        })
      }
    }

    // Rule 2: port type mismatch — iterate graph.links
    for (const link of graph.links) {
      const fromCtx = graph.nodes.get(link.fromNodeId)
      const toCtx = graph.nodes.get(link.toNodeId)
      if (!fromCtx || !toCtx) continue

      const fromDef = await getDef(fromCtx.node.type as string)
      const toDef = await getDef(toCtx.node.type as string)
      if (!fromDef || !toDef) continue

      const fromNode = fromCtx.node as GraphNode
      const toNode = toCtx.node as GraphNode
      // Graph node's slot is source of truth; fall back to def for real graphs
      const fromOutput = fromNode.outputs?.[link.fromSlot] ?? fromDef.outputs[link.fromSlot]
      const toInput = toNode.inputs?.[link.toSlot] ?? toDef.inputs[link.toSlot]
      if (!fromOutput || !toInput) continue

      const sourceType = (fromOutput as { type: string }).type
      const targetType = (toInput as { type: string }).type
      if (sourceType === '*' || targetType === '*') continue
      if (!typesCompatible(sourceType, targetType)) {
        issues.push({
          id: `port_type_mismatch:${link.id}`,
          nodeId: link.fromNodeId,
          nodeIds: [link.fromNodeId, link.toNodeId],
          severity: 'error',
          category: 'port_type_mismatch',
          message: `Link ${link.id}: output type "${sourceType}" of node ${link.fromNodeId} slot ${link.fromSlot} is not compatible with input type "${targetType}" of node ${link.toNodeId} slot ${link.toSlot}.`,
          impact: 'ComfyUI will reject this workflow at queue time, or silently coerce the value (uncommon).',
          fixSuggestion: `Reconnect node ${link.fromNodeId} output ${link.fromSlot} (${sourceType}) to a ${targetType} input, or replace node ${link.fromNodeId} with one that outputs ${targetType}.`,
          nodeType: fromNode.type,
          source: 'native',
        })
      }
    }

    // Rule 3: orphaned outputs (skip muted nodes) — iterate graph.nodes
    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      if (node.mode === 4) continue
      const def = await getDef(node.type)
      if (!def) continue
      if (!Array.isArray(node.outputs)) continue
      for (let slot = 0; slot < node.outputs.length; slot++) {
        const out = node.outputs[slot]
        const links = out?.links
        if (!links || (Array.isArray(links) && links.every(l => l === null))) {
          const outDef = def.outputs[slot]
          issues.push({
            id: `orphaned_output:${node.id}:${slot}`,
            nodeId: typeof node.id === 'number' ? node.id : null,
            severity: 'info',
            category: 'orphaned_output',
            message: `Node ${node.id} (${node.type}) output slot ${slot} "${outDef?.name ?? `#${slot}`}" (${outDef?.type ?? 'unknown'}) is not connected.`,
            impact: 'Output value is computed but unused. No runtime error, but wastes compute.',
            fixSuggestion: `Connect this output to a downstream node, or remove the node if unneeded.`,
            nodeType: node.type,
            source: 'native',
          })
        }
      }
    }

    // Rule 4: missing required widgets (count-based heuristic) — iterate graph.nodes
    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      const def = await getDef(node.type)
      if (!def) continue
      const requiredWidgets = def.inputs.filter(i => i.required && PRIMITIVE_WIDGET_TYPES.has(i.type.split(' | ')[0]))
      if (requiredWidgets.length === 0) continue
      if (!Array.isArray(node.widgets_values)) continue
      const widgetCount = node.widgets_values.length
      if (widgetCount < requiredWidgets.length) {
        const missing = requiredWidgets.slice(widgetCount).map(w => w.name).join(', ')
        issues.push({
          id: `missing_required_widget:${node.id}`,
          nodeId: typeof node.id === 'number' ? node.id : null,
          severity: 'warning',
          category: 'missing_required_widget',
          message: `Node ${node.id} (${node.type}) has ${widgetCount} widget values but ${requiredWidgets.length} required widgets (${missing}).`,
          impact: 'ComfyUI may fail to queue this node or use default values silently.',
          fixSuggestion: `Open the node in ComfyUI and fill in the missing widget values: ${missing}.`,
          nodeType: node.type,
          source: 'native',
        })
      }
    }

    return issues
  },
}
