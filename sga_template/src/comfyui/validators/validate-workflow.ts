/**
 * Validate-Workflow Orchestrator — runs all validators in parallel and
 * deduplicates issues by id.
 *
 * Per spec §6: does NOT swallow errors. If any validator throws (e.g.
 * COMFYUI_BASE_DIR unset, NodeDefIndex fetch failure), the whole
 * validateWorkflow() rejects with the original error.
 */
import type { WorkflowIssue } from '../issue-types.js'
import { validatePortTypes } from './port-type-validator.js'
import { validateMissingReferences } from './missing-ref-validator.js'
import { validateLinkStructure } from './illegal-link-validator.js'
import { validateUnsupportedStructures } from './unsupported-structure-validator.js'

/** @deprecated Use graph-walker/validate-workflow.ts instead. Will be removed after the next release. */
export async function validateWorkflow(workflow: Record<string, unknown>): Promise<WorkflowIssue[]> {
  const results = await Promise.all([
    validatePortTypes(workflow),
    validateMissingReferences(workflow),
    Promise.resolve(validateLinkStructure(workflow)),
    validateUnsupportedStructures(workflow),
  ])
  const all = results.flat()
  // Dedup by id (in case two validators flag the same node)
  return Array.from(new Map(all.map(i => [i.id, i])).values())
}
