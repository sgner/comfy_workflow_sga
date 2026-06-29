import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'
import { isReroute } from '../../../graph-utils.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
}

export const rerouteUnconnectedRule: ValidationRule = {
  id: 'rerouteUnconnected',
  run(graph: CompiledGraph): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []
    for (const ctx of graph.nodes.values()) {
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
    return issues
  },
}
