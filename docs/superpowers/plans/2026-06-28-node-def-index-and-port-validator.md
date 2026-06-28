# Node Definition Index and Port-Type Validator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cached Node Definition Index backed by ComfyUI `/object_info` and a port-type validator that consumes it, producing UI-shaped `WorkflowIssue[]` so the existing Diagnostics tab surfaces type mismatches without frontend changes.

**Architecture:** Plain TypeScript modules under `sga_template/src/comfyui/`. The index fetches `/object_info` once, normalizes each entry to a `NodeDef` shape compatible with UI `NodeDefInfo`, caches in memory with a 2-minute TTL, and persists to `<SGA_HOME>/node-defs.json` for startup-fast reads. The validator walks the graph's `links[]` and `nodes[]`, consults the index per node type to detect (a) port-type mismatches, (b) orphaned outputs, and (c) missing required widgets. Output is mapped to the UI `WorkflowIssue` shape (camelCase, `source: 'native'`) so the existing Diagnostics tab renders it without changes.

**Tech Stack:** TypeScript 5.x, Node.js ESM (NodeNext), Vitest 2.1.9, native `fetch`, native `fs/promises`.

## Global Constraints

- TypeScript ESM: all relative imports use `.js` extensions even for `.ts` source.
- Node.js 20+. No new dependencies — use `fetch`, `fs/promises`, `path`.
- Tests: Vitest 2.1.9, colocated as `*.test.ts`. Run via `npm test` (=`vitest run`). Verify = `npm run typecheck && npm test` from `sga_template/`.
- Env vars: `COMFYUI_API_HOST` (default `127.0.0.1`) and `COMFYUI_API_PORT` (default `8188`).
- `SGA_HOME` resolves via `getSgaHome()` from `sga_template/src/memory/paths.ts` (import as `../memory/paths.js`).
- Atomic file writes: `.tmp` + `fs.rename` (existing pattern in `live-context.ts:62-66`).
- No `console.log` — use `createLogger(...)` from `sga_template/src/utils/logger.ts`.
- ComfyUI graph JSON shape: `{ nodes: Array<{id, type, inputs?, outputs?, widgets_values?}>, links?: Array<[linkId, fromId, fromSlot, toId, toSlot, type]> }`.

---

## Task 1: Shared ComfyUI Base URL Helper

**Files:**
- Create: `sga_template/src/comfyui/api-base.ts`
- Create: `sga_template/src/comfyui/api-base.test.ts`
- Modify: `sga_template/src/tools/built-in/comfyui-api.ts` (replace local `getComfyUIApiBaseUrl`)

**Interfaces:**
- Produces: `getComfyUIApiBaseUrl(): string`, `COMFYUI_DEFAULT_TIMEOUT_MS: number` (= 30000).

- [ ] **Step 1.1: Write failing test** — Create `sga_template/src/comfyui/api-base.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from 'vitest'

describe('api-base', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

  it('uses defaults when env unset', async () => {
    vi.stubEnv('COMFYUI_API_HOST', '')
    vi.stubEnv('COMFYUI_API_PORT', '')
    const { getComfyUIApiBaseUrl } = await import('./api-base.js')
    expect(getComfyUIApiBaseUrl()).toBe('http://127.0.0.1:8188')
  })

  it('honors env overrides', async () => {
    vi.stubEnv('COMFYUI_API_HOST', '10.0.0.5')
    vi.stubEnv('COMFYUI_API_PORT', '8199')
    const { getComfyUIApiBaseUrl } = await import('./api-base.js')
    expect(getComfyUIApiBaseUrl()).toBe('http://10.0.0.5:8199')
  })

  it('strips trailing slash from host', async () => {
    vi.stubEnv('COMFYUI_API_HOST', 'host.local/')
    vi.stubEnv('COMFYUI_API_PORT', '8188')
    const { getComfyUIApiBaseUrl } = await import('./api-base.js')
    expect(getComfyUIApiBaseUrl()).toBe('http://host.local:8188')
  })

  it('exports a 30s default timeout', async () => {
    const { COMFYUI_DEFAULT_TIMEOUT_MS } = await import('./api-base.js')
    expect(COMFYUI_DEFAULT_TIMEOUT_MS).toBe(30000)
  })
})
```

