import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import type { MemoryFile, MemoryRetrievalResult } from './types.js'
import { MEMORY_MAX_FILES, MEMORY_MAX_RELEVANT, DEFAULT_MEMORY_EXTRACT_CONFIG } from './types.js'
import { getAutoMemPath, ensureMemoryDirExists, getMemoryEntrypointPath, type MemoryPathConfig } from './paths.js'
import { scanMemoryFiles, parseFrontmatter } from './scanner.js'
import { findRelevantMemories, DEFAULT_RETRIEVER_CONFIG, setRetrievalProvider } from './retrieval.js'
import { buildMemoryPrompt, buildExtractPrompt, truncateEntrypointContent } from './prompt.js'
import { createLogger } from '../utils/logger.js'
import type { LLMProvider } from '../providers/types.js'

const logger = createLogger('memory-manager')

export interface MemoryManagerConfig {
  pathConfig?: MemoryPathConfig
  maxRelevant?: number
  freshnessThresholdDays?: number
  extractConfig?: typeof DEFAULT_MEMORY_EXTRACT_CONFIG
}

export class MemoryManager {
  private memoryDir: string
  private config: MemoryManagerConfig
  private cachedMemories: MemoryFile[] | null = null
  private lastScanTime = 0
  private scanIntervalMs = 30_000

  constructor(config: MemoryManagerConfig = {}) {
    this.config = config
    this.memoryDir = getAutoMemPath(config.pathConfig)
  }

  async init(): Promise<void> {
    ensureMemoryDirExists(this.memoryDir)
    await this.refreshCache()
    logger.info(`MemoryManager initialized, dir=${this.memoryDir}, memories=${this.cachedMemories?.length ?? 0}`)
  }

  getMemoryDir(): string {
    return this.memoryDir
  }

  setProvider(provider: LLMProvider, model?: string): void {
    setRetrievalProvider(provider, model)
  }

  async refreshCache(): Promise<void> {
    try {
      this.cachedMemories = await scanMemoryFiles(this.memoryDir)
      this.lastScanTime = Date.now()
    } catch (error) {
      logger.warn(`Failed to scan memory files: ${error instanceof Error ? error.message : String(error)}`)
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
    const memories = await this.ensureCache()
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

  async findRelevant(query: string, alreadySurfaced?: Set<string>): Promise<MemoryRetrievalResult> {
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
    ensureMemoryDirExists(this.memoryDir)

    const frontmatter = [
      '---',
      `type: ${type}`,
      `description: "${description.replace(/"/g, '\\"')}"`,
      `created_at: ${new Date().toISOString()}`,
      `updated_at: ${new Date().toISOString()}`,
      '---',
      '',
    ].join('\n')

    const fullContent = frontmatter + content
    const filePath = join(this.memoryDir, filename.endsWith('.md') ? filename : `${filename}.md`)

    writeFileSync(filePath, fullContent, 'utf-8')
    logger.info(`Saved memory file: ${filePath}`)

    this.cachedMemories = null
    await this.ensureCache()

    await this.updateEntrypoint()
  }

  async updateEntrypoint(): Promise<void> {
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
