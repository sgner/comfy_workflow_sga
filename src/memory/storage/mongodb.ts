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
  MongoDBBackendConfig,
} from './types.js'

const logger = createLogger('mongodb-backend')

interface MongoDocument {
  _id?: string
  id: string
  type: string
  description: string
  content: string
  tags: string[]
  createdAt: string
  updatedAt: string
  metadata: Record<string, unknown>
}

interface MongoCursor {
  sort(s: Record<string, unknown>): MongoCursor
  skip(n: number): MongoCursor
  limit(n: number): MongoCursor
  toArray(): Promise<unknown[]>
}

interface MongoCollection {
  findOne(filter: Record<string, unknown>): Promise<unknown>
  find(filter: Record<string, unknown>): MongoCursor
  insertOne(doc: Record<string, unknown>): Promise<unknown>
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>
  deleteOne(filter: Record<string, unknown>): Promise<unknown>
  countDocuments(filter?: Record<string, unknown>): Promise<number>
  drop(): Promise<unknown>
}

export class MongoDBBackend implements MemoryStorageBackend {
  readonly type: StorageBackendType = 'mongodb'
  private config: MongoDBBackendConfig
  private documents: Map<string, MongoDocument> = new Map()
  private initialized = false
  private collection: MongoCollection | null = null

  constructor(config: MongoDBBackendConfig) {
    this.config = config
  }

  setCollection(collection: MongoCollection): void {
    this.collection = collection
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    if (this.collection) {
      logger.info(`MongoDBBackend initialized with collection: ${this.config.collectionName ?? 'memories'}`)
    } else if (this.config.connectionString) {
      logger.info(`MongoDBBackend configured for: ${this.config.connectionString}`)
    } else {
      logger.info('MongoDBBackend initialized with in-memory store')
    }

    this.initialized = true
  }

  async close(): Promise<void> {
    this.documents.clear()
    this.initialized = false
  }

  async list(options?: StorageQueryOptions): Promise<MemoryFile[]> {
    if (this.collection) {
      return this.listFromCollection(options)
    }
    return this.listFromMemory(options)
  }

  async get(id: string): Promise<MemoryFile | null> {
    if (this.collection) {
      const doc = await this.collection.findOne({ id }) as MongoDocument | null
      return doc ? this.docToMemory(doc) : null
    }

    const doc = this.documents.get(id)
    return doc ? this.docToMemory(doc) : null
  }

  async save(memory: Omit<MemoryFile, 'mtimeMs' | 'sizeBytes'> & { mtimeMs?: number; sizeBytes?: number }): Promise<MemoryFile> {
    const id = memory.path || randomUUID()
    const now = new Date().toISOString()

    const doc: MongoDocument = {
      id,
      type: memory.type,
      description: memory.description,
      content: memory.content,
      tags: memory.frontmatter.tags ?? [],
      createdAt: memory.frontmatter.created_at ?? now,
      updatedAt: now,
      metadata: {},
    }

    for (const [k, v] of Object.entries(memory.frontmatter)) {
      if (!['type', 'description', 'tags', 'created_at', 'updated_at'].includes(k)) {
        doc.metadata[k] = v
      }
    }

    if (this.collection) {
      await this.collection.updateOne(
        { id },
        { $set: doc },
      )
    } else {
      this.documents.set(id, doc)
    }

    return this.docToMemory(doc)
  }

  async update(id: string, updates: Partial<Pick<MemoryFile, 'content' | 'frontmatter' | 'type' | 'description'>>): Promise<MemoryFile | null> {
    const existing = await this.get(id)
    if (!existing) return null

    const now = new Date().toISOString()
    const setFields: Record<string, unknown> = { updatedAt: now }

    if (updates.content !== undefined) setFields.content = updates.content
    if (updates.type !== undefined) setFields.type = updates.type
    if (updates.description !== undefined) setFields.description = updates.description
    if (updates.frontmatter?.tags) setFields.tags = updates.frontmatter.tags

    if (this.collection) {
      await this.collection.updateOne({ id }, { $set: setFields })
    } else {
      const doc = this.documents.get(id)
      if (!doc) return null

      if (updates.content !== undefined) doc.content = updates.content
      if (updates.type !== undefined) doc.type = updates.type
      if (updates.description !== undefined) doc.description = updates.description
      if (updates.frontmatter?.tags) doc.tags = updates.frontmatter.tags
      doc.updatedAt = now
    }

    return this.get(id)
  }

  async delete(id: string): Promise<boolean> {
    if (this.collection) {
      await this.collection.deleteOne({ id })
      return true
    }

    return this.documents.delete(id)
  }

  async search(options: StorageSearchOptions): Promise<StorageSearchResult[]> {
    const limit = options.limit ?? 10
    const threshold = options.threshold ?? 0

    if (this.collection) {
      return this.mongoSearch(options.query, limit)
    }

    const all = await this.list()
    return this.keywordSearch(all, options.query, limit, threshold)
  }

