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
  SQLBackendConfig,
} from './types.js'

const logger = createLogger('sql-backend')

interface SQLRow {
  id: string
  type: string
  description: string
  content: string
  tags: string
  created_at: string
  updated_at: string
  metadata: string
}

export class SQLBackend implements MemoryStorageBackend {
  readonly type: StorageBackendType = 'sql'
  private config: SQLBackendConfig
  private rows: Map<string, SQLRow> = new Map()
  private initialized = false
  private queryFn: ((sql: string, params?: unknown[]) => Promise<SQLRow[]>) | null = null
  private executeFn: ((sql: string, params?: unknown[]) => Promise<void>) | null = null

  constructor(config: SQLBackendConfig) {
    this.config = config
  }

  setQueryFunction(fn: (sql: string, params?: unknown[]) => Promise<SQLRow[]>): void {
    this.queryFn = fn
  }

  setExecuteFunction(fn: (sql: string, params?: unknown[]) => Promise<void>): void {
    this.executeFn = fn
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    const tableName = this.config.tableName ?? 'memories'

    if (this.executeFn) {
      const dialect = this.config.dialect ?? 'postgres'
      const autoInc = dialect === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'SERIAL PRIMARY KEY'

      await this.executeFn(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id VARCHAR(255) ${autoInc === 'SERIAL PRIMARY KEY' ? 'PRIMARY KEY' : 'UNIQUE NOT NULL'},
          type VARCHAR(50) NOT NULL DEFAULT 'project',
          description TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          tags TEXT DEFAULT '[]',
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          metadata TEXT DEFAULT '{}'
        )
      `)

      logger.info(`SQLBackend initialized with table: ${tableName}, dialect: ${dialect}`)
    } else {
      logger.info('SQLBackend initialized with in-memory store (no query function set)')
    }

    this.initialized = true
  }

  async close(): Promise<void> {
    this.rows.clear()
    this.initialized = false
  }

  async list(options?: StorageQueryOptions): Promise<MemoryFile[]> {
    if (this.queryFn) {
      return this.listFromDB(options)
    }
    return this.listFromMemory(options)
  }

  async get(id: string): Promise<MemoryFile | null> {
    if (this.queryFn) {
      const tableName = this.config.tableName ?? 'memories'
      const rows = await this.queryFn(`SELECT * FROM ${tableName} WHERE id = $1`, [id])
      return rows.length > 0 ? this.rowToMemory(rows[0]) : null
    }

    const row = this.rows.get(id)
    return row ? this.rowToMemory(row) : null
  }

  async save(memory: Omit<MemoryFile, 'mtimeMs' | 'sizeBytes'> & { mtimeMs?: number; sizeBytes?: number }): Promise<MemoryFile> {
    const id = memory.path || randomUUID()
    const now = new Date().toISOString()
    const tags = memory.frontmatter.tags ?? []
    const metadata: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(memory.frontmatter)) {
      if (!['type', 'description', 'tags', 'created_at', 'updated_at'].includes(k)) {
        metadata[k] = v
      }
    }

    if (this.executeFn) {
      const tableName = this.config.tableName ?? 'memories'
      await this.executeFn(
        `INSERT INTO ${tableName} (id, type, description, content, tags, created_at, updated_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           type = EXCLUDED.type,
           description = EXCLUDED.description,
           content = EXCLUDED.content,
           tags = EXCLUDED.tags,
           updated_at = EXCLUDED.updated_at,
           metadata = EXCLUDED.metadata`,
        [id, memory.type, memory.description, memory.content, JSON.stringify(tags), memory.frontmatter.created_at ?? now, now, JSON.stringify(metadata)],
      )
    } else {
      this.rows.set(id, {
        id,
        type: memory.type,
        description: memory.description,
        content: memory.content,
        tags: JSON.stringify(tags),
        created_at: memory.frontmatter.created_at ?? now,
        updated_at: now,
        metadata: JSON.stringify(metadata),
      })
    }

    return {
      ...memory,
      path: id,
      mtimeMs: new Date(now).getTime(),
      sizeBytes: Buffer.byteLength(memory.content, 'utf-8'),
    }
  }

  async update(id: string, updates: Partial<Pick<MemoryFile, 'content' | 'frontmatter' | 'type' | 'description'>>): Promise<MemoryFile | null> {
    const existing = await this.get(id)
    if (!existing) return null

    const now = new Date().toISOString()

    if (this.executeFn) {
      const tableName = this.config.tableName ?? 'memories'
      const setClauses: string[] = []
      const params: unknown[] = []
      let paramIdx = 1

      if (updates.content !== undefined) {
        setClauses.push(`content = $${paramIdx++}`)
        params.push(updates.content)
      }
      if (updates.type !== undefined) {
        setClauses.push(`type = $${paramIdx++}`)
        params.push(updates.type)
      }
      if (updates.description !== undefined) {
        setClauses.push(`description = $${paramIdx++}`)
        params.push(updates.description)
      }
      if (updates.frontmatter?.tags) {
        setClauses.push(`tags = $${paramIdx++}`)
        params.push(JSON.stringify(updates.frontmatter.tags))
      }

      setClauses.push(`updated_at = $${paramIdx++}`)
      params.push(now)
      params.push(id)

      await this.executeFn(
        `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
        params,
      )
    } else {
      const row = this.rows.get(id)
      if (!row) return null

      if (updates.content !== undefined) row.content = updates.content
      if (updates.type !== undefined) row.type = updates.type
      if (updates.description !== undefined) row.description = updates.description
      if (updates.frontmatter?.tags) row.tags = JSON.stringify(updates.frontmatter.tags)
      row.updated_at = now
    }

    return this.get(id)
  }

