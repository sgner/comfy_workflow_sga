import type { Task, TaskStatus, TaskProgress, TaskNotification } from './types.js'
import { MAX_RECENT_ACTIVITIES } from './types.js'

export class TaskManager {
  private tasks: Map<string, Task> = new Map()
  private notificationQueue: TaskNotification[] = []
  private notificationHandlers: Array<(notification: TaskNotification) => void> = []

  create(id: string, name?: string, agentId?: string, agentType?: string): Task {
    const task: Task = {
      id,
      name,
      status: 'running',
      createdAt: Date.now(),
      progress: {
        inputTokens: 0,
        outputTokens: 0,
        toolUseCount: 0,
        recentActivities: [],
        lastActivityAt: Date.now(),
      },
      agentId,
      agentType,
    }
    this.tasks.set(id, task)
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

  updateProgress(id: string, update: Partial<TaskProgress>): void {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'running') return

    if (update.inputTokens !== undefined) task.progress.inputTokens += update.inputTokens
    if (update.outputTokens !== undefined) task.progress.outputTokens += update.outputTokens
    if (update.toolUseCount !== undefined) task.progress.toolUseCount += update.toolUseCount

    if (update.recentActivities) {
      task.progress.recentActivities = [
        ...update.recentActivities,
        ...task.progress.recentActivities,
      ].slice(0, MAX_RECENT_ACTIVITIES)
    }

    task.progress.lastActivityAt = Date.now()
  }

  complete(id: string, output?: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.status = 'completed'
    task.completedAt = Date.now()
    task.output = output
    this.enqueueNotification({
      taskId: id,
      status: 'completed',
      summary: `Task "${task.name ?? id}" completed`,
    })
  }

  fail(id: string, error: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.status = 'failed'
    task.completedAt = Date.now()
    task.error = error
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
    task.status = 'killed'
    task.completedAt = Date.now()
    this.enqueueNotification({
      taskId: id,
      status: 'killed',
      summary: `Task "${task.name ?? id}" was killed`,
    })
  }

  onNotification(handler: (notification: TaskNotification) => void): void {
    this.notificationHandlers.push(handler)
    for (const n of this.notificationQueue) {
      handler(n)
    }
    this.notificationQueue = []
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
      if (task.status !== 'running' && task.completedAt && now - task.completedAt > maxAge) {
        this.tasks.delete(id)
      }
    }
  }
}
