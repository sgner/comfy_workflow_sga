/**
 * Node Definition Index — cached /object_info with TTL + persistence.
 *
 * Cache strategy:
 *   - First access: try cache file. If fresh (< TTL), load. If stale or
 *     missing, fetch /object_info.
 *   - Fetch failure: fall back to stale cache (better than nothing).
 *   - TTL: 2 min. /object_info changes only when custom nodes are
 *     installed/removed, so 2 min is conservative.
 *
 * Normalization: ObjectInfo.input.required/optional are Record<widgetName,
 * [type, ...opts]>. Flattened into a single inputs[] with required flag.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { getSgaHome } from '../memory/paths.js'
import { createLogger } from '../utils/logger.js'
import { getComfyUIApiBaseUrl, COMFYUI_DEFAULT_TIMEOUT_MS } from './api-base.js'

const logger = createLogger('node-def-index')

export const NODE_DEF_INDEX_TTL_MS = 120_000  // 2 minutes

const CACHE_FILENAME = 'node-defs.json'

export interface NodeDef {
  name: string
  category: string
  description?: string
  inputs: Array<{ name: string; type: string; required: boolean }>
  outputs: Array<{ name: string; type: string }>
  deprecated?: boolean
  experimental?: boolean
}

export interface NodeDefIndexStats {
  size: number
  fetchedAt: number | null
  source: 'memory' | 'cache-file' | 'fresh' | 'empty'
}

interface CacheFile {
  fetchedAt: number
  entries: Record<string, ObjectInfoRaw>
}

interface ObjectInfoRaw {
  name: string
  category: string
  description?: string
  input?: {
    required?: Record<string, [string | string[], ...unknown[]]>
    optional?: Record<string, [string | string[], ...unknown[]]>
  }
  output?: string[]
  output_name?: string[]
  deprecated?: boolean
  experimental?: boolean
}

let cache: Map<string, NodeDef> | null = null
let cacheFetchedAt: number | null = null
let sourceMarker: NodeDefIndexStats['source'] = 'empty'
let loadPromise: Promise<void> | null = null

function cachePath(): string {
  return join(getSgaHome(), CACHE_FILENAME)
}

function normalizeType(t: string | string[]): string {
  return Array.isArray(t) ? t.join(' | ') : t
}

function normalize(raw: ObjectInfoRaw): NodeDef {
  const inputs: NodeDef['inputs'] = []
  const required = raw.input?.required ?? {}
  const optional = raw.input?.optional ?? {}
  for (const [name, spec] of Object.entries(required)) {
    inputs.push({ name, type: normalizeType(spec[0]), required: true })
  }
  for (const [name, spec] of Object.entries(optional)) {
    inputs.push({ name, type: normalizeType(spec[0]), required: false })
  }
  const outputs: NodeDef['outputs'] = []
  const outputTypes = raw.output ?? []
  const outputNames = raw.output_name ?? outputTypes
  for (let i = 0; i < outputTypes.length; i++) {
    outputs.push({ name: outputNames[i] ?? outputTypes[i], type: outputTypes[i] })
  }
  return {
    name: raw.name,
    category: raw.category,
    description: raw.description,
    inputs,
    outputs,
    deprecated: raw.deprecated,
    experimental: raw.experimental,
  }
}

async function fetchObjectInfo(): Promise<Record<string, ObjectInfoRaw>> {
  const url = `${getComfyUIApiBaseUrl()}/object_info`
  logger.info(`fetching ${url}`)
  const res = await fetch(url, { signal: AbortSignal.timeout(COMFYUI_DEFAULT_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`ComfyUI /object_info returned ${res.status}`)
  return (await res.json()) as Record<string, ObjectInfoRaw>
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

async function writeCacheFile(entries: Record<string, ObjectInfoRaw>, fetchedAt: number): Promise<void> {
  try {
    await atomicWrite(cachePath(), JSON.stringify({ fetchedAt, entries }))
  } catch (err) {
    logger.warn('failed to persist node-def cache', err)
  }
}

async function loadFromEntries(entries: Record<string, ObjectInfoRaw>, fetchedAt: number, source: NodeDefIndexStats['source']): Promise<void> {
  const map = new Map<string, NodeDef>()
  for (const [name, raw] of Object.entries(entries)) {
    map.set(name, normalize(raw))
  }
  cache = map
  cacheFetchedAt = fetchedAt
  sourceMarker = source
  if (source === 'fresh') {
    await writeCacheFile(entries, fetchedAt)
  }
}

async function ensureLoaded(): Promise<void> {
  if (cache && cacheFetchedAt !== null && Date.now() - cacheFetchedAt < NODE_DEF_INDEX_TTL_MS) {
    return  // memory fresh
  }
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const file = await readCacheFile()
    const now = Date.now()
    if (file && now - file.fetchedAt < NODE_DEF_INDEX_TTL_MS) {
      await loadFromEntries(file.entries, file.fetchedAt, 'cache-file')
      return
    }
    try {
      const entries = await fetchObjectInfo()
      await loadFromEntries(entries, now, 'fresh')
    } catch (err) {
      if (file) {
        logger.warn('fetch failed, falling back to stale cache', err)
        await loadFromEntries(file.entries, file.fetchedAt, 'cache-file')
      } else {
        logger.warn('fetch failed and no cache', err)
        cache = new Map()
        cacheFetchedAt = null
        sourceMarker = 'empty'
      }
    }
  })()
  try {
    await loadPromise
  } finally {
    loadPromise = null
  }
}

export async function getNodeDef(name: string): Promise<NodeDef | null> {
  await ensureLoaded()
  return cache?.get(name) ?? null
}

export async function listNodeDefNames(): Promise<string[]> {
  await ensureLoaded()
  return cache ? Array.from(cache.keys()) : []
}

export async function refreshNodeDefIndex(): Promise<{ count: number; source: 'fresh' }> {
  const entries = await fetchObjectInfo()
  await loadFromEntries(entries, Date.now(), 'fresh')
  return { count: cache?.size ?? 0, source: 'fresh' }
}

export function getNodeDefIndexStats(): NodeDefIndexStats {
  if (!cache || cacheFetchedAt === null) {
    return { size: 0, fetchedAt: null, source: 'empty' }
  }
  return { size: cache.size, fetchedAt: cacheFetchedAt, source: sourceMarker }
}
