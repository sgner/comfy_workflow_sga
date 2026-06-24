/**
 * Force-preserve a session-bound id on a ComfyUI workflow JSON.
 *
 * Why: the agent may emit a workflow JSON with a freshly-generated id
 * (`extra.workspace_info.id` / `extra.id` / top-level `id`). The ComfyUI
 * frontend treats that id as the canonical "which workflow am I on" key
 * and our chat session is bound to the same id (sessionId === workflowId).
 * If the id changes, the frontend will treat the new graph as a brand-new
 * workflow, switch the chat session, and the previous history is lost.
 *
 * This is the frontend mirror of
 * `sga_template/src/comfyui/verification-strategies.ts::preserveWorkflowSessionId`.
 *
 * The original id values are moved to `extra.workflow_agent_original_id*`
 * fields for forensics.
 */
export function preserveWorkflowSessionId<T extends Record<string, any>>(
  workflowJson: T,
  currentWorkflowId: string | null | undefined,
): T {
  if (!currentWorkflowId) return workflowJson
  if (!workflowJson || typeof workflowJson !== 'object') return workflowJson

  const result: Record<string, any> = { ...workflowJson }
  const extra: Record<string, any> =
    result.extra && typeof result.extra === 'object' ? { ...result.extra } : {}

  // 1) Capture what the agent originally wrote
  const originalTopId = typeof result.id === 'string' ? (result.id as string) : undefined
  const originalExtraId = typeof extra.id === 'string' ? (extra.id as string) : undefined
  const originalWorkspaceInfo =
    extra.workspace_info && typeof extra.workspace_info === 'object'
      ? { ...(extra.workspace_info as Record<string, unknown>) }
      : null
  const originalWorkspaceId =
    originalWorkspaceInfo && typeof originalWorkspaceInfo.id === 'string'
      ? (originalWorkspaceInfo.id as string)
      : undefined

  if (originalTopId && originalTopId !== currentWorkflowId) {
    extra.workflow_agent_original_id_top = originalTopId
  }
  if (originalExtraId && originalExtraId !== currentWorkflowId) {
    extra.workflow_agent_original_id_extra = originalExtraId
  }
  if (originalWorkspaceId && originalWorkspaceId !== currentWorkflowId) {
    extra.workflow_agent_original_id_workspace = originalWorkspaceId
  }

  // 2) Overwrite every location with the session-bound id
  extra.workspace_info = { ...(originalWorkspaceInfo ?? {}), id: currentWorkflowId }
  extra.id = currentWorkflowId
  result.id = currentWorkflowId
  result.extra = extra

  return result as T
}