- [ ] **Step 1.2: Run test to verify it fails** — `cd sga_template && npm test -- src/comfyui/api-base.test.ts` → FAIL (module not found).

- [ ] **Step 1.3: Write implementation** — Create `sga_template/src/comfyui/api-base.ts`:

```ts
/**
 * Shared ComfyUI API base URL — single source of truth.
 * Standardize on COMFYUI_API_HOST/PORT (matching the agent tool).
 */
export const COMFYUI_DEFAULT_TIMEOUT_MS = 30000

export function getComfyUIApiBaseUrl(): string {
  const host = (process.env.COMFYUI_API_HOST ?? '127.0.0.1').replace(/\/+$/, '')
  const port = process.env.COMFYUI_API_PORT ?? '8188'
  return `http://${host}:${port}`
}
```

- [ ] **Step 1.4: Run test to verify it passes** — `cd sga_template && npm test -- src/comfyui/api-base.test.ts` → PASS (4 tests).

- [ ] **Step 1.5: Refactor `comfyui-api.ts`** — Replace local `getComfyUIApiBaseUrl` (lines 6-10) with:

```ts
import { getComfyUIApiBaseUrl, COMFYUI_DEFAULT_TIMEOUT_MS } from '../../comfyui/api-base.js'
```

Replace `AbortSignal.timeout(30000)` with `AbortSignal.timeout(COMFYUI_DEFAULT_TIMEOUT_MS)`. Run `npm run typecheck`.

- [ ] **Step 1.6: Commit** — `git add sga_template/src/comfyui/api-base.ts sga_template/src/comfyui/api-base.test.ts sga_template/src/tools/built-in/comfyui-api.ts && git commit -m "refactor(comfyui): extract shared getComfyUIApiBaseUrl helper"`

---

## Task 2: Backend-Canonical WorkflowIssue Type

**Files:**
- Create: `sga_template/src/comfyui/issue-types.ts`

**Interfaces:**
- Produces: `WorkflowIssue`, `IssueSeverity`, `IssueSource`, `IssueCategory` (mirrors `ui/src/types.ts:135-156` camelCase shape).

- [ ] **Step 2.1: Write the type file** — Create `sga_template/src/comfyui/issue-types.ts`:

```ts
/**
 * Backend-canonical WorkflowIssue type. Mirrors ui/src/types.ts exactly
 * (camelCase) so backend issues render in the UI Diagnostics tab without
 * translation. Resolves three-type divergence (workflow-analyzer.ts
 * snake_case, comfyui-workflow-validate.ts no id field).
 *
 * When adding fields here, also update ui/src/types.ts.
 */
export type IssueSeverity = 'error' | 'warning' | 'info'
export type IssueSource = 'native' | 'agent'

export type IssueCategory =
  | 'missing_model' | 'missing_node' | 'missing_media' | 'runtime_error'
  | 'port_type_mismatch' | 'orphaned_output' | 'missing_required_widget'
  | 'invalid_link' | 'unknown_node_type'

