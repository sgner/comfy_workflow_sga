/**
 * Shared graph traversal helpers — used by all validators to avoid
 * duplicating node/link parsing logic.
 *
 * buildNodeMap does NOT trigger NodeDefIndex loads — every node's def
 * starts as null. Consumers that need the NodeDef call await getNodeDef()
 * themselves (validator-scoped async, deduplicated by NodeDefIndex's
 * single-flight).
 */
import type { NodeDef } from './node-def-index.js'

interface GraphNode {
  id: number | string
  type: string
  mode?: number
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
  widgets_values?: unknown[]
}

export interface GraphNodeContext {
  node: GraphNode
  def: NodeDef | null   // null until a validator populates it
  id: number
}

export interface GraphLink {
  id: number
  fromNodeId: number
  fromSlot: number
  toNodeId: number
  toSlot: number
  type: string | number
}

export function buildNodeMap(workflow: Record<string, unknown>): Map<number, GraphNodeContext> {
  const nodes = ((workflow.nodes as GraphNode[] | undefined) ?? [])
    .filter(n => n && typeof n.id !== 'undefined')
  const map = new Map<number, GraphNodeContext>()
  for (const node of nodes) {
    const id = typeof node.id === 'number' ? node.id : Number(node.id)
    if (!Number.isNaN(id)) {
      map.set(id, { node, def: null, id })
    }
  }
  return map
}

export function buildLinkList(workflow: Record<string, unknown>): GraphLink[] {
  const rawLinks = ((workflow.links as unknown[] | undefined) ?? [])
  const links: GraphLink[] = []
  for (const raw of rawLinks) {
    if (!Array.isArray(raw) || raw.length < 6) continue
    const [id, fromNodeId, fromSlot, toNodeId, toSlot, type] = raw
    if (typeof id !== 'number' || typeof fromSlot !== 'number' || typeof toSlot !== 'number') continue
    links.push({
      id,
      fromNodeId: typeof fromNodeId === 'number' ? fromNodeId : Number(fromNodeId),
      fromSlot,
      toNodeId: typeof toNodeId === 'number' ? toNodeId : Number(toNodeId),
      toSlot,
      type: typeof type === 'string' ? type : String(type),
    })
  }
  return links
}

export function isReroute(node: Record<string, unknown>): boolean {
  return node.type === 'Reroute'
}

export function isPrimitive(node: Record<string, unknown>): boolean {
  return node.type === 'PrimitiveNode'
}

export function isNote(node: Record<string, unknown>): boolean {
  return node.type === 'Note'
}