  async getStats(): Promise<StorageStats> {
    const all = await this.list()
    const byType: Record<string, number> = {}
    let oldest: number | null = null
    let newest: number | null = null

    for (const m of all) {
      byType[m.type] = (byType[m.type] ?? 0) + 1
      if (oldest === null || m.mtimeMs < oldest) oldest = m.mtimeMs
      if (newest === null || m.mtimeMs > newest) newest = m.mtimeMs
    }

    return {
      totalMemories: all.length,
      totalSizeBytes: all.reduce((sum, m) => sum + m.sizeBytes, 0),
      byType,
      oldestAt: oldest,
      newestAt: newest,
    }
  }

  async exists(id: string): Promise<boolean> {
    if (this.collection) {
      const doc = await this.collection.findOne({ id }) as MongoDocument | null
      return doc !== null
    }
    return this.documents.has(id)
  }

  async count(options?: StorageQueryOptions): Promise<number> {
    if (this.collection) {
      const filter = this.buildFilter(options)
      return this.collection.countDocuments(filter)
    }

    const list = await this.list(options)
    return list.length
  }

  async clear(): Promise<void> {
    if (this.collection) {
      await this.collection.drop()
    } else {
      this.documents.clear()
    }
    logger.info('Cleared all MongoDB store documents')
  }

  private buildFilter(options?: StorageQueryOptions): Record<string, unknown> {
    const filter: Record<string, unknown> = {}

    if (options?.types && options.types.length > 0) {
      filter.type = { $in: options.types }
    }

    if (options?.since || options?.until) {
      const updatedAt: Record<string, unknown> = {}
      if (options.since) updatedAt.$gte = new Date(options.since).toISOString()
      if (options.until) updatedAt.$lte = new Date(options.until).toISOString()
      filter.updatedAt = updatedAt
    }

    if (options?.tags && options.tags.length > 0) {
      filter.tags = { $in: options.tags }
    }

    return filter
  }

  private async listFromCollection(options?: StorageQueryOptions): Promise<MemoryFile[]> {
    const filter = this.buildFilter(options)

    let cursor = this.collection!.find(filter).sort({ updatedAt: -1 })
    if (options?.offset) cursor = cursor.skip(options.offset)
    if (options?.limit) cursor = cursor.limit(options.limit)

    const docs = await cursor.toArray() as MongoDocument[]
    return docs.map(d => this.docToMemory(d))
  }

  private listFromMemory(options?: StorageQueryOptions): MemoryFile[] {
    let docs = [...this.documents.values()]

    if (options?.types && options.types.length > 0) {
      docs = docs.filter(d => options.types!.includes(d.type as MemoryFile['type']))
    }

    if (options?.tags && options.tags.length > 0) {
      docs = docs.filter(d => d.tags?.some(t => options.tags!.includes(t)))
    }

    docs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

    if (options?.offset) docs = docs.slice(options.offset)
    if (options?.limit) docs = docs.slice(0, options.limit)

    return docs.map(d => this.docToMemory(d))
  }

  private async mongoSearch(query: string, limit: number): Promise<StorageSearchResult[]> {
    try {
      const docs = await this.collection!.find({
        $text: { $search: query },
      }).sort({ score: { $meta: 'textScore' } }).limit(limit).toArray() as (MongoDocument & { score?: number })[]

      return docs.map(d => ({
        memory: this.docToMemory(d),
        score: d.score ?? 0,
      }))
    } catch {
      const all = await this.list()
      return this.keywordSearch(all, query, limit, 0)
    }
  }

  private keywordSearch(all: MemoryFile[], query: string, limit: number, threshold: number): StorageSearchResult[] {
    const queryLower = query.toLowerCase()
    const queryTerms = queryLower.split(/\s+/).filter(t => t.length >= 2)
    const results: StorageSearchResult[] = []

    for (const memory of all) {
      const descLower = memory.description.toLowerCase()
      const contentLower = memory.content.toLowerCase()
      let score = 0

      for (const term of queryTerms) {
        if (descLower.includes(term)) score += 3
        if (contentLower.includes(term)) score += 1
      }

      if (score > 0) {
        const normalizedScore = Math.min(score / 10, 1.0)
        if (normalizedScore >= threshold) {
          results.push({ memory, score: normalizedScore })
        }
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  private docToMemory(doc: MongoDocument): MemoryFile {
    return {
      path: doc.id,
      type: doc.type as MemoryFile['type'],
      description: doc.description,
      content: doc.content,
      frontmatter: {
        type: doc.type as MemoryFile['type'],
        description: doc.description,
        tags: doc.tags,
        created_at: doc.createdAt,
        updated_at: doc.updatedAt,
        ...doc.metadata,
      },
      mtimeMs: new Date(doc.updatedAt).getTime(),
      sizeBytes: Buffer.byteLength(doc.content, 'utf-8'),
    }
  }
}
