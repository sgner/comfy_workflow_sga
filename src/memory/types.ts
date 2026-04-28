export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

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

export const MEMORY_TYPES: Record<MemoryType, { label: string; description: string }> = {
  user: {
    label: 'User',
    description: 'User preferences, patterns, and personal context',
  },
  feedback: {
    label: 'Feedback',
    description: 'Behavioral feedback and correction patterns',
  },
  project: {
    label: 'Project',
    description: 'Project-specific knowledge and dynamics',
  },
  reference: {
    label: 'Reference',
    description: 'External references and documentation pointers',
  },
}

export const DEFAULT_MEMORY_EXTRACT_CONFIG: MemoryExtractConfig = {
  enabled: true,
  maxTurnsBetweenExtractions: 3,
  maxForkTurns: 5,
  allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
}

export const MEMORY_ENTRYPOINT_MAX_LINES = 200
export const MEMORY_ENTRYPOINT_MAX_BYTES = 25_000
export const MEMORY_MAX_FILES = 200
export const MEMORY_MAX_RELEVANT = 5
