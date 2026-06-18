import type { CoordinatorPhase, CoordinatorPlan, CoordinatorTask, CoordinatorTaskStep, CoordinatorSnapshot } from './coordinator.js'
import { createLogger } from '../utils/logger.js'
import { writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const logger = createLogger('plan-manager')

export type PlanNotificationCallback = (event: {
  type: 'plan_created' | 'task_updated' | 'task_added' | 'task_removed'
  planId: string
  taskId?: string
  taskDescription?: string
  taskStatus?: string
  taskPhase?: string
  taskAgentType?: string
  progress?: { total: number; pending: number; running: number; completed: number; failed: number; skipped: number; percentComplete: number }
  tasks?: Array<{ id: string; description: string; phase: string; status: string; agentType: string }>
}) => void

let planCounter = 0

function generatePlanId(): string {
  planCounter++
  return `plan-${Date.now().toString(36)}-${planCounter}`
}

function generateTaskId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export class PlanManager {
  private activePlan: CoordinatorPlan | null = null
  private tasks: Map<string, CoordinatorTask> = new Map()
  private snapshotDir: string
  private maxConcurrency: number
  private notificationCallback: PlanNotificationCallback | null = null

  constructor(options?: { snapshotDir?: string; maxConcurrency?: number }) {
    this.snapshotDir = options?.snapshotDir ?? join(process.cwd(), '.sga', 'snapshots')
    this.maxConcurrency = options?.maxConcurrency ?? 5
  }

  setNotificationCallback(cb: PlanNotificationCallback | null): void {
    this.notificationCallback = cb
  }

  private notify(event: Parameters<PlanNotificationCallback>[0]): void {
    if (this.notificationCallback) {
      try {
        this.notificationCallback(event)
      } catch {
        // notification callback error should not break plan operations
      }
    }
  }

  private getTasksSnapshot(): Array<{ id: string; description: string; phase: string; status: string; agentType: string }> {
    return [...this.tasks.values()].map(t => ({
      id: t.id,
      description: t.description,
      phase: t.phase,
      status: t.status,
      agentType: t.agentType,
    }))
  }

  createPlan(query: string, steps: CoordinatorTaskStep[], strategy: CoordinatorPlan['strategy'] = 'hybrid'): CoordinatorPlan {
    const plan: CoordinatorPlan = {
      id: generatePlanId(),
      query,
      tasks: steps.map(step => ({
        ...step,
        id: step.id ?? generateTaskId(),
      })),
      strategy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    this.activePlan = plan
    this.tasks.clear()

    for (const step of plan.tasks) {
      const task: CoordinatorTask = {
        id: step.id ?? generateTaskId(),
        description: step.description,
        phase: step.phase,
        agentType: step.agentType,
        prompt: step.prompt,
        status: 'pending',
        dependsOn: step.dependsOn,
      }
      this.tasks.set(task.id, task)
    }

    logger.info(`Plan created: ${plan.id} with ${plan.tasks.length} tasks, strategy=${strategy}`)

    this.notify({
      type: 'plan_created',
      planId: plan.id,
      progress: this.getProgress(),
      tasks: this.getTasksSnapshot(),
    })

    return plan
  }

  getPlan(): CoordinatorPlan | null {
    return this.activePlan
  }

  getTask(taskId: string): CoordinatorTask | undefined {
    return this.tasks.get(taskId)
  }

  getAllTasks(): CoordinatorTask[] {
    return [...this.tasks.values()]
  }

  getTasksByPhase(phase: CoordinatorPhase): CoordinatorTask[] {
    return [...this.tasks.values()].filter(t => t.phase === phase)
  }

  getTasksByStatus(status: CoordinatorTask['status']): CoordinatorTask[] {
    return [...this.tasks.values()].filter(t => t.status === status)
  }

  getReadyTasks(): CoordinatorTask[] {
    return [...this.tasks.values()].filter(task => {
      if (task.status !== 'pending') return false
      if (!task.dependsOn || task.dependsOn.length === 0) return true
      return task.dependsOn.every(depId => {
        const dep = this.tasks.get(depId)
        return dep && dep.status === 'completed'
      })
    })
  }

  getRunningCount(): number {
    return [...this.tasks.values()].filter(t => t.status === 'running').length
  }

  canLaunchMore(): boolean {
    return this.getRunningCount() < this.maxConcurrency
  }

  updateTaskStatus(taskId: string, status: CoordinatorTask['status'], result?: CoordinatorTask['result'], error?: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    task.status = status
    if (result) task.result = result
    if (error) task.error = error

    if (this.activePlan) {
      this.activePlan.updatedAt = Date.now()
    }

    logger.info(`Task ${taskId} → ${status}${error ? ` (${error})` : ''}`)

    this.notify({
      type: 'task_updated',
      planId: this.activePlan?.id ?? '',
      taskId,
      taskDescription: task.description,
      taskStatus: status,
      taskPhase: task.phase,
      taskAgentType: task.agentType,
      progress: this.getProgress(),
      tasks: this.getTasksSnapshot(),
    })

    return true
  }

  addTask(step: CoordinatorTaskStep): CoordinatorTask {
    const task: CoordinatorTask = {
      id: step.id ?? generateTaskId(),
      description: step.description,
      phase: step.phase,
      agentType: step.agentType,
      prompt: step.prompt,
      status: 'pending',
      dependsOn: step.dependsOn,
    }
    this.tasks.set(task.id, task)

    if (this.activePlan) {
      this.activePlan.tasks.push({ ...step, id: task.id })
      this.activePlan.updatedAt = Date.now()
    }

    logger.info(`Task added: ${task.id} (${task.phase}/${task.agentType})`)

    this.notify({
      type: 'task_added',
      planId: this.activePlan?.id ?? '',
      taskId: task.id,
      taskDescription: task.description,
      taskStatus: task.status,
      taskPhase: task.phase,
      taskAgentType: task.agentType,
      progress: this.getProgress(),
      tasks: this.getTasksSnapshot(),
    })

    return task
  }

  removeTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    if (task.status === 'running') {
      logger.warn(`Cannot remove running task ${taskId}`)
      return false
    }

    this.tasks.delete(taskId)
    if (this.activePlan) {
      this.activePlan.tasks = this.activePlan.tasks.filter(t => t.id !== taskId)
      this.activePlan.updatedAt = Date.now()
    }

    logger.info(`Task removed: ${taskId}`)

    this.notify({
      type: 'task_removed',
      planId: this.activePlan?.id ?? '',
      taskId,
      taskDescription: task.description,
      progress: this.getProgress(),
      tasks: this.getTasksSnapshot(),
    })

    return true
  }

  getProgress(): { total: number; pending: number; running: number; completed: number; failed: number; skipped: number; percentComplete: number } {
    const all = [...this.tasks.values()]
    const total = all.length
    const pending = all.filter(t => t.status === 'pending').length
    const running = all.filter(t => t.status === 'running').length
    const completed = all.filter(t => t.status === 'completed').length
    const failed = all.filter(t => t.status === 'failed').length
    const skipped = all.filter(t => t.status === 'skipped').length

    return {
      total,
      pending,
      running,
      completed,
      failed,
      skipped,
      percentComplete: total > 0 ? Math.round((completed / total) * 100) : 0,
    }
  }

  isComplete(): boolean {
    return [...this.tasks.values()].every(t =>
      t.status === 'completed' || t.status === 'failed' || t.status === 'skipped'
    )
  }

  saveSnapshot(): string | null {
    if (!this.activePlan) return null

    try {
      if (!existsSync(this.snapshotDir)) {
        mkdirSync(this.snapshotDir, { recursive: true })
      }

      const snapshot: CoordinatorSnapshot = {
        plan: this.activePlan,
        tasks: [...this.tasks.values()].map(t => ({
          id: t.id,
          description: t.description,
          phase: t.phase,
          agentType: t.agentType,
          prompt: t.prompt,
          status: t.status,
          result: t.result ? {
            content: t.result.content,
            durationMs: t.result.durationMs,
            turnCount: t.result.turnCount,
            toolUseCount: t.result.toolUseCount,
          } : undefined,
          error: t.error,
          dependsOn: t.dependsOn,
        })),
        totalUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalTokens: 0,
          totalCostUsd: 0,
        },
        startedAt: this.activePlan.createdAt,
        savedAt: Date.now(),
      }

      const filepath = join(this.snapshotDir, `${this.activePlan.id}.json`)
      writeFileSync(filepath, JSON.stringify(snapshot, null, 2), 'utf-8')
      logger.info(`Snapshot saved: ${filepath}`)
      return filepath
    } catch (error) {
      logger.error(`Failed to save snapshot: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  loadSnapshot(planId: string): boolean {
    const filepath = join(this.snapshotDir, `${planId}.json`)
    if (!existsSync(filepath)) {
      logger.warn(`Snapshot not found: ${filepath}`)
      return false
    }

    try {
      const content = readFileSync(filepath, 'utf-8')
      const snapshot: CoordinatorSnapshot = JSON.parse(content)

      this.activePlan = snapshot.plan
      this.tasks.clear()

      for (const t of snapshot.tasks) {
        const task: CoordinatorTask = {
          id: t.id,
          description: t.description,
          phase: t.phase,
          agentType: t.agentType,
          prompt: t.prompt,
          status: t.status,
          dependsOn: t.dependsOn,
          error: t.error,
        }
        this.tasks.set(task.id, task)
      }

      logger.info(`Snapshot loaded: ${planId} with ${snapshot.tasks.length} tasks`)
      return true
    } catch (error) {
      logger.error(`Failed to load snapshot: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  clear(): void {
    this.activePlan = null
    this.tasks.clear()
  }

  formatPlanSummary(): string {
    if (!this.activePlan) return 'No active plan'

    const progress = this.getProgress()
    const lines: string[] = [
      `Plan: ${this.activePlan.id}`,
      `Query: ${this.activePlan.query}`,
      `Strategy: ${this.activePlan.strategy}`,
      `Progress: ${progress.percentComplete}% (${progress.completed}/${progress.total} done, ${progress.running} running, ${progress.pending} pending, ${progress.failed} failed)`,
      '',
      'Tasks:',
    ]

    for (const task of this.tasks.values()) {
      const statusIcon = {
        pending: '⏳',
        running: '🔄',
        completed: '✅',
        failed: '❌',
        skipped: '⏭️',
      }[task.status] ?? '?'

      const deps = task.dependsOn?.length ? ` (depends: ${task.dependsOn.join(', ')})` : ''
      lines.push(`  ${statusIcon} [${task.phase}] ${task.id}: ${task.description}${deps}`)
    }

    return lines.join('\n')
  }
}

let globalPlanManager: PlanManager | null = null

export function getPlanManager(options?: { snapshotDir?: string; maxConcurrency?: number }): PlanManager {
  if (!globalPlanManager) {
    globalPlanManager = new PlanManager(options)
  }
  return globalPlanManager
}

export function resetPlanManager(): void {
  if (globalPlanManager) {
    globalPlanManager.clear()
  }
  globalPlanManager = null
}
