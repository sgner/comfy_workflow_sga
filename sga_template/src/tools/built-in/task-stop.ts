import type { Tool, ToolUseContext, ValidationResult, ToolInputSchema, PermissionResult } from '../base.js'
import { BaseTool } from '../base.js'
import { killRunningTask, getRunningTask } from './agent.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('task-stop-tool')

export interface TaskStopInput {
  task_id: string
}

export interface TaskStopOutput {
  success: boolean
  message: string
}

export class TaskStopTool extends BaseTool<Record<string, unknown>, unknown> {
  name = 'TaskStop'
  description = 'Stop a running agent/worker. Use this when you realize a worker is going in the wrong direction or the user changes requirements.'
  searchHint = 'stop kill cancel agent task worker'

  isEnabled(): boolean {
    return true
  }

  isConcurrencySafe(_input: Record<string, unknown>): boolean {
    return true
  }

  isReadOnly(_input: Record<string, unknown>): boolean {
    return true
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') {
      return { success: false, error: 'Input must be an object' }
    }
    const obj = input as Record<string, unknown>
    if (!obj['task_id'] || typeof obj['task_id'] !== 'string') {
      return { success: false, error: 'task_id is required and must be a string' }
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
        task_id: { type: 'string', description: 'The task/agent ID to stop (from Agent tool result or task-notification)' },
      },
      required: ['task_id'],
    }
  }

  async call(input: Record<string, unknown>, _context: ToolUseContext): Promise<unknown> {
    const { task_id } = input as unknown as TaskStopInput

    const task = getRunningTask(task_id)
    if (!task) {
      return {
        success: false,
        message: `Task "${task_id}" not found. It may have already completed or never existed.`,
      }
    }

    if (task.status !== 'running') {
      return {
        success: false,
        message: `Task "${task_id}" is not running (status: ${task.status}). Only running tasks can be stopped.`,
      }
    }

    const killed = killRunningTask(task_id)
    if (killed) {
      logger.info(`Stopped task ${task_id}`)
      return {
        success: true,
        message: `Task "${task_id}" has been stopped. You can continue this agent later using SendMessage with the same ID.`,
      }
    }

    return {
      success: false,
      message: `Failed to stop task "${task_id}".`,
    }
  }
}
