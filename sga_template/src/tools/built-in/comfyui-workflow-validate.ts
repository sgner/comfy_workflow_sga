import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'
import { createLogger } from '../../utils/logger.js'
import { validateWorkflow as validateWorkflowGraphWalker } from '../../comfyui/validators/graph-walker/validate-workflow.js'
import type { WorkflowIssue } from '../../comfyui/issue-types.js'

const logger = createLogger('comfyui-workflow-validate')

interface ValidationIssue {
  severity: 'error' | 'warning' | 'info'
  nodeId?: number | string
  message: string
  fixSuggestion?: string
}

interface WorkflowNode {
  id?: number | string
  type?: string
  pos?: [number, number]
  inputs?: Record<string, unknown>
  outputs?: unknown[]
  widgets_values?: unknown[]
  properties?: Record<string, unknown>
  mode?: number
}

interface WorkflowLink {
  id?: number | string
  origin_id?: number | string
  origin_slot?: number
  target_id?: number | string
  target_slot?: number
  type?: string
}

function validateWorkflowStructure(workflow: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
    issues.push({ severity: 'error', message: 'Workflow must have a "nodes" array' })
    return issues
  }

  if (!workflow.links || !Array.isArray(workflow.links)) {
    issues.push({ severity: 'warning', message: 'Workflow should have a "links" array' })
  }

  return issues
}

