/**
 * ModelIndex — filesystem-scanned model/media index with TTL cache.
 *
 * Mirrors node-def-index.ts architecture (single-flight, TTL, persistence,
 * atomic write) but scans COMFYUI_BASE_DIR/models/ and input/ instead of
 * fetching HTTP.
 *
 * Failure behavior (spec §6): if COMFYUI_BASE_DIR is unset, throws.
 * A missing models/ directory is NOT a failure — it means no models.
 */
import { promises as fs } from 'fs'
import { join, relative, extname } from 'path'
import { existsSync } from 'fs'
import { getSgaHome } from '../memory/paths.js'
import { createLogger } from '../utils/logger.js'
import { MODEL_EXTENSIONS, MEDIA_EXTENSIONS, MODEL_CATEGORIES } from './model-categories.js'

const logger = createLogger('model-index')

export const MODEL_INDEX_TTL_MS_DEFAULT = 300_000  // 5 minutes

const CACHE_FILENAME = 'model-index.json'

function getTtlMs(): number {
  return Number(process.env.SGA_MODEL_INDEX_TTL_MS) || MODEL_INDEX_TTL_MS_DEFAULT
}

function getComfyuiBaseDir(): string {
  const dir = process.env.COMFYUI_BASE_DIR
  if (!dir) throw new Error('COMFYUI_BASE_DIR is not set — cannot scan for models')
  return dir
}

export interface ModelEntry {
  name: string
  category: string
  relativePath: string   // relative to models/: "checkpoints/v1-5.safetensors"
  sizeBytes: number
}

export interface MediaEntry {
  name: string
  relativePath: string   // relative to input/: "subfolder/photo.png"
  sizeBytes: number
}

export interface ModelIndexStats {
  size: number
  fetchedAt: number | null
  source: 'cache-file' | 'fresh' | 'empty'
}

interface CacheFile {
  fetchedAt: number
  models: Record<string, ModelEntry[]>   // category → entries
  media: MediaEntry[]
}

let modelMap: Map<string, ModelEntry[]> | null = null  // category → entries
let mediaList: MediaEntry[] | null = null
let cacheFetchedAt: number | null = null
let sourceMarker: ModelIndexStats['source'] = 'empty'
let loadPromise: Promise<void> | null = null

function cachePath(): string {
  return join(getSgaHome(), CACHE_FILENAME)
}

async function scanDirectory(dir: string): Promise<Array<{ name: string; fullPath: string; sizeBytes: number }>> {
  const entries: Array<{ name: string; fullPath: string; sizeBytes: number }> = []

  async function walk(current: string): Promise<void> {
    let files
    try {
      files = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const file of files) {
      if (file.name.startsWith('.')) continue
      const fullPath = join(current, file.name)
      if (file.isDirectory()) {
        await walk(fullPath)
      } else if (file.isFile()) {
        let sizeBytes = 0
        try {
          const stats = await fs.stat(fullPath)
          sizeBytes = stats.size
        } catch {
          // skip stat errors
        }
        entries.push({ name: file.name, fullPath, sizeBytes })
      }
    }
  }

  await walk(dir)
  return entries
}

async function scanModels(baseDir: string): Promise<{ models: Map<string, ModelEntry[]>; media: MediaEntry[] }> {
  const models = new Map<string, ModelEntry[]>()
  const modelsDir = join(baseDir, 'models')

  for (const [category, subdirs] of Object.entries(MODEL_CATEGORIES)) {
    const entries: ModelEntry[] = []
    for (const subdir of subdirs) {
      const dirPath = join(modelsDir, subdir)
      if (!existsSync(dirPath)) continue
      const files = await scanDirectory(dirPath)
      for (const file of files) {
        const ext = extname(file.name).toLowerCase()
        if (!MODEL_EXTENSIONS.has(ext)) continue
        entries.push({
          name: file.name,
          category,
          relativePath: relative(modelsDir, file.fullPath).replace(/\\/g, '/'),
          sizeBytes: file.sizeBytes,
        })
      }
    }
    if (entries.length > 0) {
      models.set(category, entries)
    }
  }

  // Scan media files from input/
  const media: MediaEntry[] = []
  const inputDir = join(baseDir, 'input')
  if (existsSync(inputDir)) {
    const files = await scanDirectory(inputDir)
    for (const file of files) {
      const ext = extname(file.name).toLowerCase()
      if (!MEDIA_EXTENSIONS.has(ext)) continue
      media.push({
        name: file.name,
        relativePath: relative(inputDir, file.fullPath).replace(/\\/g, '/'),
        sizeBytes: file.sizeBytes,
      })
    }
  }

  return { models, media }
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, data, 'utf-8')
  await fs.rename(tmp, path)
}

