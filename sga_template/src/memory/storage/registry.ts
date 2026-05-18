import type { MemoryStorageBackend, StorageBackendConfig, StorageBackendType } from './types.js'
import { FileSystemBackend } from './filesystem.js'
import { VectorBackend } from './vector.js'
import { SQLBackend } from './sql.js'
import { MongoDBBackend } from './mongodb.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('storage-registry')

type BackendFactory = (config: StorageBackendConfig) => MemoryStorageBackend

const registry: Map<StorageBackendType, BackendFactory> = new Map()

registry.set('filesystem', (config) => new FileSystemBackend(config as import('./types.js').FileSystemBackendConfig))
registry.set('vector', (config) => new VectorBackend(config as import('./types.js').VectorBackendConfig))
registry.set('sql', (config) => new SQLBackend(config as import('./types.js').SQLBackendConfig))
registry.set('mongodb', (config) => new MongoDBBackend(config as import('./types.js').MongoDBBackendConfig))

export function registerBackend(type: StorageBackendType, factory: BackendFactory): void {
  registry.set(type, factory)
  logger.info(`Registered storage backend: ${type}`)
}

export function createBackend(config: StorageBackendConfig): MemoryStorageBackend {
  const factory = registry.get(config.type)
  if (!factory) {
    throw new Error(`Unknown storage backend type: "${config.type}". Available: ${[...registry.keys()].join(', ')}`)
  }

  const backend = factory(config)
  logger.info(`Created storage backend: ${config.type}`)
  return backend
}

export function getRegisteredBackendTypes(): StorageBackendType[] {
  return [...registry.keys()]
}

export function isBackendRegistered(type: StorageBackendType): boolean {
  return registry.has(type)
}
