import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { MemoryFile, MemoryRetrievalResult, MemoryScope, MemoryType } from './types.js'
import { MEMORY_MAX_RELEVANT, DEFAULT_MEMORY_EXTRACT_CONFIG, MEMORY_TYPES } from './types.js'
import { getAutoMemPath, ensureMemoryDirExists, getMemoryEntrypointPath, type MemoryPathConfig } from './paths.js'
import { findRelevantMemories, DEFAULT_RETRIEVER_CONFIG, setRetrievalProvider } from './retrieval.js'
import { buildMemoryPrompt, buildExtractPrompt, truncateEntrypointContent } from './prompt.js'
import { createLogger } from '../utils/logger.js'
import type { LLMProvider } from '../providers/types.js'
import type { MemoryStorageBackend, StorageBackendConfig, StorageQueryOptions, StorageSearchOptions } from './storage/types.js'
import { createBackend } from './storage/registry.js'
import { FileSystemBackend } from './storage/filesystem.js'

const logger = createLogger('memory-manager')

export interface MemoryManagerConfig {
  pathConfig?: MemoryPathConfig
  maxRelevant?: number
  freshnessThresholdDays?: number
  extractConfig?: typeof DEFAULT_MEMORY_EXTRACT_CONFIG
  storage?: StorageBackendConfig
  backend?: MemoryStorageBackend
  sessionId?: string
}

export class MemoryManager {
  private memoryDir: string
  private config: MemoryManagerConfig
  private backend: MemoryStorageBackend
  private cachedMemories: MemoryFile[] | null = null
  private lastScanTime = 0
  private scanIntervalMs = 30_000
  private sessionId: string

  constructor(config: MemoryManagerConfig = {}) {
    this.config = config
    this.memoryDir = getAutoMemPath(config.pathConfig)
    this.sessionId = config.sessionId ?? generateSessionId()

    if (config.backend) {
      this.backend = config.backend
    } else if (config.storage) {
      this.backend = createBackend(config.storage)
    } else {
      this.backend = new FileSystemBackend({
        type: 'filesystem',
        memoryDir: this.memoryDir,
        scanIntervalMs: this.scanIntervalMs,
      })
    }
  }

  async init(): Promise<void> {
    await this.backend.initialize()

    if (this.isFileSystemBackend()) {
      ensureMemoryDirExists(this.memoryDir)
    }

    await this.refreshCache()
    logger.info(`MemoryManager initialized, backend=${this.backend.type}, sessionId=${this.sessionId}, memories=${this.cachedMemories?.length ?? 0}`)
  }

  getMemoryDir(): string {
    return this.memoryDir
  }

  getBackend(): MemoryStorageBackend {
    return this.backend
  }

  getBackendType(): string {
    return this.backend.type
  }

  getSessionId(): string {
    return this.sessionId
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId
    this.cachedMemories = null
    logger.debug(`Session ID updated: ${sessionId}`)
  }

  setProvider(provider: LLMProvider, model?: string): void {
    setRetrievalProvider(provider, model)
  }

  async refreshCache(): Promise<void> {
    try {
      this.cachedMemories = await this.backend.list({
        scope: 'session',
        sessionId: this.sessionId,
      })
      this.lastScanTime = Date.now()
    } catch (error) {
      logger.warn(`Failed to refresh cache: ${error instanceof Error ? error.message : String(error)}`)
      this.cachedMemories = []
    }
  }

  private async ensureCache(): Promise<MemoryFile[]> {
    if (!this.cachedMemories || Date.now() - this.lastScanTime > this.scanIntervalMs) {
      await this.refreshCache()
    }
    return this.cachedMemories ?? []
  }

  async listMemoriesByScope(scope: MemoryScope, options?: Omit<StorageQueryOptions, 'scope' | 'sessionId'>): Promise<MemoryFile[]> {
    return this.backend.list({
      ...options,
      scope,
      sessionId: this.sessionId,
    })
  }

  async listGlobalMemories(options?: Omit<StorageQueryOptions, 'scope' | 'sessionId'>): Promise<MemoryFile[]> {
    return this.listMemoriesByScope('global', options)
  }

  async listProjectMemories(options?: Omit<StorageQueryOptions, 'scope' | 'sessionId'>): Promise<MemoryFile[]> {
    return this.listMemoriesByScope('project', options)
  }

  async listSessionMemories(options?: Omit<StorageQueryOptions, 'scope' | 'sessionId'>): Promise<MemoryFile[]> {
    return this.listMemoriesByScope('session', options)
  }

