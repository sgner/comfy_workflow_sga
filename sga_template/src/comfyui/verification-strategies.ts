import { createLogger } from '../utils/logger.js'

const logger = createLogger('verification-strategies')

export type VerificationVerdict = 'PASS' | 'FAIL' | 'PARTIAL'

export interface VerificationResult {
  verdict: VerificationVerdict
  strategy: string
  checks: VerificationCheck[]
  summary: string
}

export interface VerificationCheck {
  name: string
  passed: boolean
  message: string
  severity: 'critical' | 'warning' | 'info'
}

export interface WorkflowJSON {
  id?: string
  last_node_id?: number | string
  last_link_id?: number | string
  nodes?: WorkflowNode[]
  links?: WorkflowLink[]
  extra?: Record<string, unknown>
  config?: Record<string, unknown>
  version?: number
}

export interface WorkflowNode {
  id?: number | string
  type?: string
  pos?: [number, number] | number[]
  size?: [number, number] | number[]
  mode?: number
  widgets_values?: unknown[]
  inputs?: WorkflowNodeSlot[]
  outputs?: WorkflowNodeSlot[]
  properties?: Record<string, unknown>
}

export interface WorkflowNodeSlot {
  name?: string
  type?: string | string[]
  link?: number | string | null
}

export interface WorkflowLink {
  id?: number | string
  origin_id?: number | string
  origin_slot?: number
  target_id?: number | string
  target_slot?: number
  type?: string | string[]
}

export function validateWorkflowJSON(workflow: unknown): VerificationResult {
  const checks: VerificationCheck[] = []

  checks.push(validateJsonStructure(workflow))
  checks.push(validateNodeIds(workflow as WorkflowJSON))
  checks.push(validateLinkReferences(workflow as WorkflowJSON))
  checks.push(validateRequiredInputs(workflow as WorkflowJSON))
  checks.push(validateDataTypeCompatibility(workflow as WorkflowJSON))

  const criticalFailures = checks.filter(c => !c.passed && c.severity === 'critical')
  const warnings = checks.filter(c => !c.passed && c.severity === 'warning')

  let verdict: VerificationVerdict = 'PASS'
  if (criticalFailures.length > 0) verdict = 'FAIL'
  else if (warnings.length > 0) verdict = 'PARTIAL'

  const summary = buildSummary(verdict, checks)

  return {
    verdict,
    strategy: 'comfyui-workflow-validation',
    checks,
    summary,
  }
}

function validateJsonStructure(workflow: unknown): VerificationCheck {
  if (workflow === null || workflow === undefined) {
    return { name: 'JSON Structure', passed: false, message: 'Workflow is null or undefined', severity: 'critical' }
  }

  if (typeof workflow !== 'object' || Array.isArray(workflow)) {
    return { name: 'JSON Structure', passed: false, message: 'Workflow must be a JSON object', severity: 'critical' }
  }

  const wf = workflow as Record<string, unknown>
  if (!wf.nodes || !Array.isArray(wf.nodes)) {
    return { name: 'JSON Structure', passed: false, message: 'Workflow must have a "nodes" array', severity: 'critical' }
  }

  if (wf.nodes.length === 0) {
    return { name: 'JSON Structure', passed: false, message: 'Workflow has no nodes', severity: 'critical' }
  }

  return { name: 'JSON Structure', passed: true, message: `Valid structure with ${wf.nodes.length} nodes`, severity: 'info' }
}

function validateNodeIds(workflow: WorkflowJSON): VerificationCheck {
  const nodes = workflow.nodes ?? []
  const ids = new Set<number | string>()
  const duplicates: (number | string)[] = []

  for (const node of nodes) {
    if (node.id === undefined) {
      return { name: 'Node IDs', passed: false, message: 'A node is missing its id', severity: 'critical' }
    }
    if (ids.has(node.id)) {
      duplicates.push(node.id)
    }
    ids.add(node.id)
  }

  if (duplicates.length > 0) {
    return { name: 'Node IDs', passed: false, message: `Duplicate node IDs: ${duplicates.join(', ')}`, severity: 'critical' }
  }

  return { name: 'Node IDs', passed: true, message: `All ${ids.size} node IDs are unique`, severity: 'info' }
}

