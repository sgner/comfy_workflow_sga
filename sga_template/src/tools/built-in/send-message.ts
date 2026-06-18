import type { Tool, ToolUseContext, ValidationResult, ToolInputSchema, PermissionResult } from '../base.js'
import { BaseTool } from '../base.js'
import { getRunningTask, appendPendingMessage } from './agent.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('send-message-tool')

export interface SendMessageInput {
  to: string
  message: string
  summary?: string
}

export interface SendMessageOutput {
  success: boolean
  message: string
  result?: string
  status?: string
}

export class SendMessageTool extends BaseTool<Record<string, unknown>, unknown> {
  name = 'SendMessage'
  description = 'Send a message to a running agent. Use this to continue a worker with follow-up instructions or corrections.'
  searchHint = 'send message agent teammate communicate'

  isEnabled(): boolean {
    return true
  }

  isConcurrencySafe(_input: Record<string, unknown>): boolean {
    return false
  }

  isReadOnly(_input: Record<string, unknown>): boolean {
    return true
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') {
      return { success: false, error: 'Input must be an object' }
    }
    const obj = input as Record<string, unknown>
    if (!obj['to'] || typeof obj['to'] !== 'string') {
      return { success: false, error: '"to" is required and must be a string (agent ID or name)' }
    }
    if (!obj['message'] || typeof obj['message'] !== 'string') {
      return { success: false, error: '"message" is required and must be a string' }
    }
    return { success: true }
  }

  async checkPermissions(_input: Record<string, unknown>, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: 'allow' }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The agent ID to send the message to (from task-notification task-id)' },
        message: { type: 'string', description: 'The message to send to the agent' },
        summary: { type: 'string', description: 'Short summary of the message for display' },
      },
      required: ['to', 'message'],
    }
  }

  async call(input: Record<string, unknown>, context: ToolUseContext): Promise<unknown> {
    const { to, message, summary } = input as unknown as SendMessageInput

    const task = getRunningTask(to)
    if (!task) {
      return {
        success: false,
        message: `Agent "${to}" not found. It may have already completed or never existed. Check task-notification messages for valid agent IDs.`,
      }
    }

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'killed') {
      if (task.result) {
        return {
          success: false,
          message: `Agent "${to}" has already finished with status: ${task.status}. Start a new agent with the Agent tool if you need additional work.`,
          result: task.result.content,
          status: task.status,
        }
      }
      return {
        success: false,
        message: `Agent "${to}" has already finished with status: ${task.status}. Start a new agent with the Agent tool.`,
        status: task.status,
      }
    }

    if (task.status === 'running') {
      const appended = appendPendingMessage(to, { role: 'user', content: message })
      if (!appended) {
        return {
          success: false,
          message: `Failed to queue message for agent "${to}".`,
        }
      }

      logger.info(`Queued message for running agent ${to}: ${summary ?? message.slice(0, 80)}`)

      return {
        success: true,
        message: `Message queued for agent "${to}". It will be delivered at the agent's next tool round.`,
      }
    }

    return {
      success: false,
      message: `Agent "${to}" is in unexpected state: ${task.status}`,
    }
  }
}
