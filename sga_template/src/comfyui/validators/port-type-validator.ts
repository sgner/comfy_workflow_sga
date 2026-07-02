/**
 * Port-Type Validator — consults NodeDefIndex to detect structural issues.
 *
 * Emits WorkflowIssue[] in the UI shape (camelCase, source: 'native') so
 * the Diagnostics tab renders them without translation.
 *
 * Known limits (deferred to future plans):
 *   - No widget schema validation (just count-based heuristic)
 *   - No detection of duplicate link ids or cycles
 *   - typesCompatible() is exact-match only (no ComfyUI subtyping)
 */
import type { WorkflowIssue } from '../issue-types.js'
import type { NodeDef } from '../node-def-index.js'
import { getNodeDef } from '../node-def-index.js'

interface GraphNode {
  id: number | string
  type: string
  mode?: number
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
  widgets_values?: unknown[]
}

interface GraphLink {
  0: number         // linkId
  1: number | string // fromId
  2: number         // fromSlot
  3: number | string // toId
  4: number         // toSlot
  5: string         // type
}

const PRIMITIVE_WIDGET_TYPES = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN'])

interface NodeContext {
  node: GraphNode
  def: NodeDef | null
}

export async function validatePortTypes(workflow: Record<string, unknown>): Promise<WorkflowIssue[]> {
  const nodes = ((workflow.nodes as GraphNode[] | undefined) ?? []).filter(n => n && typeof n.id !== 'undefined')
  const links = ((workflow.links as GraphLink[] | undefined) ?? [])
  const issues: WorkflowIssue[] = []

  // Index lookups (one per unique node type)
  const defCache = new Map<string, NodeDef | null>()
  async function getDef(type: string): Promise<NodeDef | null> {
    if (!defCache.has(type)) defCache.set(type, await getNodeDef(type))
    return defCache.get(type) ?? null
  }

  // Build node lookup by id
  const nodeById = new Map<string | number, NodeContext>()
  for (const node of nodes) {
    const def = await getDef(node.type)
    nodeById.set(node.id, { node, def })

    // Rule 1: unknown node type
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

  // Rule 2: port type mismatch on links
  for (const link of links) {
    if (!Array.isArray(link) || link.length < 6) continue
    const [, fromId, fromSlot, toId, toSlot] = link
    const fromCtx = nodeById.get(fromId)
    const toCtx = nodeById.get(toId)
    if (!fromCtx || !toCtx) continue

    const fromDef = fromCtx.def
    const toDef = toCtx.def
    if (!fromDef || !toDef) continue

    // Graph node's slot is the source of truth for the link's connected
    // port (matches ComfyUI's link slot indexing). Fall back to def for
    // real graphs where the node omits the slot info.
    const fromOutput = fromCtx.node.outputs?.[fromSlot] ?? fromDef.outputs[fromSlot]
    const toInput = toCtx.node.inputs?.[toSlot] ?? toDef.inputs[toSlot]
    if (!fromOutput || !toInput) continue

    const sourceType = fromOutput.type
    const targetType = toInput.type
    if (sourceType === '*' || targetType === '*') continue
    if (!typesCompatible(sourceType, targetType)) {
      issues.push({
        id: `port_type_mismatch:${link[0]}`,
        nodeId: typeof fromId === 'number' ? fromId : null,
        nodeIds: [fromId, toId].filter((x): x is number => typeof x === 'number'),
        severity: 'error',
        category: 'port_type_mismatch',
        message: `Link ${link[0]}: output type "${sourceType}" of node ${fromId} slot ${fromSlot} is not compatible with input type "${targetType}" of node ${toId} slot ${toSlot}.`,
        impact: 'ComfyUI will reject this workflow at queue time, or silently coerce the value (uncommon).',
        fixSuggestion: `Reconnect node ${fromId} output ${fromSlot} (${sourceType}) to a ${targetType} input, or replace node ${fromId} with one that outputs ${targetType}.`,
        nodeType: fromCtx.node.type,
        source: 'native',
      })
    }
  }

  // Rule 3: orphaned outputs (skip muted nodes)
  for (const { node, def } of nodeById.values()) {
    if (node.mode === 4) continue
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

  // Rule 4: missing required widgets (heuristic — count-based)
  for (const { node, def } of nodeById.values()) {
    if (!def) continue
    const requiredWidgets = def.inputs.filter(i => i.required && PRIMITIVE_WIDGET_TYPES.has(i.type.split(' | ')[0]))
    if (requiredWidgets.length === 0) continue
    // Only validate when widgets_values is present — absent widgets can't
    // be compared against the required count (node may rely on defaults).
    if (!Array.isArray(node.widgets_values)) continue
    const widgetCount = node.widgets_values.length
    if (widgetCount < requiredWidgets.length) {
      // NOTE: positional mapping — widgets_values[i] is assumed to align with requiredWidgets[i].
      // In real ComfyUI graphs with converted inputs, this may report wrong widget names.
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
}

function typesCompatible(a: string, b: string): boolean {
  if (a === b) return true
  // ComfyUI has subtyping (MODEL -> MODEL*, etc.) but reproducing it is
  // out of scope. For v1, only exact match counts as compatible.
  return false
}