function validateLinkReferences(workflow: WorkflowJSON): VerificationCheck {
  const nodes = workflow.nodes ?? []
  const links = workflow.links ?? []
  const nodeIds = new Set(nodes.map(n => n.id))

  const invalidLinks: string[] = []

  for (const link of links) {
    if (link.origin_id !== undefined && !nodeIds.has(link.origin_id)) {
      invalidLinks.push(`Link ${link.id}: origin node ${link.origin_id} not found`)
    }
    if (link.target_id !== undefined && !nodeIds.has(link.target_id)) {
      invalidLinks.push(`Link ${link.id}: target node ${link.target_id} not found`)
    }
  }

  for (const node of nodes) {
    if (node.inputs) {
      for (const input of node.inputs) {
        if (input.link !== undefined && input.link !== null) {
          const linkExists = links.some(l => l.id === input.link)
          if (!linkExists) {
            invalidLinks.push(`Node ${node.id} input "${input.name}": link ${input.link} not found`)
          }
        }
      }
    }
    if (node.outputs) {
      for (const output of node.outputs) {
        if (output.link !== undefined && output.link !== null) {
          const linkExists = links.some(l => l.id === output.link)
          if (!linkExists) {
            invalidLinks.push(`Node ${node.id} output "${output.name}": link ${output.link} not found`)
          }
        }
      }
    }
  }

  if (invalidLinks.length > 0) {
    return { name: 'Link References', passed: false, message: `${invalidLinks.length} invalid link references: ${invalidLinks.slice(0, 3).join('; ')}${invalidLinks.length > 3 ? '...' : ''}`, severity: 'critical' }
  }

  return { name: 'Link References', passed: true, message: `All ${links.length} link references are valid`, severity: 'info' }
}

function validateRequiredInputs(workflow: WorkflowJSON): VerificationCheck {
  const nodes = workflow.nodes ?? []
  const links = workflow.links ?? []
  const unconnected: string[] = []

  const REQUIRED_INPUT_TYPES = new Set([
    'MODEL', 'CLIP', 'VAE', 'CONDITIONING', 'LATENT', 'IMAGE',
    'MASK', 'CONTROL_NET', 'INT', 'FLOAT', 'STRING',
  ])

  for (const node of nodes) {
    if (!node.inputs) continue

    for (const input of node.inputs) {
      const inputType = Array.isArray(input.type) ? input.type[0] : input.type
      if (!inputType || !REQUIRED_INPUT_TYPES.has(inputType.toUpperCase())) continue

      const isConnected = input.link !== undefined && input.link !== null
      const hasWidgetValue = node.widgets_values && node.widgets_values.length > 0

      if (!isConnected && !hasWidgetValue && inputType.toUpperCase() !== 'STRING' && inputType.toUpperCase() !== 'INT' && inputType.toUpperCase() !== 'FLOAT') {
        unconnected.push(`Node ${node.id} (${node.type ?? 'unknown'}): input "${input.name}" of type ${inputType} is not connected`)
      }
    }
  }

  if (unconnected.length > 0) {
    return { name: 'Required Inputs', passed: false, message: `${unconnected.length} unconnected required inputs: ${unconnected.slice(0, 3).join('; ')}${unconnected.length > 3 ? '...' : ''}`, severity: 'warning' }
  }

  return { name: 'Required Inputs', passed: true, message: 'All required inputs are connected or have values', severity: 'info' }
}

function validateDataTypeCompatibility(workflow: WorkflowJSON): VerificationCheck {
  const links = workflow.links ?? []
  const nodes = workflow.nodes ?? []
  const mismatches: string[] = []

  const nodeMap = new Map<number | string, WorkflowNode>()
  for (const node of nodes) {
    if (node.id !== undefined) nodeMap.set(node.id, node)
  }

  for (const link of links) {
    const originNode = nodeMap.get(link.origin_id ?? -1)
    const targetNode = nodeMap.get(link.target_id ?? -1)

    if (!originNode || !targetNode) continue

    const originOutput = originNode.outputs?.[link.origin_slot ?? 0]
    const targetInput = targetNode.inputs?.[link.target_slot ?? 0]

    if (originOutput?.type && targetInput?.type) {
      const originType = Array.isArray(originOutput.type) ? originOutput.type[0] : originOutput.type
      const targetType = Array.isArray(targetInput.type) ? targetInput.type[0] : targetInput.type

      if (originType !== '*' && targetType !== '*' && originType !== targetType) {
        mismatches.push(`Link ${link.id}: ${originType} → ${targetType} (node ${link.origin_id} → ${link.target_id})`)
      }
    }
  }

  if (mismatches.length > 0) {
    return { name: 'Data Type Compatibility', passed: false, message: `${mismatches.length} type mismatches: ${mismatches.slice(0, 3).join('; ')}${mismatches.length > 3 ? '...' : ''}`, severity: 'warning' }
  }

  return { name: 'Data Type Compatibility', passed: true, message: 'All data types are compatible', severity: 'info' }
}