  async buildSystemPromptSection(): Promise<string> {
    if (this.isFileSystemBackend()) {
      const entrypointPath = getMemoryEntrypointPath(this.memoryDir)
      let entrypointContent = ''

      if (existsSync(entrypointPath)) {
        try {
          entrypointContent = readFileSync(entrypointPath, 'utf-8')
        } catch {
          entrypointContent = ''
        }
      }

      return buildMemoryPrompt(this.memoryDir, entrypointContent)
    }

    return this.buildDatabaseSystemPromptSection()
  }

  private async buildDatabaseSystemPromptSection(): Promise<string> {
    const stats = await this.backend.getStats()
    const memories = await this.ensureCache()

    const memoryTypesSection = Object.entries(MEMORY_TYPES)
      .map(([key, val]) => `- **${val.label}** (${key}): ${val.description} [scope: ${val.defaultScope}]`)
      .join('\n')

    const scopeSection = `## Memory Scopes
- **Global**: Cross-project shared memory (user preferences, universal knowledge)
- **Project**: Project-scoped memory shared across all sessions in the same project
- **Session**: Session-isolated memory visible only within the current conversation (session: ${this.sessionId})`

    const indexLines = memories.length === 0
      ? 'No memories stored yet.'
      : memories.map(m => {
          const scope = m.frontmatter.scope ?? MEMORY_TYPES[m.type as MemoryType]?.defaultScope ?? 'project'
          return `- [${m.type}][${scope}] ${m.description}`
        }).join('\n')

    return `# Auto Memory

You have a persistent memory system backed by **${this.backend.type}** storage.

## Types of Memory
${memoryTypesSection}

${scopeSection}

## What NOT to Save
- Information already in SGA.md, CLAUDE.md, or project documentation
- Temporary debugging state
- Sensitive credentials or secrets
- Verbatim file contents (reference the file path instead)

## How to Save Memories
Use the memory save API to create new memory entries with type, description, and content.
You can specify the scope (global, project, or session) to control visibility.

## Memory Index (Total: ${stats.totalMemories}, Session: ${this.sessionId})
\`\`\`
${indexLines}
\`\`\``
  }

  async findRelevant(query: string, alreadySurfaced?: Set<string>): Promise<MemoryRetrievalResult> {
    const searchResults = await this.backend.search({
      query,
      limit: this.config.maxRelevant ?? MEMORY_MAX_RELEVANT,
      scope: 'session',
      sessionId: this.sessionId,
    })

    if (searchResults.length > 0) {
      const memories = searchResults.map(r => r.memory)
      const freshnessWarnings = new Map<string, string>()
      const thresholdDays = this.config.freshnessThresholdDays ?? DEFAULT_RETRIEVER_CONFIG.freshnessThresholdDays

      for (const memory of memories) {
        const ageDays = (Date.now() - memory.mtimeMs) / (1000 * 60 * 60 * 24)
        if (ageDays > thresholdDays) {
          freshnessWarnings.set(
            memory.path,
            `This memory is ${Math.round(ageDays)} days old. Verify against current code before asserting as fact.`,
          )
        }
      }

      const filtered = alreadySurfaced
        ? memories.filter(m => !alreadySurfaced.has(m.path))
        : memories

      return { memories: filtered, freshnessWarnings }
    }

    const memories = await this.ensureCache()
    return findRelevantMemories(query, memories, alreadySurfaced, {
      ...DEFAULT_RETRIEVER_CONFIG,
      maxRelevant: this.config.maxRelevant ?? MEMORY_MAX_RELEVANT,
      freshnessThresholdDays: this.config.freshnessThresholdDays ?? DEFAULT_RETRIEVER_CONFIG.freshnessThresholdDays,
    })
  }

  async getMemoryContextForQuery(query: string): Promise<string> {
    const result = await this.findRelevant(query)
    const parts: string[] = []

    if (result.memories.length > 0) {
      parts.push('## Relevant Memories')
      for (const memory of result.memories) {
        const warning = result.freshnessWarnings.get(memory.path)
        const scope = memory.frontmatter.scope ?? 'project'
        parts.push(`### [${memory.type}][${scope}] ${memory.description}`)
        const contentLines = memory.content.split('\n')
        const bodyStart = contentLines.findIndex((_, i) => {
          if (i === 0) return false
          return contentLines[i - 1].trim() === '---' && i > 1
        })
        const body = bodyStart >= 0 ? contentLines.slice(bodyStart + 1).join('\n').trim() : memory.content.trim()
        parts.push(body)
        if (warning) {
          parts.push(`> ⚠️ ${warning}`)
        }
        parts.push('')
      }
    }

    return parts.join('\n')
  }

