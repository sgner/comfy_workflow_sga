/**
 * Orchestrator — compiles the graph once, runs all registered rules in
 * parallel via Promise.all, flattens, and deduplicates by issue id.
 *
 * No degradation (spec §9): if any rule throws, Promise.all rejects and
 * validateWorkflow propagates the error.
 */
import type { WorkflowIssue } from '../../issue-types.js'
import { compileGraph } from './graph-walker.js'
import { RULES } from './validator-registry.js'

export async function validateWorkflow(workflow: Record<string, unknown>): Promise<WorkflowIssue[]> {
  const graph = compileGraph(workflow)
  const results = await Promise.all(RULES.map(r => Promise.resolve(r.run(graph))))
  return dedupById(results.flat())
}

export function dedupById(issues: WorkflowIssue[]): WorkflowIssue[] {
  return Array.from(new Map(issues.map(i => [i.id, i])).values())
}
