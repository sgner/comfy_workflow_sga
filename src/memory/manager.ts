import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { MemoryFile, MemoryRetrievalResult } from './types.js'
import { MEMORY_MAX_RELEVANT, DEFAULT_MEMORY_EXTRACT_CONFIG } from './types.js'
import { getAutoMemPath, ensureMemoryDirExists, getMemoryEntrypointPath, type MemoryPathConfig } from './paths.js'
import { findRelevantMemories, DEFAULT_RETRIEVER_CONFIG, setRetrievalProvider } from './retrieval.js'
import { buildMemoryPrompt, buildExtractPrompt, truncateEntrypointContent } from './prompt.js'
import { createLogger } from '../utils/logger.js'
import type { LLMProvider } from '../providers/types.js'
import type { MemoryStorageBackend, StorageBackendConfig } from './storage/types.js'
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
}

export class MemoryManager {
  private memoryDir: string
  private config: MemoryManagerConfig
  private backend: MemoryStorageBackend
  private cachedMemories: MemoryFile[] | null = null
  private lastScanTime = 0
  private scanIntervalMs = 30_000

  constructor(config: MemoryManagerConfig = {}) {
    this.config = config
    this.memoryDir = getAutoMemPath(config.pathConfig)

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
    logger.info(`MemoryManager initialized, backend=${this.backend.type}, memories=${this.cachedMemories?.length ?? 0}`)
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

  setProvider(provider: LLMProvider, model?: string): void {
    setRetrievalProvider(provider, model)
  }

  async refreshCache(): Promise<void> {
    try {
      this.cachedMemories = await this.backend.list()
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

    const memoryTypesSection = `- **User** (user): User preferences, patterns, and personal context
- **Feedback** (feedback): Behavioral feedback and correction patterns
- **Project** (project): Project-specific knowledge and dynamics
- **Reference** (reference): External references and documentation pointers`

    const indexLines = memories.length === 0
      ? 'No memories stored yet.'
      : memories.map(m => `- [${m.type}] ${m.description}`).join('\n')

    return `# Auto Memory

You have a persistent memory system backed by **${this.backend.type}** storage.

## Types of Memory
${memoryTypesSection}

## What NOT to Save
- Information already in SGA.md, CLAUDE.md, or project documentation
- Temporary debugging state
- Sensitive credentials or secrets
- Verbatim file contents (reference the file path instead)

## How to Save Memories
Use the memory save API to create new memory entries with type, description, and content.

## Memory Index (Total: ${stats.totalMemories})
\`\`\`
${indexLines}
\`\`\``
  }

  async findRelevant(query: string, alreadySurfaced?: Set<string>): Promise<MemoryRetrievalResult> {
    const searchResults = await this.backend.search({
      query,
      limit: this.config.maxRelevant ?? MEMORY_MAX_RELEVANT,
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
        parts.push(`### [${memory.type}] ${memory.description}`)
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

  async saveMemoryFile(filename: string, type: string, description: string, content: string): Promise<void> {
    const now = new Date().toISOString()

    await this.backend.save({
      path: filename,
      type: type as MemoryFile['type'],
      description,
      content,
      frontmatter: {
        type: type as MemoryFile['type'],
        description,
        created_at: now,
        updated_at: now,
      },
    })

    logger.info(`Saved memory: ${filename} (type=${type}, backend=${this.backend.type})`)

    this.cachedMemories = null
    await this.ensureCache()

    if (this.isFileSystemBackend()) {
      await this.updateEntrypoint()
    }
  }

  async updateEntrypoint(): Promise<void> {
    if (!this.isFileSystemBackend()) return

    const memories = await this.ensureCache()
    const entrypointPath = getMemoryEntrypointPath(this.memoryDir)

    const lines: string[] = [
      '# Memory Index',
      '',
      `Last updated: ${new Date().toISOString()}`,
      '',
    ]

    if (memories.length === 0) {
      lines.push('No memories stored yet.')
    } else {
      lines.push(`Total memories: ${memories.length}`)
      lines.push('')
      for (const m of memories) {
        lines.push(`- [${m.type}] ${m.description} (\`${m.path}\`)`)
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
    const manifest = memories.map(m => `[${m.type}] ${m.description}`).join('\n')
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
