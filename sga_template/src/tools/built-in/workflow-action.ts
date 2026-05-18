import { BaseTool, type ToolInputSchema, type ValidationResult, type ToolUseContext } from '../../tools/base.js'

interface ActionRecord {
  id: string
  type: string
  workflow_before: unknown
  workflow_after: unknown
  description: string
  timestamp: string
}

const actionHistory: ActionRecord[] = []

export class WorkflowActionTool extends BaseTool {
  name = 'workflow_action'
  description = 'Execute workflow modification actions such as adding nodes, connecting nodes, or modifying properties'

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        action_type: {
          type: 'string',
          enum: ['add_node', 'remove_node', 'connect_nodes', 'disconnect_nodes', 'modify_node', 'fix_workflow'],
          description: 'Type of action to perform',
        },
        workflow_json: {
          type: 'string',
          description: 'Current workflow JSON',
        },
        params: {
          type: 'object',
          description: 'Parameters for the action',
        },
      },
      required: ['action_type', 'workflow_json'],
    }
  }

  validateInput(input: unknown): ValidationResult {
    const data = input as Record<string, unknown>
    if (!data.action_type || typeof data.action_type !== 'string') {
      return { success: false, error: 'action_type is required' }
    }
    if (!data.workflow_json || typeof data.workflow_json !== 'string') {
      return { success: false, error: 'workflow_json is required' }
    }
    try {
      JSON.parse(data.workflow_json as string)
    } catch {
      return { success: false, error: 'workflow_json must be valid JSON' }
    }
    return { success: true }
  }

  async call(input: Record<string, unknown>, _context: ToolUseContext): Promise<string> {
    const actionType = input.action_type as string
    const workflow = JSON.parse(input.workflow_json as string)
    const params = (input.params as Record<string, unknown>) ?? {}

    const workflowBefore = JSON.parse(JSON.stringify(workflow))

    try {
      let result: Record<string, unknown>

      switch (actionType) {
        case 'add_node':
          result = this.addNode(workflow, params)
          break
        case 'remove_node':
          result = this.removeNode(workflow, params)
          break
        case 'connect_nodes':
          result = this.connectNodes(workflow, params)
          break
        case 'disconnect_nodes':
          result = this.disconnectNodes(workflow, params)
          break
        case 'modify_node':
          result = this.modifyNode(workflow, params)
          break
        case 'fix_workflow':
          result = this.fixWorkflow(workflow)
          break
        default:
          return JSON.stringify({ success: false, error: `Unknown action type: ${actionType}` })
      }

      const record: ActionRecord = {
        id: `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: actionType,
        workflow_before: workflowBefore,
        workflow_after: workflow,
        description: result.description as string ?? actionType,
        timestamp: new Date().toISOString(),
      }
      actionHistory.push(record)

      return JSON.stringify({
        success: true,
        action_id: record.id,
        workflow: workflow,
        description: result.description,
        changes: result.changes,
      }, null, 2)
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private addNode(workflow: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
    const nodeType = params.node_type as string
    const nodeId = (workflow.last_node_id as number) + 1
    const pos = (params.pos as [number, number]) ?? [100, 100]

    const newNode = {
      id: nodeId,
      type: nodeType,
      pos,
      size: { 0: 200, 1: 100 },
      flags: {},
      order: (workflow.nodes as unknown[]).length,
      mode: 0,
      inputs: [],
      outputs: [],
      properties: {},
      widgets_values: (params.widgets_values as unknown[]) ?? [],
    }

    ;(workflow.nodes as unknown[]).push(newNode)
    workflow.last_node_id = nodeId

    return {
      description: `Added ${nodeType} node (ID: ${nodeId})`,
      changes: { added_node_id: nodeId },
    }
  }

  private removeNode(workflow: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
    const nodeId = params.node_id as number
    const nodes = workflow.nodes as Array<Record<string, unknown>>
    const nodeIndex = nodes.findIndex(n => n.id === nodeId)

    if (nodeIndex === -1) {
      throw new Error(`Node ${nodeId} not found`)
    }

    const removedNode = nodes[nodeIndex]
    nodes.splice(nodeIndex, 1)

    const links = workflow.links as unknown[][]
    const linksToRemove = new Set<number>()
    const nodeOutputs = (removedNode.outputs as Array<Record<string, unknown>>) ?? []
    for (const output of nodeOutputs) {
      const outputLinks = output.links as number[]
      if (outputLinks) {
        for (const linkId of outputLinks) linksToRemove.add(linkId)
      }
    }
    const nodeInputs = (removedNode.inputs as Array<Record<string, unknown>>) ?? []
    for (const input of nodeInputs) {
      if (input.link != null) linksToRemove.add(input.link as number)
    }

    const filteredLinks = links.filter(l => !linksToRemove.has(Number(l[0])))
    workflow.links = filteredLinks

    return {
      description: `Removed node ${removedNode.type} (ID: ${nodeId}) and ${linksToRemove.size} connected links`,
      changes: { removed_node_id: nodeId, removed_links: [...linksToRemove] },
    }
  }

  private connectNodes(workflow: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
    const fromNodeId = params.from_node_id as number
    const fromSlot = (params.from_slot as number) ?? 0
    const toNodeId = params.to_node_id as number
    const toSlot = (params.to_slot as number) ?? 0

    const linkId = (workflow.last_link_id as number) + 1
    workflow.last_link_id = linkId

    const nodes = workflow.nodes as Array<Record<string, unknown>>
    const fromNode = nodes.find(n => n.id === fromNodeId)
    const toNode = nodes.find(n => n.id === toNodeId)

    if (!fromNode || !toNode) {
      throw new Error(`Node not found: from=${fromNodeId}, to=${toNodeId}`)
    }

    const outputs = fromNode.outputs as Array<Record<string, unknown>>
    if (outputs && outputs[fromSlot]) {
      const links = outputs[fromSlot].links as number[]
      if (!links) {
        outputs[fromSlot].links = []
      }
      ;(outputs[fromSlot].links as number[]).push(linkId)
    }

    const inputs = toNode.inputs as Array<Record<string, unknown>>
    if (inputs && inputs[toSlot]) {
      inputs[toSlot].link = linkId
    }

    const linkType = (outputs?.[fromSlot]?.type as string) ?? ''
    ;(workflow.links as unknown[]).push([linkId, fromNodeId, fromSlot, toNodeId, toSlot, linkType])

    return {
      description: `Connected node ${fromNodeId} output ${fromSlot} to node ${toNodeId} input ${toSlot}`,
      changes: { link_id: linkId },
    }
  }

  private disconnectNodes(workflow: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
    const linkId = params.link_id as number
    const links = workflow.links as unknown[][]
    const linkIndex = links.findIndex(l => Number(l[0]) === linkId)

    if (linkIndex === -1) {
      throw new Error(`Link ${linkId} not found`)
    }

    const link = links[linkIndex]
    links.splice(linkIndex, 1)

    return {
      description: `Disconnected link ${linkId}`,
      changes: { removed_link_id: linkId },
    }
  }

  private modifyNode(workflow: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
    const nodeId = params.node_id as number
    const nodes = workflow.nodes as Array<Record<string, unknown>>
    const node = nodes.find(n => n.id === nodeId)

    if (!node) {
      throw new Error(`Node ${nodeId} not found`)
    }

    const changes: Record<string, unknown> = {}

    if (params.widgets_values) {
      changes.widgets_values = { before: node.widgets_values, after: params.widgets_values }
      node.widgets_values = params.widgets_values
    }

    if (params.properties) {
      changes.properties = { before: node.properties, after: params.properties }
      node.properties = { ...(node.properties as Record<string, unknown>), ...(params.properties as Record<string, unknown>) }
    }

    return {
      description: `Modified node ${node.type} (ID: ${nodeId})`,
      changes,
    }
  }

  private fixWorkflow(workflow: Record<string, unknown>): Record<string, unknown> {
    const fixes: string[] = []
    const nodes = workflow.nodes as Array<Record<string, unknown>>

    for (const node of nodes) {
      const inputs = (node.inputs as Array<Record<string, unknown>>) ?? []
      for (const input of inputs) {
        if (input.link === null || input.link === undefined) {
          const inputName = input.name as string
          if (inputName === 'model' || inputName === 'clip' || inputName === 'vae' || inputName === 'positive' || inputName === 'negative' || inputName === 'latent_image') {
            fixes.push(`Node ${node.type} (ID: ${node.id}) has disconnected required input: ${inputName}`)
          }
        }
      }
    }

    return {
      description: `Workflow analysis found ${fixes.length} potential issues to fix`,
      changes: { issues_found: fixes.length, details: fixes },
    }
  }
}

export function getActionHistory(): ActionRecord[] {
  return [...actionHistory]
}

export function getLatestAction(): ActionRecord | undefined {
  return actionHistory.length > 0 ? actionHistory[actionHistory.length - 1] : undefined
}

export function undoLastAction(): ActionRecord | undefined {
  return actionHistory.pop()
}