export interface WorkflowIssue {
  /** Stable unique id, e.g. 'port_type_mismatch:<nodeId>:<inputSlot>' */
  id: string
  nodeId: number | null
  nodeIds?: number[]
  severity: IssueSeverity
  category?: IssueCategory | string
  message: string
  impact?: string
  fixSuggestion?: string
  nodeType?: string
  exceptionType?: string
  traceback?: string
  currentInputs?: Record<string, unknown>
  isRuntimeError?: boolean
  source?: IssueSource
  modelName?: string
  modelFolder?: string
}
```

- [ ] **Step 2.2: Verify it compiles** — `cd sga_template && npm run typecheck` → PASS.

- [ ] **Step 2.3: Commit** — `git add sga_template/src/comfyui/issue-types.ts && git commit -m "feat(comfyui): add backend-canonical WorkflowIssue type"`

---

## Task 3: Node Definition Index

**Files:**
- Create: `sga_template/src/comfyui/node-def-index.ts`
- Create: `sga_template/src/comfyui/node-def-index.test.ts`

**Interfaces:**
- Consumes: `getComfyUIApiBaseUrl` from `./api-base.js`, `getSgaHome` from `../memory/paths.js`, `createLogger` from `../utils/logger.js`.
- Produces: `NodeDef`, `NodeDefIndexStats`, `getNodeDef(name)`, `listNodeDefNames()`, `refreshNodeDefIndex()`, `getNodeDefIndexStats()`, `NODE_DEF_INDEX_TTL_MS`.

- [ ] **Step 3.1: Write failing tests** — Create `sga_template/src/comfyui/node-def-index.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const sampleObjectInfo = {
  CLIPTextEncode: {
    name: 'CLIPTextEncode',
    category: 'conditioning',
    description: 'Encodes a text prompt.',
    input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
    output: ['CONDITIONING'],
    output_name: ['CONDITIONING'],
  },
  KSampler: {
    name: 'KSampler',
    category: 'sampling',
    input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT'] } },
    output: ['LATENT'],
    output_name: ['LATENT'],
  },
}