  async saveMemoryFile(
    filename: string,
    type: string,
    description: string,
    content: string,
    scope?: MemoryScope,
  ): Promise<void> {
    const now = new Date().toISOString()
    const resolvedScope = scope ?? this.inferScope(type as MemoryType)

    await this.backend.save({
      path: filename,
      type: type as MemoryFile['type'],
      description,
      content,
      frontmatter: {
        type: type as MemoryFile['type'],
        description,
        scope: resolvedScope,
        sessionId: resolvedScope === 'session' ? this.sessionId : undefined,
        created_at: now,
        updated_at: now,
      },
    })

    logger.info(`Saved memory: ${filename} (type=${type}, scope=${resolvedScope}, backend=${this.backend.type})`)

    this.cachedMemories = null
    await this.ensureCache()

    if (this.isFileSystemBackend()) {
      await this.updateEntrypoint()
    }
  }

  inferScope(type: MemoryType): MemoryScope {
    const typeConfig = MEMORY_TYPES[type]
    return typeConfig?.defaultScope ?? 'project'
  }

  async deleteSessionMemories(): Promise<number> {
    const sessionMemories = await this.listSessionMemories()
    let deleted = 0

    for (const m of sessionMemories) {
      if (m.frontmatter.scope === 'session') {
        const ok = await this.backend.delete(m.path)
        if (ok) deleted++
      }
    }

    if (deleted > 0) {
      this.cachedMemories = null
      await this.ensureCache()
      logger.info(`Deleted ${deleted} session memories for session ${this.sessionId}`)
    }

    return deleted
  }

  async updateEntrypoint(): Promise<void> {
    if (!this.isFileSystemBackend()) return

    const memories = await this.ensureCache()
    const entrypointPath = getMemoryEntrypointPath(this.memoryDir)

    const lines: string[] = [
      '# Memory Index',
      '',
      `Last updated: ${new Date().toISOString()}`,
      `Session: ${this.sessionId}`,
      '',
    ]

    if (memories.length === 0) {
      lines.push('No memories stored yet.')
    } else {
      lines.push(`Total memories: ${memories.length}`)
      lines.push('')

      const globalMems = memories.filter(m => m.frontmatter.scope === 'global' || (!m.frontmatter.scope && m.type === 'user'))
      const projectMems = memories.filter(m => m.frontmatter.scope === 'project' || (!m.frontmatter.scope && m.type !== 'user' && m.type !== 'session'))
      const sessionMems = memories.filter(m => m.frontmatter.scope === 'session')

      if (globalMems.length > 0) {
        lines.push('## Global')
        for (const m of globalMems) lines.push(`- [${m.type}] ${m.description} (\`${m.path}\`)`)
        lines.push('')
      }

      if (projectMems.length > 0) {
        lines.push('## Project')
        for (const m of projectMems) lines.push(`- [${m.type}] ${m.description} (\`${m.path}\`)`)
        lines.push('')
      }

      if (sessionMems.length > 0) {
        lines.push(`## Session (${this.sessionId})`)
        for (const m of sessionMems) lines.push(`- [${m.type}] ${m.description} (\`${m.path}\`)`)
        lines.push('')
      }
    }

    const content = lines.join('\n')
    const truncated = truncateEntrypointContent(content)
    writeFileSync(entrypointPath, truncated.content, 'utf-8')
  }

  async shouldExtractMemory(messageCount: number, lastExtractMessageCount: number): Promise<boolean> {
    const config = this.config.extractConfig ?? DEFAULT_MEMORY_EXTRACT_CONFIG
    if (!config.enabled) return false

    const turnsSinceLastExtraction = messageCount - lastExtractMessageCount
    return turnsSinceLastExtraction >= config.maxTurnsBetweenExtractions
  }

  buildExtractionPrompt(conversationSummary: string): string {
    const memories = this.cachedMemories ?? []
    const manifest = memories.map(m => {
      const scope = m.frontmatter.scope ?? 'project'
      return `[${m.type}][${scope}] ${m.description}`
    }).join('\n')
    return buildExtractPrompt(conversationSummary, manifest)
  }

  private isFileSystemBackend(): boolean {
    return this.backend.type === 'filesystem'
  }
}

let managerInstance: MemoryManager | null = null

export function getMemoryManager(): MemoryManager | null {
  return managerInstance
}

export function setMemoryManager(manager: MemoryManager): void {
  managerInstance = manager
}

export async function initMemoryManager(config?: MemoryManagerConfig): Promise<MemoryManager> {
  const manager = new MemoryManager(config)
  await manager.init()
  setMemoryManager(manager)
  return manager
}

function generateSessionId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `sess_${timestamp}_${random}`
}
