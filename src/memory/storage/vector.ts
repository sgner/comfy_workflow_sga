import { randomUUID } from 'crypto'
import type { MemoryFile } from '../types.js'
import { createLogger } from '../../utils/logger.js'
import type {
  MemoryStorageBackend,
  StorageBackendType,
  StorageQueryOptions,
  StorageSearchOptions,
  StorageSearchResult,
  StorageStats,
  VectorBackendConfig,
} from './types.js'

const logger = createLogger('vector-backend')

interface VectorDocument {
  id: string
  content: string
  embedding: number[]
  metadata: {
    type: string
    description: string
    tags: string[]
    createdAt: string
    updatedAt: string
    [key: string]: unknown
  }
}

export class VectorBackend implements MemoryStorageBackend {
  readonly type: StorageBackendType = 'vector'
  private config: VectorBackendConfig
  private documents: Map<string, VectorDocument> = new Map()
  private embeddingFn: ((text: string) => Promise<number[]>) | null = null
  private initialized = false

  constructor(config: VectorBackendConfig) {
    this.config = config
  }

  setEmbeddingFunction(fn: (text: string) => Promise<number[]>): void {
    this.embeddingFn = fn
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    if (this.config.connectionString) {
      logger.info(`VectorBackend initialized with external store: ${this.config.connectionString}`)
    } else {
      logger.info('VectorBackend initialized with in-memory store')
    }

    this.initialized = true
  }

  async close(): Promise<void> {
    this.documents.clear()
    this.initialized = false
  }

  async list(options?: StorageQueryOptions): Promise<MemoryFile[]> {
    let docs = [...this.documents.values()]

    if (options?.types && options.types.length > 0) {
      docs = docs.filter(d => options.types!.includes(d.metadata.type as MemoryFile['type']))
    }

    if (options?.tags && options.tags.length > 0) {
      docs = docs.filter(d =>
        d.metadata.tags?.some(t => options.tags!.includes(t)),
      )
    }

    if (options?.since) {
      docs = docs.filter(d => new Date(d.metadata.updatedAt).getTime() >= options.since!)
    }

    if (options?.until) {
      docs = docs.filter(d => new Date(d.metadata.updatedAt).getTime() <= options.until!)
    }

    docs.sort((a, b) => new Date(b.metadata.updatedAt).getTime() - new Date(a.metadata.updatedAt).getTime())

    if (options?.offset) {
      docs = docs.slice(options.offset)
    }
    if (options?.limit) {
      docs = docs.slice(0, options.limit)
    }

    return docs.map(d => this.docToMemory(d))
  }

  async get(id: string): Promise<MemoryFile | null> {
    const doc = this.documents.get(id)
    return doc ? this.docToMemory(doc) : null
  }

