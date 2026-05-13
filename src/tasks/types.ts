export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed' | 'pending'

export type TaskKind = 'agent' | 'coordinator' | 'fork' | 'generic'

export interface Task {
  id: string
  name?: string
  kind: TaskKind
  status: TaskStatus
  createdAt: number
  completedAt?: number
  progress: TaskProgress
  output?: string
  error?: string
  agentId?: string
  agentType?: string
  outputFile?: string
  parentTaskId?: string
  abortController?: AbortController
  metadata?: Record<string, unknown>
}

export interface TaskProgress {
  inputTokens: number
  outputTokens: number
  toolUseCount: number
  turnCount: number
  recentActivities: string[]
  lastActivityAt: number
}

export interface TaskNotification {
  taskId: string
  status: TaskStatus
  summary: string
  outputFile?: string
  error?: string
  result?: string
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    totalCostUsd: number
  }
  durationMs?: number
}

export const MAX_RECENT_ACTIVITIES = 5