describe('node-def-index', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-node-def-'))
    vi.stubEnv('SGA_HOME', tmpHome)
    vi.stubEnv('COMFYUI_API_HOST', '127.0.0.1')
    vi.stubEnv('COMFYUI_API_PORT', '8188')
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('returns null when ComfyUI unreachable and no cache exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const { getNodeDef, getNodeDefIndexStats } = await import('./node-def-index.js')
    expect(await getNodeDef('CLIPTextEncode')).toBeNull()
    expect(getNodeDefIndexStats().source).toBe('empty')
  })

  it('fetches and normalizes /object_info on first access', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    const { getNodeDef, listNodeDefNames, getNodeDefIndexStats } = await import('./node-def-index.js')
    const def = await getNodeDef('CLIPTextEncode')
    expect(def).not.toBeNull()
    expect(def?.category).toBe('conditioning')
    expect(def?.inputs).toEqual([
      { name: 'text', type: 'STRING', required: true },
      { name: 'clip', type: 'CLIP', required: true },
    ])
    expect(def?.outputs).toEqual([{ name: 'CONDITIONING', type: 'CONDITIONING' }])
    expect(await listNodeDefNames()).toEqual(['CLIPTextEncode', 'KSampler'])
    expect(getNodeDefIndexStats().source).toBe('fresh')
    expect(getNodeDefIndexStats().size).toBe(2)
  })

  it('persists cache to <SGA_HOME>/node-defs.json after fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    const { refreshNodeDefIndex } = await import('./node-def-index.js')
    await refreshNodeDefIndex()
    const raw = await fs.readFile(join(tmpHome, 'node-defs.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.fetchedAt).toBeGreaterThan(0)
    expect(parsed.entries.CLIPTextEncode.name).toBe('CLIPTextEncode')
  })

  it('loads from cache file on startup when fresh enough', async () => {
    const past = Date.now() - 10_000
    await fs.writeFile(join(tmpHome, 'node-defs.json'), JSON.stringify({ fetchedAt: past, entries: sampleObjectInfo }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('should not fetch')))
    const { getNodeDef, getNodeDefIndexStats } = await import('./node-def-index.js')
    const def = await getNodeDef('KSampler')
    expect(def?.category).toBe('sampling')
    expect(getNodeDefIndexStats().source).toBe('cache-file')
  })

  it('re-fetches when TTL has expired', async () => {
    const stale = Date.now() - 180_000
    await fs.writeFile(join(tmpHome, 'node-defs.json'), JSON.stringify({ fetchedAt: stale, entries: sampleObjectInfo }))
    let calls = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      calls++
      return { ok: true, status: 200, json: async () => sampleObjectInfo } as unknown as Response
    }))
    const { getNodeDef } = await import('./node-def-index.js')
    await getNodeDef('CLIPTextEncode')
    expect(calls).toBe(1)
  })

  it('returns null for unknown node name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    const { getNodeDef } = await import('./node-def-index.js')
    expect(await getNodeDef('DoesNotExist')).toBeNull()
  })

  it('falls back to stale cache when fetch fails but cache exists', async () => {
    const stale = Date.now() - 180_000
    await fs.writeFile(join(tmpHome, 'node-defs.json'), JSON.stringify({ fetchedAt: stale, entries: sampleObjectInfo }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const { getNodeDef, getNodeDefIndexStats } = await import('./node-def-index.js')
    const def = await getNodeDef('CLIPTextEncode')
    expect(def?.name).toBe('CLIPTextEncode')
    expect(getNodeDefIndexStats().source).toBe('cache-file')
  })

  it('handles optional inputs and multi-output nodes', async () => {
    const multiOutput = {
      CheckpointLoaderSimple: {
        name: 'CheckpointLoaderSimple',
        category: 'loaders',
        input: {
          required: { ckpt_name: [['model1.safetensors', 'model2.safetensors']] },
          optional: { config_name: ['STRING', { default: '' }] },
        },
        output: ['MODEL', 'CLIP', 'VAE'],
        output_name: ['MODEL', 'CLIP', 'VAE'],
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => multiOutput,
    } as unknown as Response))
    const { getNodeDef } = await import('./node-def-index.js')
    const def = await getNodeDef('CheckpointLoaderSimple')
    expect(def?.inputs.find(i => i.name === 'config_name')?.required).toBe(false)
    expect(def?.outputs.length).toBe(3)
  })
})
```

- [ ] **Step 3.2: Run tests to verify they fail** — `cd sga_template && npm test -- src/comfyui/node-def-index.test.ts` → FAIL (module not found).

- [ ] **Step 3.3: Write implementation** — Create `sga_template/src/comfyui/node-def-index.ts`:

```ts
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
```

- [ ] **Step 3.4: Run tests to verify they pass** — `cd sga_template && npm test -- src/comfyui/node-def-index.test.ts` → PASS (8 tests).

- [ ] **Step 3.5: Run typecheck and full test suite** — `cd sga_template && npm run typecheck && npm test` → PASS.

- [ ] **Step 3.6: Commit** — `git add sga_template/src/comfyui/node-def-index.ts sga_template/src/comfyui/node-def-index.test.ts && git commit -m "feat(comfyui): add Node Definition Index with TTL cache and persistence"`

---

## Task 4: Port-Type Validator

**Files:**
- Create: `sga_template/src/comfyui/validators/port-type-validator.ts`
- Create: `sga_template/src/comfyui/validators/port-type-validator.test.ts`

**Interfaces:**
- Consumes: `NodeDef`, `getNodeDef(name)` from `../node-def-index.js`, `WorkflowIssue` from `../issue-types.js`.
- Produces: `validatePortTypes(workflow: Record<string, unknown>): Promise<WorkflowIssue[]>`.

**Validation rules:**
1. Unknown node type (`warning`, `unknown_node_type`) — type not in index.
2. Port type mismatch (`error`, `port_type_mismatch`) — link source output type != destination input type.
3. Orphaned output (`info`, `orphaned_output`) — output slot has no links. Skip muted nodes (mode === 4).
4. Missing required widget (`warning`, `missing_required_widget`) — widgets_values shorter than required primitive widget count.

- [ ] **Step 4.1: Write failing tests** — Create `sga_template/src/comfyui/validators/port-type-validator.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const sampleObjectInfo = {
  CLIPTextEncode: {
    name: 'CLIPTextEncode',
    category: 'conditioning',
    input: { required: { text: ['STRING'], clip: ['CLIP'] } },
    output: ['CONDITIONING'],
    output_name: ['CONDITIONING'],
  },
  KSampler: {
    name: 'KSampler',
    category: 'sampling',
    input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT'] } },
    output: ['LATENT'],
    output_name: ['LATENT'],
  },
}

function makeWorkflow(nodes: any[], links: any[]) {
  return { nodes, links, last_node_id: nodes.length, last_link_id: links.length }
}

