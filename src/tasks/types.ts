export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface Task {
  id: string
  name?: string
  status: TaskStatus
  createdAt: number
  completedAt?: number
  progress: TaskProgress
  output?: string
  error?: string
  agentId?: string
  agentType?: string
  outputFile?: string
}

export interface TaskProgress {
  inputTokens: number
  outputTokens: number
  toolUseCount: number
  recentActivities: string[]
  lastActivityAt: number
}

export interface TaskNotification {
  taskId: string
  status: TaskStatus
  summary: string
  outputFile?: string
  error?: string
}

export const MAX_RECENT_ACTIVITIES = 5