  async save(memory: Omit<MemoryFile, 'mtimeMs' | 'sizeBytes'> & { mtimeMs?: number; sizeBytes?: number }): Promise<MemoryFile> {
    const id = this.resolveId(memory.path)
    const now = new Date().toISOString()

    let embedding: number[] = []
    if (this.embeddingFn) {
      try {
        const textToEmbed = `${memory.description} ${memory.content}`.slice(0, 2000)
        embedding = await this.embeddingFn(textToEmbed)
      } catch (error) {
        logger.warn(`Failed to generate embedding for ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const doc: VectorDocument = {
      id,
      content: memory.content,
      embedding,
      metadata: {
        type: memory.type,
        description: memory.description,
        tags: memory.frontmatter.tags ?? [],
        createdAt: memory.frontmatter.created_at ?? now,
        updatedAt: memory.frontmatter.updated_at ?? now,
      },
    }

    this.documents.set(id, doc)
    return this.docToMemory(doc)
  }

  async update(id: string, updates: Partial<Pick<MemoryFile, 'content' | 'frontmatter' | 'type' | 'description'>>): Promise<MemoryFile | null> {
    const existing = this.documents.get(id)
    if (!existing) return null

    const now = new Date().toISOString()

    if (updates.content !== undefined) {
      existing.content = updates.content
      if (this.embeddingFn) {
        try {
          const textToEmbed = `${existing.metadata.description} ${updates.content}`.slice(0, 2000)
          existing.embedding = await this.embeddingFn(textToEmbed)
        } catch {
          // keep old embedding
        }
      }
    }

    if (updates.type !== undefined) existing.metadata.type = updates.type
    if (updates.description !== undefined) existing.metadata.description = updates.description
    if (updates.frontmatter?.tags) existing.metadata.tags = updates.frontmatter.tags
    existing.metadata.updatedAt = now

    return this.docToMemory(existing)
  }

  async delete(id: string): Promise<boolean> {
    return this.documents.delete(id)
  }

  async search(options: StorageSearchOptions): Promise<StorageSearchResult[]> {
    const limit = options.limit ?? 10
    const threshold = options.threshold ?? 0.5

    if (options.useSemantic !== false && this.embeddingFn) {
      try {
        const queryEmbedding = await this.embeddingFn(options.query)
        return this.cosineSearch(queryEmbedding, limit, threshold)
      } catch (error) {
        logger.warn(`Semantic search failed, falling back to keyword: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return this.keywordSearch(options.query, limit, threshold)
  }

  async getStats(): Promise<StorageStats> {
    const docs = [...this.documents.values()]
    const byType: Record<string, number> = {}
    let oldest: number | null = null
    let newest: number | null = null

    for (const d of docs) {
      byType[d.metadata.type] = (byType[d.metadata.type] ?? 0) + 1
      const ts = new Date(d.metadata.updatedAt).getTime()
      if (oldest === null || ts < oldest) oldest = ts
      if (newest === null || ts > newest) newest = ts
    }

    return {
      totalMemories: docs.length,
      totalSizeBytes: docs.reduce((sum, d) => sum + Buffer.byteLength(d.content, 'utf-8'), 0),
      byType,
      oldestAt: oldest,
      newestAt: newest,
    }
  }

  async exists(id: string): Promise<boolean> {
    return this.documents.has(id)
  }

  async count(options?: StorageQueryOptions): Promise<number> {
    const list = await this.list(options)
    return list.length
  }

  async clear(): Promise<void> {
    this.documents.clear()
    logger.info('Cleared all vector store documents')
  }

  private cosineSearch(queryEmbedding: number[], limit: number, threshold: number): StorageSearchResult[] {
    const results: StorageSearchResult[] = []

    for (const doc of this.documents.values()) {
      if (doc.embedding.length === 0) continue
      const score = cosineSimilarity(queryEmbedding, doc.embedding)
      if (score >= threshold) {
        results.push({ memory: this.docToMemory(doc), score })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  private keywordSearch(query: string, limit: number, threshold: number): StorageSearchResult[] {
    const queryLower = query.toLowerCase()
    const queryTerms = queryLower.split(/\s+/).filter(t => t.length >= 2)
    const results: StorageSearchResult[] = []

    for (const doc of this.documents.values()) {
      const descLower = doc.metadata.description.toLowerCase()
      const contentLower = doc.content.toLowerCase()
      let score = 0

      for (const term of queryTerms) {
        if (descLower.includes(term)) score += 3
        if (contentLower.includes(term)) score += 1
      }

      if (score > 0) {
        const normalizedScore = Math.min(score / 10, 1.0)
        if (normalizedScore >= threshold) {
          results.push({ memory: this.docToMemory(doc), score: normalizedScore })
        }
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  private docToMemory(doc: VectorDocument): MemoryFile {
    const updatedAt = new Date(doc.metadata.updatedAt).getTime()
    return {
      path: doc.id,
      type: doc.metadata.type as MemoryFile['type'],
      description: doc.metadata.description,
      content: doc.content,
      frontmatter: {
        type: doc.metadata.type as MemoryFile['type'],
        description: doc.metadata.description,
        tags: doc.metadata.tags,
        created_at: doc.metadata.createdAt,
        updated_at: doc.metadata.updatedAt,
      },
      mtimeMs: updatedAt,
      sizeBytes: Buffer.byteLength(doc.content, 'utf-8'),
    }
  }

  private resolveId(path: string): string {
    if (path.includes('/') || path.includes('\\')) {
      const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      return path.slice(idx + 1).replace(/\.md$/, '') || randomUUID()
    }
    return path.replace(/\.md$/, '') || randomUUID()
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dotProduct / denominator
}
