export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'session'

export type MemoryScope = 'global' | 'project' | 'session'

export interface MemoryFile {
  path: string
  type: MemoryType
  description: string
  content: string
  frontmatter: MemoryFrontmatter
  mtimeMs: number
  sizeBytes: number
}

export interface MemoryFrontmatter {
  type?: MemoryType
  description?: string
  scope?: MemoryScope
  sessionId?: string
  created_at?: string
  updated_at?: string
  tags?: string[]
  [key: string]: unknown
}

export interface MemoryIndex {
  path: string
  content: string
  lineCount: number
  sizeBytes: number
  truncated: boolean
}

export interface MemoryRetrievalResult {
  memories: MemoryFile[]
  freshnessWarnings: Map<string, string>
}

export interface MemoryExtractConfig {
  enabled: boolean
  maxTurnsBetweenExtractions: number
  maxForkTurns: number
  allowedTools: string[]
}

export const MEMORY_TYPES: Record<MemoryType, { label: string; description: string; defaultScope: MemoryScope }> = {
  user: {
    label: 'User',
    description: 'User preferences, patterns, and personal context',
    defaultScope: 'global',
  },
  feedback: {
    label: 'Feedback',
    description: 'Behavioral feedback and correction patterns',
    defaultScope: 'project',
  },
  project: {
    label: 'Project',
    description: 'Project-specific knowledge and dynamics',
    defaultScope: 'project',
  },
  reference: {
    label: 'Reference',
    description: 'External references and documentation pointers',
    defaultScope: 'project',
  },
  session: {
    label: 'Session',
    description: 'Session-specific temporary context and working notes',
    defaultScope: 'session',
  },
}

export const MEMORY_SCOPES: Record<MemoryScope, { label: string; description: string }> = {
  global: {
    label: 'Global',
    description: 'Cross-project shared memory (user preferences, universal knowledge)',
  },
  project: {
    label: 'Project',
    description: 'Project-scoped memory shared across all sessions in the same project',
  },
  session: {
    label: 'Session',
    description: 'Session-isolated memory visible only within the current conversation',
  },
}

export const DEFAULT_MEMORY_EXTRACT_CONFIG: MemoryExtractConfig = {
  enabled: (process.env.SGA_MEMORY_EXTRACT_ENABLED ?? 'true') === 'true',
  maxTurnsBetweenExtractions: parseInt(process.env.SGA_MEMORY_MAX_TURNS_BETWEEN_EXTRACTIONS ?? '3', 10),
  maxForkTurns: parseInt(process.env.SGA_MEMORY_MAX_FORK_TURNS ?? '5', 10),
  allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
}

export const MEMORY_ENTRYPOINT_MAX_LINES = parseInt(process.env.SGA_MEMORY_ENTRYPOINT_MAX_LINES ?? '200', 10)
export const MEMORY_ENTRYPOINT_MAX_BYTES = parseInt(process.env.SGA_MEMORY_ENTRYPOINT_MAX_BYTES ?? '25000', 10)
export const MEMORY_MAX_FILES = parseInt(process.env.SGA_MEMORY_MAX_FILES ?? '200', 10)
export const MEMORY_MAX_RELEVANT = parseInt(process.env.SGA_MEMORY_MAX_RELEVANT ?? '5', 10)
