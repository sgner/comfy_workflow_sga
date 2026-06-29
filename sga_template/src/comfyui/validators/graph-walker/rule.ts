/**
 * ValidationRule — standardized contract for all graph-walker rules.
 * Each rule receives the compiled graph and returns issues.
 */
import type { WorkflowIssue } from '../../issue-types.js'
import type { CompiledGraph } from './graph-walker.js'

export interface ValidationRule {
  /** Rule identifier for diagnostics (e.g. "portType", "danglingLink"). Not the issue id. */
  id: string
  run(graph: CompiledGraph): Promise<WorkflowIssue[]> | WorkflowIssue[]
}