function buildSummary(verdict: VerificationVerdict, checks: VerificationCheck[]): string {
  const passed = checks.filter(c => c.passed).length
  const total = checks.length
  const failures = checks.filter(c => !c.passed)

  let summary = `Verification: ${verdict} (${passed}/${total} checks passed)`

  if (failures.length > 0) {
    summary += '\nIssues:\n' + failures.map(f => `  - [${f.severity}] ${f.name}: ${f.message}`).join('\n')
  }

  return summary
}

export function extractWorkflowJSON(text: string): WorkflowJSON | null {
  const jsonBlockRegex = /```json\s*\n([\s\S]*?)\n```/g
  let match: RegExpExecArray | null

  while ((match = jsonBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed && typeof parsed === 'object' && parsed.nodes && Array.isArray(parsed.nodes)) {
        return parsed as WorkflowJSON
      }
    } catch {
      continue
    }
  }

  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && parsed.nodes && Array.isArray(parsed.nodes)) {
      return parsed as WorkflowJSON
    }
  } catch {
    // not valid JSON
  }

  return null
}

/**
 * Force-preserve a session-bound id on a workflow JSON.
 *
 * Why: agent-generated workflow JSONs come with a fresh `id` / `extra.workspace_info.id`
 * (or `extra.id`). The ComfyUI frontend treats that id as the canonical "which workflow
 * am I on" key, and we tie our chat session to that same id (sessionId === workflowId).
 * If the id changes after the agent response, the frontend will treat it as a brand-new
 * workflow, switch session, and the previous chat history is lost.
 *
 * Strategy:
 *   1. If `currentWorkflowId` is missing/empty → no-op (caller has nothing to bind to).
 *   2. If the generated JSON already has a matching id at the canonical location → no-op.
 *   3. Otherwise, copy the current id into:
 *        - `extra.workspace_info.id` (ComfyUI's modern location, takes priority)
 *        - `extra.id` (legacy fallback)
 *        - top-level `id` (some tools/serializers still read it)
 *      The original generated ids are moved to `extra.workflow_agent_original_id*`
 *      so we don't lose the data and we can debug if needed.
 */
export function preserveWorkflowSessionId(
  workflowJson: WorkflowJSON,
  currentWorkflowId: string | null | undefined,
): WorkflowJSON {
  if (!currentWorkflowId) return workflowJson

  const result: WorkflowJSON = { ...workflowJson }
  const extra = (result.extra && typeof result.extra === 'object'
    ? { ...(result.extra as Record<string, unknown>) }
    : {}) as Record<string, unknown>

  // 1) Capture what the agent originally wrote, for forensics
  const originalTopId = typeof result.id === 'string' ? result.id : undefined
  const originalExtraId = typeof extra.id === 'string' ? (extra.id as string) : undefined
  const originalWorkspaceInfo = (extra.workspace_info && typeof extra.workspace_info === 'object'
    ? { ...(extra.workspace_info as Record<string, unknown>) }
    : null)
  const originalWorkspaceId = originalWorkspaceInfo && typeof originalWorkspaceInfo.id === 'string'
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
  extra.workspace_info = {
    ...(originalWorkspaceInfo ?? {}),
    id: currentWorkflowId,
  }
  extra.id = currentWorkflowId
  result.id = currentWorkflowId
  result.extra = extra

  logger.debug(
    `preserveWorkflowSessionId: forced workflow id to '${currentWorkflowId}' ` +
    `(original top=${originalTopId ?? '∅'}, extra.id=${originalExtraId ?? '∅'}, ` +
    `workspace_info.id=${originalWorkspaceId ?? '∅'})`,
  )

  return result
}
