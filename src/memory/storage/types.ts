import type { MemoryFile, MemoryFrontmatter, MemoryType } from '../types.js'

export type StorageBackendType = 'filesystem' | 'vector' | 'sql' | 'mongodb' | 'custom'

export interface StorageQueryOptions {
  limit?: number
  offset?: number
  types?: MemoryType[]
  tags?: string[]
  since?: number
  until?: number
}

export interface StorageSearchOptions {
  query: string
  limit?: number
  threshold?: number
  useSemantic?: boolean
}

export interface StorageSearchResult {
  memory: MemoryFile
  score: number
}

export interface StorageBackendConfig {
  type: StorageBackendType
  [key: string]: unknown
}

export interface FileSystemBackendConfig extends StorageBackendConfig {
  type: 'filesystem'
  memoryDir: string
  scanIntervalMs?: number
}

export interface VectorBackendConfig extends StorageBackendConfig {
  type: 'vector'
  connectionString?: string
  collectionName?: string
  embeddingDimension?: number
  embeddingModel?: string
  apiKey?: string
  [key: string]: unknown
}

export interface SQLBackendConfig extends StorageBackendConfig {
  type: 'sql'
  connectionString: string
  tableName?: string
  dialect?: 'postgres' | 'mysql' | 'sqlite'
  [key: string]: unknown
}

export interface MongoDBBackendConfig extends StorageBackendConfig {
  type: 'mongodb'
  connectionString: string
  databaseName?: string
  collectionName?: string
  [key: string]: unknown
}

export interface StorageStats {
  totalMemories: number
  totalSizeBytes: number
  byType: Record<string, number>
  oldestAt: number | null
  newestAt: number | null
}

export interface MemoryStorageBackend {
  readonly type: StorageBackendType

  initialize(): Promise<void>

  close(): Promise<void>

  list(options?: StorageQueryOptions): Promise<MemoryFile[]>

  get(id: string): Promise<MemoryFile | null>

  save(memory: Omit<MemoryFile, 'mtimeMs' | 'sizeBytes'> & { mtimeMs?: number; sizeBytes?: number }): Promise<MemoryFile>

  update(id: string, updates: Partial<Pick<MemoryFile, 'content' | 'frontmatter' | 'type' | 'description'>>): Promise<MemoryFile | null>

  delete(id: string): Promise<boolean>

  search(options: StorageSearchOptions): Promise<StorageSearchResult[]>

  getStats(): Promise<StorageStats>

  exists(id: string): Promise<boolean>

  count(options?: StorageQueryOptions): Promise<number>

  clear(): Promise<void>
}