describe('port-type-validator', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-port-val-'))
    vi.stubEnv('SGA_HOME', tmpHome)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    vi.resetModules()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('returns empty array for a clean workflow', async () => {
    const { validatePortTypes } = await import('./port-type-validator.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'CLIPTextEncode', outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [1] }] },
        { id: 2, type: 'KSampler', inputs: [{ name: 'positive', type: 'CONDITIONING', link: 1 }] },
      ],
      [[1, 1, 0, 2, 0, 'CONDITIONING']],
    )
    const issues = await validatePortTypes(wf)
    expect(issues).toEqual([])
  })

  it('detects port type mismatch on incompatible link', async () => {
    const { validatePortTypes } = await import('./port-type-validator.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'KSampler', outputs: [{ name: 'LATENT', type: 'LATENT', links: [1] }] },
        { id: 2, type: 'CLIPTextEncode', inputs: [{ name: 'clip', type: 'CLIP', link: 1 }] },
      ],
      [[1, 1, 0, 2, 0, 'LATENT']],
    )
    const issues = await validatePortTypes(wf)
    expect(issues.length).toBe(1)
    expect(issues[0].severity).toBe('error')
    expect(issues[0].category).toBe('port_type_mismatch')
    expect(issues[0].nodeIds).toEqual([1, 2])
    expect(issues[0].message).toMatch(/LATENT.*CLIP/)
  })

  it('flags orphaned outputs as info', async () => {
    const { validatePortTypes } = await import('./port-type-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'CLIPTextEncode', outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: null }] }],
      [],
    )
    const issues = await validatePortTypes(wf)
    const orphan = issues.find(i => i.category === 'orphaned_output')
    expect(orphan).toBeDefined()
    expect(orphan?.severity).toBe('info')
    expect(orphan?.nodeId).toBe(1)
  })

  it('skips muted nodes (mode === 4)', async () => {
    const { validatePortTypes } = await import('./port-type-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'CLIPTextEncode', mode: 4, outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: null }] }],
      [],
    )
    const issues = await validatePortTypes(wf)
    expect(issues.find(i => i.category === 'orphaned_output')).toBeUndefined()
  })

  it('warns on unknown node type', async () => {
    const { validatePortTypes } = await import('./port-type-validator.js')
    const wf = makeWorkflow([{ id: 1, type: 'SomeCustomNode', outputs: [], inputs: [] }], [])
    const issues = await validatePortTypes(wf)
    const unknown = issues.find(i => i.category === 'unknown_node_type')
    expect(unknown).toBeDefined()
    expect(unknown?.severity).toBe('warning')
    expect(unknown?.nodeType).toBe('SomeCustomNode')
  })

  it('issues carry source: native so UI renders them', async () => {
    const { validatePortTypes } = await import('./port-type-validator.js')
    const wf = makeWorkflow([{ id: 1, type: 'Unknown', outputs: [], inputs: [] }], [])
    const issues = await validatePortTypes(wf)
    expect(issues.every(i => i.source === 'native')).toBe(true)
    expect(issues.every(i => typeof i.id === 'string' && i.id.length > 0)).toBe(true)
  })
})
```

- [ ] **Step 4.2: Run tests to verify they fail** — `cd sga_template && npm test -- src/comfyui/validators/port-type-validator.test.ts` → FAIL (module not found).

- [ ] **Step 4.3: Write implementation** — Create `sga_template/src/comfyui/validators/port-type-validator.ts`:

```ts
/**
 * Port-Type Validator — consults NodeDefIndex to detect structural issues.
 *
 * Emits WorkflowIssue[] in the UI shape (camelCase, source: 'native') so
 * the Diagnostics tab renders them without translation.
 *
 * Known limits (deferred to future plans):
 *   - No widget schema validation (just count-based heuristic)
 *   - No detection of duplicate link ids or cycles
 *   - typesCompatible() is exact-match only (no ComfyUI subtyping)
 */
import type { WorkflowIssue } from '../issue-types.js'
import type { NodeDef } from '../node-def-index.js'
import { getNodeDef } from '../node-def-index.js'

interface GraphNode {
  id: number | string
  type: string
  mode?: number
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
  widgets_values?: unknown[]
}

interface GraphLink {
  0: number         // linkId
  1: number | string // fromId
  2: number         // fromSlot
  3: number | string // toId
  4: number         // toSlot
  5: string         // type
}

