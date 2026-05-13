import type { Task, TaskStatus, TaskProgress, TaskNotification, TaskKind } from './types.js'
import { MAX_RECENT_ACTIVITIES } from './types.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('task-manager')

export interface CreateTaskOptions {
  id: string
  name?: string
  kind?: TaskKind
  agentId?: string
  agentType?: string
  parentTaskId?: string
  metadata?: Record<string, unknown>
}

export class TaskManager {
  private tasks: Map<string, Task> = new Map()
  private notificationQueue: TaskNotification[] = []
  private notificationHandlers: Array<(notification: TaskNotification) => void> = []

  create(options: string | CreateTaskOptions, name?: string, agentId?: string, agentType?: string): Task {
    const opts: CreateTaskOptions = typeof options === 'string'
      ? { id: options, name, agentId, agentType }
      : options

    const task: Task = {
      id: opts.id,
      name: opts.name,
      kind: opts.kind ?? 'generic',
      status: 'running',
      createdAt: Date.now(),
      progress: {
        inputTokens: 0,
        outputTokens: 0,
        toolUseCount: 0,
        turnCount: 0,
        recentActivities: [],
        lastActivityAt: Date.now(),
      },
      agentId: opts.agentId,
      agentType: opts.agentType,
      parentTaskId: opts.parentTaskId,
      metadata: opts.metadata,
    }
    this.tasks.set(task.id, task)
    logger.info(`Task created: ${task.id}, kind=${task.kind}, name=${task.name ?? 'unnamed'}`)
    return task
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  getAll(): Task[] {
    return [...this.tasks.values()]
  }

  getByStatus(status: TaskStatus): Task[] {
    return [...this.tasks.values()].filter(t => t.status === status)
  }

  getByKind(kind: TaskKind): Task[] {
    return [...this.tasks.values()].filter(t => t.kind === kind)
  }

  getByParent(parentId: string): Task[] {
    return [...this.tasks.values()].filter(t => t.parentTaskId === parentId)
  }

  getRunningAgentTasks(): Task[] {
    return this.getByKind('agent').filter(t => t.status === 'running')
  }

  updateProgress(id: string, update: Partial<TaskProgress>): void {
    const task = this.tasks.get(id)
    if (!task || (task.status !== 'running' && task.status !== 'pending')) return

    if (update.inputTokens !== undefined) task.progress.inputTokens += update.inputTokens
    if (update.outputTokens !== undefined) task.progress.outputTokens += update.outputTokens
    if (update.toolUseCount !== undefined) task.progress.toolUseCount += update.toolUseCount
    if (update.turnCount !== undefined) task.progress.turnCount += update.turnCount

    if (update.recentActivities) {
      task.progress.recentActivities = [
        ...update.recentActivities,
        ...task.progress.recentActivities,
      ].slice(0, MAX_RECENT_ACTIVITIES)
    }

    task.progress.lastActivityAt = Date.now()
  }

  addActivity(id: string, activity: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.progress.recentActivities = [activity, ...task.progress.recentActivities].slice(0, MAX_RECENT_ACTIVITIES)
    task.progress.lastActivityAt = Date.now()
  }

  complete(id: string, output?: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.status = 'completed'
    task.completedAt = Date.now()
    task.output = output
    logger.info(`Task completed: ${id}`)
    this.enqueueNotification({
      taskId: id,
      status: 'completed',
      summary: `Task "${task.name ?? id}" completed`,
      result: output,
    })
  }

  completeWithUsage(id: string, output: string, usage: TaskNotification['usage'], durationMs: number): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.status = 'completed'
    task.completedAt = Date.now()
    task.output = output
    logger.info(`Task completed: ${id}, duration=${durationMs}ms`)
    this.enqueueNotification({
      taskId: id,
      status: 'completed',
      summary: `Task "${task.name ?? id}" completed`,
      result: output,
      usage,
      durationMs,
    })
  }

  fail(id: string, error: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.status = 'failed'
    task.completedAt = Date.now()
    task.error = error
    logger.warn(`Task failed: ${id}, error=${error}`)
    this.enqueueNotification({
      taskId: id,
      status: 'failed',
      summary: `Task "${task.name ?? id}" failed: ${error}`,
      error,
    })
  }

  kill(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    if (task.abortController) {
      task.abortController.abort()
    }
    task.status = 'killed'
    task.completedAt = Date.now()
    logger.info(`Task killed: ${id}`)
    this.enqueueNotification({
      taskId: id,
      status: 'killed',
      summary: `Task "${task.name ?? id}" was killed`,
    })
  }

  setPending(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.status = 'pending'
  }

  setAbortController(id: string, controller: AbortController): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.abortController = controller
  }

  onNotification(handler: (notification: TaskNotification) => void): void {
    this.notificationHandlers.push(handler)
    for (const n of this.notificationQueue) {
      handler(n)
    }
    this.notificationQueue = []
  }

  removeNotificationHandler(handler: (notification: TaskNotification) => void): void {
    this.notificationHandlers = this.notificationHandlers.filter(h => h !== handler)
  }

  getPendingNotifications(): TaskNotification[] {
    return [...this.notificationQueue]
  }

  private enqueueNotification(notification: TaskNotification): void {
    if (this.notificationHandlers.length > 0) {
      for (const handler of this.notificationHandlers) {
        handler(notification)
      }
    } else {
      this.notificationQueue.push(notification)
    }
  }

  cleanup(maxAge: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now()
    for (const [id, task] of this.tasks) {
      if (task.status !== 'running' && task.status !== 'pending' && task.completedAt && now - task.completedAt > maxAge) {
        this.tasks.delete(id)
      }
    }
  }

  get size(): number {
    return this.tasks.size
  }

  get runningCount(): number {
    return this.getByStatus('running').length
  }
}

let globalTaskManager: TaskManager | null = null

export function getTaskManager(): TaskManager {
  if (!globalTaskManager) {
    globalTaskManager = new TaskManager()
  }
  return globalTaskManager
}

export function resetTaskManager(): void {
  globalTaskManager = null
}
