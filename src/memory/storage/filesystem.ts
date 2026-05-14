import { readdir, stat, readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { MemoryFile, MemoryFrontmatter, MemoryScope } from '../types.js'
import { MEMORY_MAX_FILES } from '../types.js'
import { parseFrontmatter } from '../scanner.js'
import { ensureMemoryDirExists } from '../paths.js'
import { createLogger } from '../../utils/logger.js'
import type {
  MemoryStorageBackend,
  StorageBackendType,
  StorageQueryOptions,
  StorageSearchOptions,
  StorageSearchResult,
  StorageStats,
  FileSystemBackendConfig,
} from './types.js'

const logger = createLogger('fs-backend')

export class FileSystemBackend implements MemoryStorageBackend {
  readonly type: StorageBackendType = 'filesystem'
  private memoryDir: string
  private scanIntervalMs: number
  private cachedMemories: MemoryFile[] | null = null
  private lastScanTime = 0

  constructor(config: FileSystemBackendConfig) {
    this.memoryDir = config.memoryDir
    this.scanIntervalMs = config.scanIntervalMs ?? 30_000
  }

  async initialize(): Promise<void> {
    ensureMemoryDirExists(this.memoryDir)
    await this.refreshCache()
    logger.info(`FileSystemBackend initialized, dir=${this.memoryDir}`)
  }

  async close(): Promise<void> {
    this.cachedMemories = null
  }

  getMemoryDir(): string {
    return this.memoryDir
  }

  async list(options?: StorageQueryOptions): Promise<MemoryFile[]> {
    const all = await this.ensureCache()
    let filtered = [...all]

    if (options?.scope) {
      filtered = this.filterByScope(filtered, options.scope, options.sessionId)
    }

    if (options?.sessionId) {
      filtered = filtered.filter(m =>
        m.frontmatter.sessionId === options.sessionId ||
        m.frontmatter.scope !== 'session'
      )
    }

    if (options?.types && options.types.length > 0) {
      filtered = filtered.filter(m => options.types!.includes(m.type))
    }

    if (options?.since) {
      filtered = filtered.filter(m => m.mtimeMs >= options.since!)
    }

    if (options?.until) {
      filtered = filtered.filter(m => m.mtimeMs <= options.until!)
    }

    if (options?.tags && options.tags.length > 0) {
      filtered = filtered.filter(m =>
        m.frontmatter.tags?.some(t => options.tags!.includes(t)),
      )
    }

    if (options?.offset) {
      filtered = filtered.slice(options.offset)
    }

    if (options?.limit) {
      filtered = filtered.slice(0, options.limit)
    }

    return filtered
  }

  async get(id: string): Promise<MemoryFile | null> {
    const all = await this.ensureCache()
    return all.find(m => m.path === id || this.pathToId(m.path) === id) ?? null
  }

  async save(memory: Omit<MemoryFile, 'mtimeMs' | 'sizeBytes'> & { mtimeMs?: number; sizeBytes?: number }): Promise<MemoryFile> {
    ensureMemoryDirExists(this.memoryDir)

    const filename = memory.path.endsWith('.md') ? memory.path : `${memory.path}.md`
    const filePath = join(this.memoryDir, filename)

    const fullContent = this.serializeWithFrontmatter(memory)
    await writeFile(filePath, fullContent, 'utf-8')

    const fileStat = await stat(filePath)
    const result: MemoryFile = {
      ...memory,
      path: filePath,
      mtimeMs: memory.mtimeMs ?? fileStat.mtimeMs,
      sizeBytes: memory.sizeBytes ?? fileStat.size,
    }

    this.cachedMemories = null
    logger.debug(`Saved memory file: ${filePath}`)
    return result
  }

  async update(id: string, updates: Partial<Pick<MemoryFile, 'content' | 'frontmatter' | 'type' | 'description'>>): Promise<MemoryFile | null> {
    const existing = await this.get(id)
    if (!existing) return null

    const updated: MemoryFile = {
      ...existing,
      ...updates,
      frontmatter: {
        ...existing.frontmatter,
        ...(updates.frontmatter ?? {}),
        ...(updates.type ? { type: updates.type } : {}),
        ...(updates.description ? { description: updates.description } : {}),
        updated_at: new Date().toISOString(),
      },
    }

    return this.save(updated)
  }

  async delete(id: string): Promise<boolean> {
    const memory = await this.get(id)
    if (!memory) return false

    try {
      await unlink(memory.path)
      this.cachedMemories = null
      logger.debug(`Deleted memory file: ${memory.path}`)
      return true
    } catch {
      return false
    }
  }

  async search(options: StorageSearchOptions): Promise<StorageSearchResult[]> {
    let all = await this.ensureCache()

    if (options.scope) {
      all = this.filterByScope(all, options.scope, options.sessionId)
    }

    if (options.sessionId) {
      all = all.filter(m =>
        m.frontmatter.sessionId === options.sessionId ||
        m.frontmatter.scope !== 'session'
      )
    }

    const queryLower = options.query.toLowerCase()
    const queryTerms = queryLower.split(/\s+/).filter(t => t.length >= 2)
    const limit = options.limit ?? 10

    const scored = all.map(memory => ({
      memory,
      score: this.computeRelevanceScore(queryTerms, queryLower, memory),
    }))

    scored.sort((a, b) => b.score - a.score)

    const threshold = options.threshold ?? 0
    return scored
      .filter(s => s.score > threshold)
      .slice(0, limit)
      .map(s => ({ memory: s.memory, score: s.score }))
  }

  async getStats(): Promise<StorageStats> {
    const all = await this.ensureCache()
    const byType: Record<string, number> = {}
    const byScope: Record<string, number> = {}
    let totalSize = 0
    let oldest: number | null = null
    let newest: number | null = null

    for (const m of all) {
      byType[m.type] = (byType[m.type] ?? 0) + 1
      const scope = m.frontmatter.scope ?? 'project'
      byScope[scope] = (byScope[scope] ?? 0) + 1
      totalSize += m.sizeBytes
      if (oldest === null || m.mtimeMs < oldest) oldest = m.mtimeMs
      if (newest === null || m.mtimeMs > newest) newest = m.mtimeMs
    }

    return {
      totalMemories: all.length,
      totalSizeBytes: totalSize,
      byType,
      byScope,
      oldestAt: oldest,
      newestAt: newest,
    }
  }

  async exists(id: string): Promise<boolean> {
    const memory = await this.get(id)
    return memory !== null
  }

  async count(options?: StorageQueryOptions): Promise<number> {
    const filtered = await this.list(options)
    return filtered.length
  }

  async clear(): Promise<void> {
    const all = await this.ensureCache()
    for (const m of all) {
      try {
        await unlink(m.path)
      } catch {
        continue
      }
    }
    this.cachedMemories = null
    logger.info(`Cleared all memory files in ${this.memoryDir}`)
  }

  async refreshCache(): Promise<void> {
    try {
      this.cachedMemories = await this.scanMemoryFiles()
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

  private filterByScope(memories: MemoryFile[], scope: MemoryScope, sessionId?: string): MemoryFile[] {
    if (scope === 'global') {
      return memories.filter(m => m.frontmatter.scope === 'global' || (!m.frontmatter.scope && m.type === 'user'))
    }

    if (scope === 'project') {
      return memories.filter(m => {
        const mScope = m.frontmatter.scope
        if (!mScope) return m.type !== 'session'
        return mScope === 'global' || mScope === 'project'
      })
    }

    if (scope === 'session') {
      return memories.filter(m => {
        const mScope = m.frontmatter.scope
        if (!mScope) return true
        if (mScope === 'global' || mScope === 'project') return true
        if (mScope === 'session') return m.frontmatter.sessionId === sessionId
        return false
      })
    }

    return memories
  }

  private async scanMemoryFiles(): Promise<MemoryFile[]> {
    const files: MemoryFile[] = []
    await this.scanDir(this.memoryDir, files)
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return files.slice(0, MEMORY_MAX_FILES)
  }

  private async scanDir(dir: string, results: MemoryFile[]): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.scanDir(fullPath, results)
      } else if (entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') {
        try {
          const fileStat = await stat(fullPath)
          const content = await readFile(fullPath, 'utf-8')
          const frontmatter = parseFrontmatter(content)
          const description = frontmatter.description ?? this.extractFirstHeading(content) ?? entry.name

          results.push({
            path: fullPath,
            type: frontmatter.type ?? 'project',
            description,
            content,
            frontmatter,
            mtimeMs: fileStat.mtimeMs,
            sizeBytes: fileStat.size,
          })
        } catch {
          continue
        }
      }
    }
  }

  private extractFirstHeading(content: string): string | null {
    const match = content.match(/^#\s+(.+)$/m)
    return match ? match[1].trim() : null
  }

  private serializeWithFrontmatter(memory: Omit<MemoryFile, 'mtimeMs' | 'sizeBytes'> & { mtimeMs?: number; sizeBytes?: number }): string {
    const fm = memory.frontmatter
    const type = memory.type ?? fm.type ?? 'project'
    const description = memory.description ?? fm.description ?? ''
    const now = new Date().toISOString()

    const frontmatterLines = [
      '---',
      `type: ${type}`,
      `description: "${description.replace(/"/g, '\\"')}"`,
    ]

    if (fm.scope) {
      frontmatterLines.push(`scope: ${fm.scope}`)
    }

    if (fm.sessionId) {
      frontmatterLines.push(`sessionId: ${fm.sessionId}`)
    }

    frontmatterLines.push(
      `created_at: ${fm.created_at ?? now}`,
      `updated_at: ${now}`,
    )

    if (fm.tags && fm.tags.length > 0) {
      frontmatterLines.push(`tags: ${fm.tags.join(', ')}`)
    }

    frontmatterLines.push('---', '')

    const bodyStart = memory.content.indexOf('---', memory.content.indexOf('---') + 1)
    const body = bodyStart >= 0
      ? memory.content.slice(bodyStart + 3).trim()
      : memory.content.trim()

    return frontmatterLines.join('\n') + '\n' + body
  }

  private pathToId(filePath: string): string {
    const idx = filePath.lastIndexOf('/') > filePath.lastIndexOf('\\')
      ? filePath.lastIndexOf('/')
      : filePath.lastIndexOf('\\')
    const filename = idx >= 0 ? filePath.slice(idx + 1) : filePath
    return filename.replace(/\.md$/, '')
  }

  private computeRelevanceScore(queryTerms: string[], queryLower: string, memory: MemoryFile): number {
    const descLower = memory.description.toLowerCase()
    const contentLower = memory.content.toLowerCase()
    let score = 0

    for (const term of queryTerms) {
      if (descLower.includes(term)) score += 3
      if (contentLower.includes(term)) score += 1
    }

    if (queryLower.includes(descLower) || descLower.includes(queryLower)) score += 5

    const ageDays = (Date.now() - memory.mtimeMs) / (1000 * 60 * 60 * 24)
    if (ageDays <= 1) score += 2
    else if (ageDays <= 7) score += 1

    if (memory.frontmatter.scope === 'session') score += 1

    return score
  }
}