async function readCacheFile(): Promise<CacheFile | null> {
  try {
    const raw = await fs.readFile(cachePath(), 'utf-8')
    return JSON.parse(raw) as CacheFile
  } catch {
    return null
  }
}

async function writeCacheFile(cacheData: CacheFile): Promise<void> {
  try {
    const serializable: CacheFile = {
      fetchedAt: cacheData.fetchedAt,
      models: {},
      media: cacheData.media,
    }
    // Convert Map to Record for JSON serialization
    if (modelMap) {
      for (const [category, entries] of modelMap) {
        serializable.models[category] = entries
      }
    }
    await atomicWrite(cachePath(), JSON.stringify(serializable))
  } catch (err) {
    logger.warn('failed to persist model-index cache', err)
  }
}

async function loadFromCacheFile(file: CacheFile): Promise<void> {
  const map = new Map<string, ModelEntry[]>()
  for (const [category, entries] of Object.entries(file.models)) {
    map.set(category, entries)
  }
  modelMap = map
  mediaList = file.media
  cacheFetchedAt = file.fetchedAt
  sourceMarker = 'cache-file'
}

async function loadFromScan(): Promise<void> {
  const baseDir = getComfyuiBaseDir()
  const { models, media } = await scanModels(baseDir)
  modelMap = models
  mediaList = media
  cacheFetchedAt = Date.now()
  sourceMarker = 'fresh'
  await writeCacheFile({ fetchedAt: cacheFetchedAt, models: {}, media })
}

async function ensureLoaded(): Promise<void> {
  const ttl = getTtlMs()
  if (modelMap && mediaList && cacheFetchedAt !== null && Date.now() - cacheFetchedAt < ttl) {
    return  // memory fresh
  }
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const file = await readCacheFile()
    const now = Date.now()
    if (file && now - file.fetchedAt < ttl) {
      await loadFromCacheFile(file)
      return
    }
    // Scan the filesystem (throws if COMFYUI_BASE_DIR unset — spec §6)
    await loadFromScan()
  })()
  try {
    await loadPromise
  } finally {
    loadPromise = null
  }
}

export async function getModelFile(category: string, name: string): Promise<ModelEntry | null> {
  await ensureLoaded()
  const entries = modelMap?.get(category) ?? []
  return entries.find(e => e.name === name) ?? null
}

export async function getMediaFile(name: string): Promise<MediaEntry | null> {
  await ensureLoaded()
  return mediaList?.find(e => e.name === name) ?? null
}

export async function listModels(category?: string): Promise<ModelEntry[]> {
  await ensureLoaded()
  if (category) {
    return modelMap?.get(category) ?? []
  }
  const all: ModelEntry[] = []
  for (const entries of modelMap?.values() ?? []) {
    all.push(...entries)
  }
  return all
}

export async function listMediaFiles(): Promise<MediaEntry[]> {
  await ensureLoaded()
  return mediaList ?? []
}

export async function refreshModelIndex(): Promise<{ count: number; source: 'fresh' }> {
  await loadFromScan()
  let count = 0
  for (const entries of modelMap?.values() ?? []) {
    count += entries.length
  }
  return { count, source: 'fresh' }
}

export function getModelIndexStats(): ModelIndexStats {
  if (!modelMap || cacheFetchedAt === null) {
    return { size: 0, fetchedAt: null, source: 'empty' }
  }
  let size = 0
  for (const entries of modelMap.values()) {
    size += entries.length
  }
  return { size, fetchedAt: cacheFetchedAt, source: sourceMarker }
}
