import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'
import { isReroute } from '../../../graph-utils.js'

function getMaxRerouteDepth(): number {
  return Number(process.env.SGA_MAX_REROUTE_DEPTH) || 8
}

export const deepRerouteChainRule: ValidationRule = {
  id: 'deepRerouteChain',
  run(graph: CompiledGraph): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []
    const rerouteNodes = Array.from(graph.nodes.values()).filter(ctx => isReroute(ctx.node))
    if (rerouteNodes.length === 0) return issues

    const maxDepth = getMaxRerouteDepth()
    const rerouteLinks = graph.links.filter(l => {
      const fromCtx = graph.nodes.get(l.fromNodeId)
      const toCtx = graph.nodes.get(l.toNodeId)
      return fromCtx && toCtx && isReroute(fromCtx.node) && isReroute(toCtx.node)
    })

    // Build adjacency: fromNodeId → [toNodeId]
    const adjacency = new Map<number, number[]>()
    for (const link of rerouteLinks) {
      if (!adjacency.has(link.fromNodeId)) adjacency.set(link.fromNodeId, [])
      adjacency.get(link.fromNodeId)!.push(link.toNodeId)
    }

    // Walk from each reroute with no incoming reroute link.
    // Cycle detection: visited set + break on revisit (parity with Approach A commit e56209b).
    const visited = new Set<number>()
    for (const start of rerouteNodes) {
      if (visited.has(start.id)) continue
      const hasIncoming = rerouteLinks.some(l => l.toNodeId === start.id)
      if (hasIncoming) continue

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
    return issues
  },
}
