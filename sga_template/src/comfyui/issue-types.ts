/**
 * Backend-canonical WorkflowIssue type. Mirrors ui/src/types.ts exactly
 * (camelCase) so backend issues render in the UI Diagnostics tab without
 * translation. Resolves three-type divergence (workflow-analyzer.ts
 * snake_case, comfyui-workflow-validate.ts no id field).
 *
 * When adding fields here, also update ui/src/types.ts.
 */
export type IssueSeverity = 'error' | 'warning' | 'info'
export type IssueSource = 'native' | 'agent'

export type IssueCategory =
  | 'missing_model' | 'missing_node' | 'missing_media' | 'runtime_error'
  | 'port_type_mismatch' | 'orphaned_output' | 'missing_required_widget'
  | 'invalid_link' | 'unknown_node_type'

export interface WorkflowIssue {
  /** Stable unique id, e.g. 'port_type_mismatch:<nodeId>:<inputSlot>' */
  id: string
  nodeId: number | null
  nodeIds?: number[]
  severity: IssueSeverity
  category?: IssueCategory | string
  message: string
  impact?: string
  fixSuggestion?: string
  nodeType?: string
  exceptionType?: string
  traceback?: string
  currentInputs?: Record<string, unknown>
  isRuntimeError?: boolean
  source?: IssueSource
  modelName?: string
  modelFolder?: string
}