const PRIMITIVE_WIDGET_TYPES = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN'])

interface NodeContext {
  node: GraphNode
  def: NodeDef | null
}

export async function validatePortTypes(workflow: Record<string, unknown>): Promise<WorkflowIssue[]> {
  const nodes = ((workflow.nodes as GraphNode[] | undefined) ?? []).filter(n => n && typeof n.id !== 'undefined')
  const links = ((workflow.links as GraphLink[] | undefined) ?? [])
  const issues: WorkflowIssue[] = []

  // Index lookups (one per unique node type)
  const defCache = new Map<string, NodeDef | null>()
  async function getDef(type: string): Promise<NodeDef | null> {
    if (!defCache.has(type)) defCache.set(type, await getNodeDef(type))
    return defCache.get(type) ?? null
  }

  // Build node lookup by id
  const nodeById = new Map<string | number, NodeContext>()
  for (const node of nodes) {
    const def = await getDef(node.type)
    nodeById.set(node.id, { node, def })

    // Rule 1: unknown node type
    if (!def) {
      issues.push({
        id: `unknown_node_type:${node.id}:${node.type}`,
        nodeId: typeof node.id === 'number' ? node.id : null,
        nodeIds: [typeof node.id === 'number' ? node.id : null].filter((x): x is number => x !== null),
        severity: 'warning',
        category: 'unknown_node_type',
        message: `Node type "${node.type}" is not in the ComfyUI node definition index. Port-type checks skipped for this node.`,
        impact: 'Cannot validate connections or widgets for this node.',
        fixSuggestion: `Ensure the custom node providing "${node.type}" is installed and ComfyUI is reachable.`,
        nodeType: node.type,
        source: 'native',
      })
    }
  }

  // Rule 2: port type mismatch on links
  for (const link of links) {
    if (!Array.isArray(link) || link.length < 6) continue
    const [, fromId, fromSlot, toId, toSlot] = link
    const fromCtx = nodeById.get(fromId)
    const toCtx = nodeById.get(toId)
    if (!fromCtx || !toCtx) continue

    const fromDef = fromCtx.def
    const toDef = toCtx.def
    if (!fromDef || !toDef) continue

    const fromOutput = fromDef.outputs[fromSlot]
    const toInput = toDef.inputs[toSlot]
    if (!fromOutput || !toInput) continue

    const sourceType = fromOutput.type
    const targetType = toInput.type
    if (sourceType === '*' || targetType === '*') continue
    if (!typesCompatible(sourceType, targetType)) {
      issues.push({
        id: `port_type_mismatch:${link[0]}`,
        nodeId: typeof fromId === 'number' ? fromId : null,
        nodeIds: [fromId, toId].filter((x): x is number => typeof x === 'number'),
        severity: 'error',
        category: 'port_type_mismatch',
        message: `Link ${link[0]}: output type "${sourceType}" of node ${fromId} slot ${fromSlot} is not compatible with input type "${targetType}" of node ${toId} slot ${toSlot}.`,
        impact: 'ComfyUI will reject this workflow at queue time, or silently coerce the value (uncommon).',
        fixSuggestion: `Reconnect node ${fromId} output ${fromSlot} (${sourceType}) to a ${targetType} input, or replace node ${fromId} with one that outputs ${targetType}.`,
        nodeType: fromCtx.node.type,
        source: 'native',
      })
    }
  }

  // Rule 3: orphaned outputs (skip muted nodes)
  for (const { node, def } of nodeById.values()) {
    if (node.mode === 4) continue
    if (!def) continue
    if (!Array.isArray(node.outputs)) continue
    for (let slot = 0; slot < node.outputs.length; slot++) {
      const out = node.outputs[slot]
      const links = out?.links
      if (!links || (Array.isArray(links) && links.every(l => l === null))) {
        const outDef = def.outputs[slot]
        issues.push({
          id: `orphaned_output:${node.id}:${slot}`,
          nodeId: typeof node.id === 'number' ? node.id : null,
          severity: 'info',
          category: 'orphaned_output',
          message: `Node ${node.id} (${node.type}) output slot ${slot} "${outDef?.name ?? `#${slot}`}" (${outDef?.type ?? 'unknown'}) is not connected.`,
          impact: 'Output value is computed but unused. No runtime error, but wastes compute.',
          fixSuggestion: `Connect this output to a downstream node, or remove the node if unneeded.`,
          nodeType: node.type,
          source: 'native',
        })
      }
    }
  }

  // Rule 4: missing required widgets (heuristic — count-based)
  for (const { node, def } of nodeById.values()) {
    if (!def) continue
    const requiredWidgets = def.inputs.filter(i => i.required && PRIMITIVE_WIDGET_TYPES.has(i.type.split(' | ')[0]))
    if (requiredWidgets.length === 0) continue
    const widgetCount = Array.isArray(node.widgets_values) ? node.widgets_values.length : 0
    if (widgetCount < requiredWidgets.length) {
      const missing = requiredWidgets.slice(widgetCount).map(w => w.name).join(', ')
      issues.push({
        id: `missing_required_widget:${node.id}`,
        nodeId: typeof node.id === 'number' ? node.id : null,
        severity: 'warning',
        category: 'missing_required_widget',
        message: `Node ${node.id} (${node.type}) has ${widgetCount} widget values but ${requiredWidgets.length} required widgets (${missing}).`,
        impact: 'ComfyUI may fail to queue this node or use default values silently.',
        fixSuggestion: `Open the node in ComfyUI and fill in the missing widget values: ${missing}.`,
        nodeType: node.type,
        source: 'native',
      })
    }
  }

  return issues
}

