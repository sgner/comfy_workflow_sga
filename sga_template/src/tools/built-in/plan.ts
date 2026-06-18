import type { Tool, ToolUseContext, ValidationResult, ToolInputSchema, PermissionResult } from '../base.js'
import { BaseTool } from '../base.js'
import { getPlanManager } from '../../agents/plan-manager.js'
import type { CoordinatorPhase } from '../../agents/coordinator.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('plan-tool')

type PlanAction = 'create' | 'status' | 'update' | 'add_task' | 'remove_task'

export interface PlanToolInput {
  action: PlanAction
  query?: string
  strategy?: 'parallel' | 'sequential' | 'hybrid'
  tasks?: Array<{
    description: string
    phase: CoordinatorPhase
    agentType: string
    prompt: string
    dependsOn?: string[]
  }>
  task_id?: string
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  task?: {
    description: string
    phase: CoordinatorPhase
    agentType: string
    prompt: string
    dependsOn?: string[]
  }
}

export class PlanTool extends BaseTool<Record<string, unknown>, unknown> {
  name = 'Plan'
  description = 'Manage the execution plan for complex tasks. Create plans with tasks, check progress, update task status, add or remove tasks. Use this to organize and track multi-step work.'
  searchHint = 'plan task organize track progress'

  isEnabled(): boolean {
    return true
  }

  isConcurrencySafe(_input: Record<string, unknown>): boolean {
    return true
  }

  isReadOnly(_input: Record<string, unknown>): boolean {
    return false
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') {
      return { success: false, error: 'Input must be an object' }
    }
    const obj = input as Record<string, unknown>
    if (!obj['action'] || typeof obj['action'] !== 'string') {
      return { success: false, error: '"action" is required and must be one of: create, status, update, add_task, remove_task' }
    }
    const validActions: PlanAction[] = ['create', 'status', 'update', 'add_task', 'remove_task']
    if (!validActions.includes(obj['action'] as PlanAction)) {
      return { success: false, error: `"action" must be one of: ${validActions.join(', ')}` }
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
        action: {
          type: 'string',
          enum: ['create', 'status', 'update', 'add_task', 'remove_task'],
          description: 'The plan action to perform',
        },
        query: { type: 'string', description: 'The user query for plan creation (required for create action)' },
        strategy: { type: 'string', enum: ['parallel', 'sequential', 'hybrid'], description: 'Execution strategy (default: hybrid)' },
        tasks: {
          type: 'array',
          description: 'Task steps for plan creation',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              phase: { type: 'string', enum: ['research', 'synthesis', 'implementation', 'verification'] },
              agentType: { type: 'string' },
              prompt: { type: 'string' },
              dependsOn: { type: 'array', items: { type: 'string' } },
            },
            required: ['description', 'phase', 'agentType', 'prompt'],
          },
        },
        task_id: { type: 'string', description: 'Task ID for update/remove actions' },
        status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'skipped'], description: 'New status for update action' },
        task: {
          type: 'object',
          description: 'Task definition for add_task action',
          properties: {
            description: { type: 'string' },
            phase: { type: 'string', enum: ['research', 'synthesis', 'implementation', 'verification'] },
            agentType: { type: 'string' },
            prompt: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } },
          },
          required: ['description', 'phase', 'agentType', 'prompt'],
        },
      },
      required: ['action'],
    }
  }

  async call(input: Record<string, unknown>, _context: ToolUseContext): Promise<unknown> {
    const { action } = input as unknown as PlanToolInput
    const manager = getPlanManager()

    switch (action) {
      case 'create': {
        const { query, strategy, tasks } = input as unknown as PlanToolInput
        if (!query) {
          return { success: false, message: '"query" is required for create action' }
        }

        const steps = tasks ?? []
        if (steps.length === 0) {
          return { success: false, message: 'At least one task is required to create a plan' }
        }

        const plan = manager.createPlan(query, steps, strategy)
        return {
          success: true,
          planId: plan.id,
          taskCount: plan.tasks.length,
          strategy: plan.strategy,
          tasks: plan.tasks.map(t => ({ id: t.id, description: t.description, phase: t.phase, agentType: t.agentType, dependsOn: t.dependsOn })),
          summary: manager.formatPlanSummary(),
        }
      }

      case 'status': {
        const plan = manager.getPlan()
        if (!plan) {
          return { success: false, message: 'No active plan. Use create action first.' }
        }

        return {
          success: true,
          planId: plan.id,
          query: plan.query,
          strategy: plan.strategy,
          progress: manager.getProgress(),
          canLaunchMore: manager.canLaunchMore(),
          readyTasks: manager.getReadyTasks().map(t => ({ id: t.id, description: t.description, phase: t.phase })),
          summary: manager.formatPlanSummary(),
        }
      }

      case 'update': {
        const { task_id, status } = input as unknown as PlanToolInput
        if (!task_id || !status) {
          return { success: false, message: '"task_id" and "status" are required for update action' }
        }

        const updated = manager.updateTaskStatus(task_id, status)
        if (!updated) {
          return { success: false, message: `Task "${task_id}" not found` }
        }

        return {
          success: true,
          taskId: task_id,
          newStatus: status,
          progress: manager.getProgress(),
        }
      }

      case 'add_task': {
        const { task } = input as unknown as PlanToolInput
        if (!task) {
          return { success: false, message: '"task" is required for add_task action' }
        }

        const newTask = manager.addTask(task)
        return {
          success: true,
          taskId: newTask.id,
          progress: manager.getProgress(),
        }
      }

      case 'remove_task': {
        const { task_id } = input as unknown as PlanToolInput
        if (!task_id) {
          return { success: false, message: '"task_id" is required for remove_task action' }
        }

        const removed = manager.removeTask(task_id)
        if (!removed) {
          return { success: false, message: `Task "${task_id}" not found or is running` }
        }

        return {
          success: true,
          removedTaskId: task_id,
          progress: manager.getProgress(),
        }
      }

      default:
        return { success: false, message: `Unknown action: ${action}` }
    }
  }
}
