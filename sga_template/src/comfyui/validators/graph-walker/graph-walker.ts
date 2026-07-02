/**
 * Graph Walker — compiles a ComfyUI workflow into a CompiledGraph that
 * all validation rules share. Single walk; rules reuse the result.
 *
 * Pure synchronous graph topology — no async, no external services.
 */
import {
  buildNodeMap,
  buildLinkList,
  type GraphNodeContext,
  type GraphLink,
} from '../../graph-utils.js'

export interface CompiledGraph {
  nodes: Map<number, GraphNodeContext>
  links: GraphLink[]
  linksByNode: Map<number, { incoming: GraphLink[]; outgoing: GraphLink[] }>
}

export function compileGraph(workflow: Record<string, unknown>): CompiledGraph {
  const nodes = buildNodeMap(workflow)
  const links = buildLinkList(workflow)
  const linksByNode = new Map<number, { incoming: GraphLink[]; outgoing: GraphLink[] }>()
  for (const link of links) {
    let fromEntry = linksByNode.get(link.fromNodeId)
    if (!fromEntry) {
      fromEntry = { incoming: [], outgoing: [] }
      linksByNode.set(link.fromNodeId, fromEntry)
    }
    fromEntry.outgoing.push(link)
    let toEntry = linksByNode.get(link.toNodeId)
    if (!toEntry) {
      toEntry = { incoming: [], outgoing: [] }
      linksByNode.set(link.toNodeId, toEntry)
    }
    toEntry.incoming.push(link)
  }
  return { nodes, links, linksByNode }
}