function typesCompatible(a: string, b: string): boolean {
  if (a === b) return true
  // ComfyUI has subtyping (MODEL -> MODEL*, etc.) but reproducing it is
  // out of scope. For v1, only exact match counts as compatible.
  return false
}
```

- [ ] **Step 4.4: Run tests to verify they pass** — `cd sga_template && npm test -- src/comfyui/validators/port-type-validator.test.ts` → PASS (6 tests).

- [ ] **Step 4.5: Run typecheck and full test suite** — `cd sga_template && npm run typecheck && npm test` → PASS.

- [ ] **Step 4.6: Commit** — `git add sga_template/src/comfyui/validators/port-type-validator.ts sga_template/src/comfyui/validators/port-type-validator.test.ts && git commit -m "feat(comfyui): add port-type validator backed by NodeDefIndex"`

---

## Self-Review Notes

**Spec coverage:** Workstreams #2 (Node Definition Index) and #3 (Validation Engine — partial) from `workflow-domain-capability-plan.md`. Out of scope: #1 Normalizer, #4 Patch Planner, #5 Transactional Apply, #6 Test Corpus, #7 UI Diagnostics Upgrade, plus Workstream 0 (Workflow Identity Preservation).

**Placeholder scan:** No placeholders. Every code step contains full code.

**Type consistency:**
- `NodeDef` defined in Task 3, consumed in Task 4 — names match.
- `WorkflowIssue` defined in Task 2, consumed in Task 4 — fields match.
- `getComfyUIApiBaseUrl` defined in Task 1, consumed in Task 3 — signature matches.

**Known risks:**
1. `typesCompatible()` is exact-match only. ComfyUI's actual type system has subtyping — false positives possible. Flag in commit message.
2. `/object_info` response can be large (50+ custom nodes = several MB). In-memory JSON.parse; if bottleneck, switch to streaming.
3. ComfyUI node `id` can be `number` (graph format) or `string` (prompt API). Validator handles both via `typeof` checks; some `nodeId` fields may be `null` if mixed.

---

## Out of Scope (Future Plans)

- Wire `validatePortTypes` into HTTP route (`POST /api/v1/workflow/validate-deep`) for UI's "Deep Scan (Backend)" button.
- Replace three divergent issue types with the new shared `WorkflowIssue`.
- Workflow Normalizer (Workstream #1).
- Patch Planner + Transactional Apply (Workstreams #4, #5).
- Proper ComfyUI subtyping check for `typesCompatible`.