function validateNodes(nodes: WorkflowNode[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodeIds = new Set<number | string>()

  for (const node of nodes) {
    if (node.id === undefined) {
      issues.push({
        severity: 'error',
        message: `Node missing required "id" field (type: ${node.type ?? 'unknown'})`,
        fixSuggestion: 'Add a unique numeric id to each node',
      })
      continue
    }

    if (nodeIds.has(node.id)) {
      issues.push({
        severity: 'error',
        nodeId: node.id,
        message: `Duplicate node id: ${node.id}`,
        fixSuggestion: 'Ensure all node ids are unique',
      })
    }
    nodeIds.add(node.id)

    if (!node.type) {
      issues.push({
        severity: 'error',
        nodeId: node.id,
        message: `Node ${node.id} missing required "type" field`,
        fixSuggestion: 'Add a valid node type name',
      })
    }

    if (node.mode === 4) {
      issues.push({
        severity: 'info',
        nodeId: node.id,
        message: `Node ${node.id} (${node.type}) is muted/bypassed`,
      })
    }

    if (node.mode === 2) {
      issues.push({
        severity: 'info',
        nodeId: node.id,
        message: `Node ${node.id} (${node.type}) is bypassed`,
      })
    }
  }

  return issues
}

function validateLinks(links: WorkflowLink[], nodes: WorkflowNode[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodeIds = new Set(nodes.map(n => n.id).filter((id): id is number | string => id !== undefined))

  for (const link of links) {
    if (link.origin_id === undefined || link.target_id === undefined) {
      issues.push({
        severity: 'error',
        message: `Link ${link.id ?? 'unknown'} missing origin_id or target_id`,
        fixSuggestion: 'Ensure all links reference valid node ids',
      })
      continue
    }

    if (!nodeIds.has(link.origin_id)) {
      issues.push({
        severity: 'error',
        nodeId: link.origin_id,
        message: `Link ${link.id} references non-existent origin node: ${link.origin_id}`,
        fixSuggestion: `Remove the link or add the missing node with id ${link.origin_id}`,
      })
    }

    if (!nodeIds.has(link.target_id)) {
      issues.push({
        severity: 'error',
        nodeId: link.target_id,
        message: `Link ${link.id} references non-existent target node: ${link.target_id}`,
        fixSuggestion: `Remove the link or add the missing node with id ${link.target_id}`,
      })
    }

    if (link.origin_id === link.target_id) {
      issues.push({
        severity: 'warning',
        nodeId: link.origin_id,
        message: `Link ${link.id} creates a self-loop on node ${link.origin_id}`,
        fixSuggestion: 'Self-referencing links usually indicate an error',
      })
    }

    if (!link.type) {
      issues.push({
        severity: 'warning',
        message: `Link ${link.id} missing type information`,
      })
    }
  }

  return issues
}

function validateNodeConnections(nodes: WorkflowNode[], links: WorkflowLink[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodeMap = new Map<number | string, WorkflowNode>()
  for (const node of nodes) {
    if (node.id !== undefined) nodeMap.set(node.id, node)
  }

  const nodesWithInputs = new Set<number | string>()
  const nodesWithOutputs = new Set<number | string>()

  for (const link of links) {
    if (link.target_id !== undefined) nodesWithInputs.add(link.target_id)
    if (link.origin_id !== undefined) nodesWithOutputs.add(link.origin_id)
  }

  const modelLoaderTypes = [
    'CheckpointLoaderSimple', 'CheckpointLoader', 'UNETLoader', 'DualCLIPLoader',
    'CLIPLoader', 'VAELoader', 'LoraLoader', 'LoraLoaderModelOnly',
    'ControlNetLoader', 'DiffControlNetLoader', 'CLIPLoader',
  ]

  const samplerTypes = ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced']

  const decoderTypes = ['VAEDecode', 'VAEDecodeTiled']

  const saveTypes = ['SaveImage', 'PreviewImage']

  const hasModelLoader = nodes.some(n => modelLoaderTypes.includes(n.type ?? ''))
  const hasSampler = nodes.some(n => samplerTypes.includes(n.type ?? ''))
  const hasDecoder = nodes.some(n => decoderTypes.includes(n.type ?? ''))
  const hasSave = nodes.some(n => saveTypes.includes(n.type ?? ''))

  if (hasSampler && !hasModelLoader) {
    issues.push({
      severity: 'warning',
      message: 'Workflow has a sampler but no model loader node',
      fixSuggestion: 'Add a CheckpointLoaderSimple or similar node',
    })
  }

  if (hasSampler && !hasDecoder) {
    issues.push({
      severity: 'warning',
      message: 'Workflow has a sampler but no VAE decode node',
      fixSuggestion: 'Add a VAEDecode node after the sampler',
    })
  }

  if (hasDecoder && !hasSave) {
    issues.push({
      severity: 'warning',
      message: 'Workflow has a VAE decoder but no SaveImage node',
      fixSuggestion: 'Add a SaveImage node to see the output',
    })
  }

  for (const [nodeId, node] of nodeMap) {
    const nodeType = node.type ?? ''
    if (modelLoaderTypes.includes(nodeType) && !nodesWithOutputs.has(nodeId)) {
      issues.push({
        severity: 'warning',
        nodeId,
        message: `Model loader "${nodeType}" (id: ${nodeId}) has no output connections`,
        fixSuggestion: 'Connect the model loader output to a sampler or other consumer node',
      })
    }
  }

  return issues
}

export class ComfyUIWorkflowValidateTool extends BaseTool<
  { workflow: Record<string, unknown> },
  string
> {
  name = 'ComfyUIWorkflowValidate'
  description = 'Validate a ComfyUI workflow JSON for structural integrity AND deep graph analysis. Runs 11+ validation rules (dangling links, slot out-of-bounds, self-loops, bidirectional links, reroute chains, missing models/media, port type mismatches, etc.) via the graph-walker engine. Returns errors, warnings, and fix suggestions.'
  searchHint = 'comfyui workflow validate check verify json structure graph walker deep analysis'

  isReadOnly(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  isDestructive(): boolean {
    return false
  }

  requiresUserInteraction(): boolean {
    return false
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const workflow = (input as { workflow?: unknown }).workflow
    if (!workflow || typeof workflow !== 'object') return { success: false, error: 'workflow is required and must be an object' }
    return { success: true }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        workflow: {
          type: 'object',
          description: 'The ComfyUI workflow JSON object to validate',
        },
      },
      required: ['workflow'],
    }
  }

  async call(input: { workflow: Record<string, unknown> }, _context: ToolUseContext): Promise<string> {
    const workflow = input.workflow
    const allIssues: ValidationIssue[] = []

    // Phase 1: Basic structural validation (fast, synchronous)
    allIssues.push(...validateWorkflowStructure(workflow))

    const nodes = (workflow.nodes ?? []) as WorkflowNode[]
    const links = (workflow.links ?? []) as WorkflowLink[]

    allIssues.push(...validateNodes(nodes))
    allIssues.push(...validateLinks(links, nodes))
    allIssues.push(...validateNodeConnections(nodes, links))

    // Phase 2: Deep graph-walker validation (11 rules, async)
    let graphWalkerIssues: WorkflowIssue[] = []
    try {
      graphWalkerIssues = await validateWorkflowGraphWalker(workflow)
    } catch (err) {
      logger.warn('Graph-walker validation failed, continuing with basic validation only:', err instanceof Error ? err.message : String(err))
    }

    // Convert WorkflowIssue to ValidationIssue format and merge
    for (const gwi of graphWalkerIssues) {
      allIssues.push({
        severity: gwi.severity,
        nodeId: gwi.nodeId ?? undefined,
        message: gwi.message,
        fixSuggestion: gwi.fixSuggestion,
      })
    }

    const errors = allIssues.filter(i => i.severity === 'error')
    const warnings = allIssues.filter(i => i.severity === 'warning')
    const infos = allIssues.filter(i => i.severity === 'info')

    const lines: string[] = []

    if (allIssues.length === 0) {
      lines.push('✅ Workflow validation passed with no issues.')
      lines.push(`\n## Summary`)
      lines.push(`Nodes: ${nodes.length}, Links: ${links.length}`)
      lines.push(`Verdict: PASS`)
      return lines.join('\n')
    }

    lines.push(`Validation result: ${errors.length} errors, ${warnings.length} warnings, ${infos.length} info`)
    lines.push(`(Basic checks + ${graphWalkerIssues.length} graph-walker rule findings)`)

    if (errors.length > 0) {
      lines.push('\n## Errors')
      for (const issue of errors) {
        const nodeIdStr = issue.nodeId !== undefined ? ` [Node ${issue.nodeId}]` : ''
        lines.push(`  ❌${nodeIdStr} ${issue.message}`)
        if (issue.fixSuggestion) lines.push(`     Fix: ${issue.fixSuggestion}`)
      }
    }

    if (warnings.length > 0) {
      lines.push('\n## Warnings')
      for (const issue of warnings) {
        const nodeIdStr = issue.nodeId !== undefined ? ` [Node ${issue.nodeId}]` : ''
        lines.push(`  ⚠️${nodeIdStr} ${issue.message}`)
        if (issue.fixSuggestion) lines.push(`     Fix: ${issue.fixSuggestion}`)
      }
    }

    if (infos.length > 0) {
      lines.push('\n## Info')
      for (const issue of infos) {
        const nodeIdStr = issue.nodeId !== undefined ? ` [Node ${issue.nodeId}]` : ''
        lines.push(`  ℹ️${nodeIdStr} ${issue.message}`)
      }
    }

    lines.push(`\n## Summary`)
    lines.push(`Nodes: ${nodes.length}, Links: ${links.length}`)
    lines.push(`Verdict: ${errors.length > 0 ? 'FAIL' : 'PASS'}`)

    return lines.join('\n')
  }
}
