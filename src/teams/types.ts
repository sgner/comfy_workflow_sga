import type { PermissionMode } from '../core/types.js'

export interface TeamMember {
  agentId: string
  name: string
  agentType?: string
  model?: string
  prompt?: string
  color?: string
  planModeRequired?: boolean
  joinedAt: number
  cwd: string
  worktreePath?: string
  isActive: boolean
  mode?: PermissionMode
  subscriptions: string[]
}

export interface TeamFile {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  members: TeamMember[]
  teamAllowedPaths?: TeamAllowedPath[]
}

export interface TeamAllowedPath {
  path: string
  permissions: string[]
}

export interface TeamMessage {
  from: string
  text: string
  timestamp: string
  read: boolean
  color?: string
  summary?: string
}

export const TEAM_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F0B27A', '#82E0AA',
]