  async delete(id: string): Promise<boolean> {
    if (this.executeFn) {
      const tableName = this.config.tableName ?? 'memories'
      await this.executeFn(`DELETE FROM ${tableName} WHERE id = $1`, [id])
      return true
    }

    return this.rows.delete(id)
  }

  async search(options: StorageSearchOptions): Promise<StorageSearchResult[]> {
    const limit = options.limit ?? 10
    const threshold = options.threshold ?? 0

    if (this.queryFn && options.useSemantic !== true) {
      return this.sqlSearch(options.query, limit)
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
    if (this.queryFn) {
      const tableName = this.config.tableName ?? 'memories'
      const rows = await this.queryFn(`SELECT id FROM ${tableName} WHERE id = $1`, [id])
      return rows.length > 0
    }
    return this.rows.has(id)
  }

  async count(options?: StorageQueryOptions): Promise<number> {
    if (this.queryFn) {
      const tableName = this.config.tableName ?? 'memories'
      let sql = `SELECT COUNT(*) as cnt FROM ${tableName}`
      const conditions: string[] = []
      const params: unknown[] = []
      let idx = 1

      if (options?.types && options.types.length > 0) {
        conditions.push(`type IN (${options.types.map(() => `$${idx++}`).join(', ')})`)
        params.push(...options.types)
      }

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`
      }

      const rows = await this.queryFn(sql, params)
      return Number((rows[0] as unknown as Record<string, unknown>)?.cnt ?? 0)
    }

    const list = await this.list(options)
    return list.length
  }

  async clear(): Promise<void> {
    if (this.executeFn) {
      const tableName = this.config.tableName ?? 'memories'
      await this.executeFn(`DELETE FROM ${tableName}`)
    } else {
      this.rows.clear()
    }
    logger.info('Cleared all SQL store records')
  }

  private async listFromDB(options?: StorageQueryOptions): Promise<MemoryFile[]> {
    const tableName = this.config.tableName ?? 'memories'
    const conditions: string[] = []
    const params: unknown[] = []
    let idx = 1

    if (options?.types && options.types.length > 0) {
      conditions.push(`type IN (${options.types.map(() => `$${idx++}`).join(', ')})`)
      params.push(...options.types)
    }

    if (options?.since) {
      conditions.push(`updated_at >= $${idx++}`)
      params.push(new Date(options.since).toISOString())
    }

    if (options?.until) {
      conditions.push(`updated_at <= $${idx++}`)
      params.push(new Date(options.until).toISOString())
    }

    let sql = `SELECT * FROM ${tableName}`
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`
    sql += ' ORDER BY updated_at DESC'

    if (options?.limit) sql += ` LIMIT $${idx++}`, params.push(options.limit)
    if (options?.offset) sql += ` OFFSET $${idx++}`, params.push(options.offset)

    const rows = await this.queryFn!(sql, params)
    return rows.map(r => this.rowToMemory(r))
  }

  private listFromMemory(options?: StorageQueryOptions): MemoryFile[] {
    let rows = [...this.rows.values()]

    if (options?.types && options.types.length > 0) {
      rows = rows.filter(r => options.types!.includes(r.type as MemoryFile['type']))
    }

    rows.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())

    if (options?.offset) rows = rows.slice(options.offset)
    if (options?.limit) rows = rows.slice(0, options.limit)

    return rows.map(r => this.rowToMemory(r))
  }

  private async sqlSearch(query: string, limit: number): Promise<StorageSearchResult[]> {
    const tableName = this.config.tableName ?? 'memories'
    const dialect = this.config.dialect ?? 'postgres'

    let searchExpr: string
    if (dialect === 'postgres') {
      searchExpr = `to_tsvector('english', description || ' ' || content) @@ to_tsquery('english', $1)`
    } else if (dialect === 'mysql') {
      searchExpr = `MATCH(description, content) AGAINST($1 IN NATURAL LANGUAGE MODE)`
    } else {
      searchExpr = `(description LIKE '%' || $1 || '%' OR content LIKE '%' || $1 || '%')`
    }

    const rows = await this.queryFn!(
      `SELECT *, CASE WHEN description LIKE '%' || $1 || '%' THEN 3 ELSE 0 END +
       CASE WHEN content LIKE '%' || $1 || '%' THEN 1 ELSE 0 END AS score
       FROM ${tableName} WHERE ${searchExpr} ORDER BY score DESC LIMIT $2`,
      [query, limit],
    )

    return rows.map(r => ({
      memory: this.rowToMemory(r),
      score: Number((r as unknown as Record<string, unknown>).score ?? 0),
    }))
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

  private rowToMemory(row: SQLRow): MemoryFile {
    let tags: string[] = []
    try {
      tags = JSON.parse(row.tags)
    } catch { /* ignore */ }

    let metadata: Record<string, unknown> = {}
    try {
      metadata = JSON.parse(row.metadata)
    } catch { /* ignore */ }

    return {
      path: row.id,
      type: row.type as MemoryFile['type'],
      description: row.description,
      content: row.content,
      frontmatter: {
        type: row.type as MemoryFile['type'],
        description: row.description,
        tags,
        created_at: row.created_at,
        updated_at: row.updated_at,
        ...metadata,
      },
      mtimeMs: new Date(row.updated_at).getTime(),
      sizeBytes: Buffer.byteLength(row.content, 'utf-8'),
    }
  }
}
