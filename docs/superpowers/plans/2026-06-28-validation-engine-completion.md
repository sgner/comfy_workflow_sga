# Validation Engine Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4 new validation rules (missing-model, missing-media, illegal-link, unsupported-structure) to the ComfyUI workflow validation engine, backed by a ModelIndex filesystem cache and a 10-fixture test corpus, using the modular Approach A architecture (spec §3).

**Architecture:** One file per concern, mirroring the existing `port-type-validator.ts` pattern. A new `model-index.ts` mirrors `node-def-index.ts`'s TTL cache + persistence but scans the filesystem instead of fetching HTTP. Shared graph helpers (`graph-utils.ts`) extract node/link traversal logic. An orchestrator (`validate-workflow.ts`) runs all validators in parallel and dedups by issue id.

**Tech Stack:** TypeScript 5.x, Node.js ESM (NodeNext), Vitest 2.1.9, native `fs/promises`, native `fetch`.

## Global Constraints

- TypeScript ESM: all relative imports use `.js` extensions even for `.ts` source.
- Node.js 20+. No new dependencies — use `fetch`, `fs/promises`, `path`.
- Tests: Vitest 2.1.9, colocated as `*.test.ts`. Run via `npm test` from `sga_template/`. Verify = `npm run typecheck && npm test`.
- Env vars: `SGA_MODEL_INDEX_TTL_MS` (default `300000`), `SGA_MAX_REROUTE_DEPTH` (default `8`), `SGA_NODE_DEF_INDEX_TTL_MS` (default `120000`, existing).
- `SGA_HOME` resolves via `getSgaHome()` from `sga_template/src/memory/paths.ts` (import as `../memory/paths.js`).
- `COMFYUI_BASE_DIR` points to the ComfyUI root (for ModelIndex filesystem scan).
- Atomic file writes: `.tmp` + `fs.rename` (existing pattern).
- No `console.log` — use `createLogger(...)` from `sga_template/src/utils/logger.ts`.
- ComfyUI graph JSON shape: `{ nodes: Array<{id, type, mode?, inputs?, outputs?, widgets_values?}>, links?: Array<[linkId, fromId, fromSlot, toId, toSlot, type]> }`.
- No degradation: when ComfyUI is offline or `COMFYUI_BASE_DIR` is unset, validators throw (per spec §6).

---

## Task 1: Shared Model Categories + Refactor comfyui-model-list.ts

**Files:**
- Create: `sga_template/src/comfyui/model-categories.ts`
- Modify: `sga_template/src/tools/built-in/comfyui-model-list.ts`

**Interfaces:**
- Produces: `MODEL_EXTENSIONS`, `MEDIA_EXTENSIONS`, `MODEL_CATEGORIES`, `MODEL_LOADER_MAPPING`, `MEDIA_LOADER_TYPES` from `./model-categories.js`.

- [ ] **Step 1.1: Create shared constants file** — Create `sga_template/src/comfyui/model-categories.ts`:

```ts
/**
 * Shared model/media category constants — used by both the ComfyUIModelList
 * tool and the missing-ref validator. Extracted from comfyui-model-list.ts
 * to avoid circular imports (tool → validator → model-index → tool).
 */

export const MODEL_EXTENSIONS = new Set([
  '.safetensors', '.ckpt', '.pt', '.bin', '.pth', '.onnx', '.engine',
])

export const MEDIA_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov', '.avi',
])

export const MODEL_CATEGORIES: Record<string, string[]> = {
  checkpoints: ['checkpoints'],
  loras: ['loras', 'lycoris'],
  vae: ['vae'],
  controlnet: ['controlnet', 'controlnets'],
  embeddings: ['embeddings', 'textual_inversion'],
  upscale_models: ['upscale_models', 'upscale', 'upscalers'],
  clip: ['clip', 'clip_vision'],
  unet: ['unet', 'diffusion_models'],
  style_models: ['style_models'],
  hypernetworks: ['hypernetworks', 'hypernetwork'],
  gligen: ['gligen'],
  vae_approx: ['vae_approx'],
  inpaint: ['inpaint', 'inpaint_models'],
  classifier: ['classifier'],
  diffusion_models: ['diffusion_models'],
  animatediff_models: ['animatediff_models'],
  animatediff_motion_lora: ['animatediff_motion_lora'],
}

/** Node type → (widget name, model category) for missing-model validation. */
export const MODEL_LOADER_MAPPING: Record<string, { widget: string; category: string }> = {
  CheckpointLoaderSimple: { widget: 'ckpt_name', category: 'checkpoints' },
  CheckpointLoader:       { widget: 'ckpt_name', category: 'checkpoints' },
  LoraLoader:             { widget: 'lora_name', category: 'loras' },
  LoraLoaderModelOnly:    { widget: 'lora_name', category: 'loras' },
  VAELoader:              { widget: 'vae_name', category: 'vae' },
  ControlNetLoader:       { widget: 'control_net_name', category: 'controlnet' },
  UpscaleModelLoader:     { widget: 'model_name', category: 'upscale_models' },
  CLIPLoader:             { widget: 'clip_name', category: 'clip' },
  CLIPVisionLoader:       { widget: 'clip_name', category: 'clip' },
  UNETLoader:             { widget: 'unet_name', category: 'unet' },
  UNETLoaderGGUF:         { widget: 'unet_name', category: 'unet' },
  HypernetworkLoader:     { widget: 'hypernetwork_name', category: 'hypernetworks' },
  GligenLoader:           { widget: 'gligen_name', category: 'gligen' },
  EmbeddingLoader:        { widget: 'embedding_name', category: 'embeddings' },
}

/** Node types that load media files from input/. */
export const MEDIA_LOADER_TYPES = new Set([
  'LoadImage', 'LoadImageMask', 'LoadImageBatch',
  'LoadVideo', 'VHS_LoadVideo', 'VHS_LoadVideoPath',
])
```

- [ ] **Step 1.2: Refactor comfyui-model-list.ts to import shared constants** — In `sga_template/src/tools/built-in/comfyui-model-list.ts`, replace lines 9-31 (the local `MODEL_EXTENSIONS` and `MODEL_CATEGORIES` declarations) with:

```ts
import { MODEL_EXTENSIONS, MODEL_CATEGORIES } from '../../comfyui/model-categories.js'
```

Remove the local `MODEL_EXTENSIONS` const (lines 9-11) and the local `MODEL_CATEGORIES` const (lines 13-31). Keep the rest of the file unchanged. The `getComfyUIBaseDir`, `scanModelDir`, `parseExtraModelPaths`, `formatSize`, and `ComfyUIModelListTool` functions remain as-is — they already reference `MODEL_EXTENSIONS` and `MODEL_CATEGORIES` by name, so the import resolves them.

- [ ] **Step 1.3: Run typecheck and full test suite** — `cd sga_template && npm run typecheck && npm test` → PASS (existing tests unaffected; constants are identical, just moved).

- [ ] **Step 1.4: Commit** — `git add sga_template/src/comfyui/model-categories.ts sga_template/src/tools/built-in/comfyui-model-list.ts && git commit -m "refactor(comfyui): extract shared model category constants to model-categories.ts"`

---

## Task 2: NodeDef Widget Extension + Issue Category Types

**Files:**
- Modify: `sga_template/src/comfyui/node-def-index.ts`
- Modify: `sga_template/src/comfyui/node-def-index.test.ts`
- Modify: `sga_template/src/comfyui/issue-types.ts`

**Interfaces:**
- Consumes: existing `NodeDef`, `normalize()` from `node-def-index.ts`.
- Produces: `NodeDefWidget` interface, extended `NodeDef.widgets` field, updated `IssueCategory` union with `'illegal_link'` and `'unsupported_structure'`, env-readable `NODE_DEF_INDEX_TTL_MS`.

- [ ] **Step 2.1: Write failing test for widget extraction** — In `sga_template/src/comfyui/node-def-index.test.ts`, add this test inside the `describe('node-def-index', ...)` block (after the last existing `it(...)`):

```ts
  it('extracts widget definitions from /object_info including combo options', async () => {
    const loaderInfo = {
      CheckpointLoaderSimple: {
        name: 'CheckpointLoaderSimple',
        category: 'loaders',
        input: {
          required: {
            ckpt_name: [['model1.safetensors', 'model2.safetensors']],
            config_name: ['STRING', { default: '', multiline: false }],
          },
        },
        output: ['MODEL', 'CLIP', 'VAE'],
        output_name: ['MODEL', 'CLIP', 'VAE'],
      },
      KSampler: {
        name: 'KSampler',
        category: 'sampling',
        input: {
          required: {
            seed: ['INT', { default: 0, min: 0, max: 18446744073709551615, step: 1 }],
            cfg: ['FLOAT', { default: 8.0, min: 0.0, max: 100.0, step: 0.1 }],
            sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m']],
            denoise: ['FLOAT', { default: 1.0 }],
          },
        },
        output: ['LATENT'],
        output_name: ['LATENT'],
      },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => loaderInfo,
    } as unknown as Response))
    const { getNodeDef } = await import('./node-def-index.js')

    const ckptDef = await getNodeDef('CheckpointLoaderSimple')
    expect(ckptDef?.widgets).toHaveLength(2)
    const ckptWidget = ckptDef?.widgets.find(w => w.name === 'ckpt_name')
    expect(ckptWidget?.type).toBe('combo')
    expect(ckptWidget?.options).toEqual(['model1.safetensors', 'model2.safetensors'])

    const kSamplerDef = await getNodeDef('KSampler')
    expect(kSamplerDef?.widgets).toHaveLength(4)
    const seedWidget = kSamplerDef?.widgets.find(w => w.name === 'seed')
    expect(seedWidget?.type).toBe('INT')
    expect(seedWidget?.defaultValue).toBe(0)
    expect(seedWidget?.min).toBe(0)
    expect(seedWidget?.max).toBe(18446744073709551615)
    expect(seedWidget?.step).toBe(1)
    const samplerWidget = kSamplerDef?.widgets.find(w => w.name === 'sampler_name')
    expect(samplerWidget?.type).toBe('combo')
    expect(samplerWidget?.options).toEqual(['euler', 'euler_ancestral', 'dpmpp_2m'])
  })

  it('honors SGA_NODE_DEF_INDEX_TTL_MS env override', async () => {
    vi.stubEnv('SGA_NODE_DEF_INDEX_TTL_MS', '5000')
    vi.resetModules()
    const { NODE_DEF_INDEX_TTL_MS } = await import('./node-def-index.js')
    expect(NODE_DEF_INDEX_TTL_MS).toBe(5000)
  })
```

- [ ] **Step 2.2: Run tests to verify they fail** — `cd sga_template && npm test -- src/comfyui/node-def-index.test.ts` → FAIL (widgets property does not exist on NodeDef; NODE_DEF_INDEX_TTL_MS is not env-readable).

- [ ] **Step 2.3: Add NodeDefWidget interface and extend NodeDef** — In `sga_template/src/comfyui/node-def-index.ts`:

Replace the `NodeDef` interface (lines 26-34) with:

```ts
export interface NodeDefWidget {
  name: string
  type: string            // "STRING" | "INT" | "FLOAT" | "BOOLEAN" | "combo"
  options?: string[]      // for combo widgets — the ComfyUI dropdown source
  defaultValue?: unknown
  min?: number
  max?: number
  step?: number
}

export interface NodeDef {
  name: string
  category: string
  description?: string
  inputs: Array<{ name: string; type: string; required: boolean }>
  outputs: Array<{ name: string; type: string }>
  widgets: NodeDefWidget[]   // extracted from /object_info input.required/optional
  deprecated?: boolean
  experimental?: boolean
}
```

Replace the TTL constant (line 22) with an env-readable version:

```ts
export const NODE_DEF_INDEX_TTL_MS = Number(process.env.SGA_NODE_DEF_INDEX_TTL_MS) || 120_000
```

- [ ] **Step 2.4: Update normalize() to extract widgets** — In `sga_template/src/comfyui/node-def-index.ts`, replace the `normalize()` function (lines 74-99) with:

```ts
function normalizeWidget(name: string, spec: [string | string[], ...unknown[]]): NodeDefWidget {
  const rawType = spec[0]
  const opts = spec[1]

  // Combo: type is an array of strings (the dropdown options)
  if (Array.isArray(rawType)) {
    return {
      name,
      type: 'combo',
      options: rawType,
      defaultValue: typeof opts === 'object' && opts !== null ? (opts as Record<string, unknown>).default : undefined,
    }
  }

  // Primitive widget: type is a string like "STRING", "INT", "FLOAT", "BOOLEAN"
  const widget: NodeDefWidget = { name, type: rawType }
  if (typeof opts === 'object' && opts !== null) {
    const o = opts as Record<string, unknown>
    if ('default' in o) widget.defaultValue = o.default
    if ('min' in o && typeof o.min === 'number') widget.min = o.min
    if ('max' in o && typeof o.max === 'number') widget.max = o.max
    if ('step' in o && typeof o.step === 'number') widget.step = o.step
  }
  return widget
}

function normalize(raw: ObjectInfoRaw): NodeDef {
  const inputs: NodeDef['inputs'] = []
  const widgets: NodeDefWidget[] = []
  const required = raw.input?.required ?? {}
  const optional = raw.input?.optional ?? {}
  for (const [name, spec] of Object.entries(required)) {
    inputs.push({ name, type: normalizeType(spec[0]), required: true })
    widgets.push(normalizeWidget(name, spec))
  }
  for (const [name, spec] of Object.entries(optional)) {
    inputs.push({ name, type: normalizeType(spec[0]), required: false })
    widgets.push(normalizeWidget(name, spec))
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
    widgets,
    deprecated: raw.deprecated,
    experimental: raw.experimental,
  }
}
```

- [ ] **Step 2.5: Add new issue categories to issue-types.ts** — In `sga_template/src/comfyui/issue-types.ts`, replace the `IssueCategory` union (lines 12-15) with:

```ts
export type IssueCategory =
  | 'missing_model' | 'missing_node' | 'missing_media' | 'runtime_error'
  | 'port_type_mismatch' | 'orphaned_output' | 'missing_required_widget'
  | 'invalid_link' | 'illegal_link' | 'unsupported_structure' | 'unknown_node_type'
```

- [ ] **Step 2.6: Run tests to verify they pass** — `cd sga_template && npm test -- src/comfyui/node-def-index.test.ts` → PASS (all 10 tests including 2 new ones).

- [ ] **Step 2.7: Run typecheck and full test suite** — `cd sga_template && npm run typecheck && npm test` → PASS (existing port-type-validator tests still pass — `widgets` is additive, existing code doesn't reference it).

- [ ] **Step 2.8: Commit** — `git add sga_template/src/comfyui/node-def-index.ts sga_template/src/comfyui/node-def-index.test.ts sga_template/src/comfyui/issue-types.ts && git commit -m "feat(comfyui): extend NodeDef with widgets field and add illegal_link/unsupported_structure categories"`

---

## Task 3: ModelIndex Module

**Files:**
- Create: `sga_template/src/comfyui/model-index.ts`
- Create: `sga_template/src/comfyui/model-index.test.ts`

**Interfaces:**
- Consumes: `MODEL_EXTENSIONS`, `MEDIA_EXTENSIONS`, `MODEL_CATEGORIES` from `./model-categories.js`; `getSgaHome` from `../memory/paths.js`; `createLogger` from `../utils/logger.js`.
- Produces: `ModelEntry`, `MediaEntry`, `ModelIndexStats`, `getModelFile(category, name)`, `getMediaFile(name)`, `listModels(category?)`, `listMediaFiles()`, `refreshModelIndex()`, `getModelIndexStats()`, `MODEL_INDEX_TTL_MS_DEFAULT`.

- [ ] **Step 3.1: Write failing tests** — Create `sga_template/src/comfyui/model-index.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

async function createModelFile(baseDir: string, category: string, name: string): Promise<void> {
  const dir = join(baseDir, 'models', category)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, name), 'fake model data')
}

async function createMediaFile(baseDir: string, name: string): Promise<void> {
  const dir = join(baseDir, 'input')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, name), 'fake image data')
}

describe('model-index', () => {
  let tmpHome: string
  let tmpBaseDir: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-model-idx-'))
    tmpBaseDir = await fs.mkdtemp(join(tmpdir(), 'sga-comfyui-'))
    vi.stubEnv('SGA_HOME', tmpHome)
    vi.stubEnv('COMFYUI_BASE_DIR', tmpBaseDir)
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fs.rm(tmpHome, { recursive: true, force: true })
    await fs.rm(tmpBaseDir, { recursive: true, force: true })
  })

  it('returns null when no models exist on disk', async () => {
    const { getModelFile, getModelIndexStats } = await import('./model-index.js')
    expect(await getModelFile('checkpoints', 'anything.safetensors')).toBeNull()
    expect(getModelIndexStats().source).toBe('fresh')
    expect(getModelIndexStats().size).toBe(0)
  })

  it('finds a model file by category and name', async () => {
    await createModelFile(tmpBaseDir, 'checkpoints', 'v1-5-pruned.safetensors')
    await createModelFile(tmpBaseDir, 'loras', 'style.safetensors')
    const { getModelFile } = await import('./model-index.js')
    const model = await getModelFile('checkpoints', 'v1-5-pruned.safetensors')
    expect(model).not.toBeNull()
    expect(model?.name).toBe('v1-5-pruned.safetensors')
    expect(model?.category).toBe('checkpoints')
    expect(model?.relativePath).toBe('checkpoints/v1-5-pruned.safetensors')
  })

  it('persists cache to <SGA_HOME>/model-index.json after scan', async () => {
    await createModelFile(tmpBaseDir, 'checkpoints', 'model1.safetensors')
    const { refreshModelIndex } = await import('./model-index.js')
    await refreshModelIndex()
    const raw = await fs.readFile(join(tmpHome, 'model-index.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.fetchedAt).toBeGreaterThan(0)
    expect(parsed.models.checkpoints[0].name).toBe('model1.safetensors')
  })

  it('loads from cache file on startup when fresh enough', async () => {
    const past = Date.now() - 10_000
    await fs.writeFile(join(tmpHome, 'model-index.json'), JSON.stringify({
      fetchedAt: past,
      models: { checkpoints: [{ name: 'cached.safetensors', category: 'checkpoints', relativePath: 'checkpoints/cached.safetensors', sizeBytes: 0 }] },
      media: [],
    }))
    // Remove the actual file from disk to prove cache is used
    const { getModelFile, getModelIndexStats } = await import('./model-index.js')
    const model = await getModelFile('checkpoints', 'cached.safetensors')
    expect(model?.name).toBe('cached.safetensors')
    expect(getModelIndexStats().source).toBe('cache-file')
  })

  it('re-scans when TTL has expired', async () => {
    const stale = Date.now() - 400_000
    await fs.writeFile(join(tmpHome, 'model-index.json'), JSON.stringify({
      fetchedAt: stale,
      models: { checkpoints: [{ name: 'stale.safetensors', category: 'checkpoints', relativePath: 'checkpoints/stale.safetensors', sizeBytes: 0 }] },
      media: [],
    }))
    await createModelFile(tmpBaseDir, 'checkpoints', 'fresh.safetensors')
    const { getModelFile } = await import('./model-index.js')
    const fresh = await getModelFile('checkpoints', 'fresh.safetensors')
    expect(fresh?.name).toBe('fresh.safetensors')
    const staleModel = await getModelFile('checkpoints', 'stale.safetensors')
    expect(staleModel).toBeNull()
  })

  it('finds media files in input/ recursively', async () => {
    await createMediaFile(tmpBaseDir, 'photo.png')
    const inputSubdir = join(tmpBaseDir, 'input', 'subfolder')
    await fs.mkdir(inputSubdir, { recursive: true })
    await fs.writeFile(join(inputSubdir, 'nested.jpg'), 'fake')
    const { getMediaFile, listMediaFiles } = await import('./model-index.js')
    const media = await getMediaFile('photo.png')
    expect(media?.name).toBe('photo.png')
    const nested = await getMediaFile('nested.jpg')
    expect(nested?.relativePath).toBe('subfolder/nested.jpg')
    const all = await listMediaFiles()
    expect(all).toHaveLength(2)
  })
})
```

- [ ] **Step 3.2: Run tests to verify they fail** — `cd sga_template && npm test -- src/comfyui/model-index.test.ts` → FAIL (module not found).

- [ ] **Step 3.3: Write implementation** — Create `sga_template/src/comfyui/model-index.ts`:

```ts
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
```

- [ ] **Step 3.4: Run tests to verify they pass** — `cd sga_template && npm test -- src/comfyui/model-index.test.ts` → PASS (6 tests).

- [ ] **Step 3.5: Run typecheck and full test suite** — `cd sga_template && npm run typecheck && npm test` → PASS.

- [ ] **Step 3.6: Commit** — `git add sga_template/src/comfyui/model-index.ts sga_template/src/comfyui/model-index.test.ts && git commit -m "feat(comfyui): add ModelIndex with filesystem scan and TTL cache"`

---

## Task 4: Graph Utils

**Files:**
- Create: `sga_template/src/comfyui/graph-utils.ts`
- Create: `sga_template/src/comfyui/graph-utils.test.ts`

**Interfaces:**
- Consumes: `NodeDef` from `./node-def-index.js`.
- Produces: `GraphNodeContext`, `GraphLink`, `buildNodeMap(workflow)`, `buildLinkList(workflow)`, `isReroute(node)`, `isPrimitive(node)`, `isNote(node)`.

- [ ] **Step 4.1: Write failing tests** — Create `sga_template/src/comfyui/graph-utils.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

function makeWorkflow(nodes: any[], links: any[]) {
  return { nodes, links, last_node_id: nodes.length, last_link_id: links.length }
}

describe('graph-utils', () => {
  it('buildNodeMap indexes nodes by numeric id with null def', async () => {
    const { buildNodeMap } = await import('./graph-utils.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'KSampler' },
        { id: 2, type: 'CLIPTextEncode' },
      ],
      [],
    )
    const map = buildNodeMap(wf)
    expect(map.size).toBe(2)
    expect(map.get(1)?.node.type).toBe('KSampler')
    expect(map.get(1)?.def).toBeNull()
    expect(map.get(2)?.id).toBe(2)
  })

  it('buildNodeMap skips nodes without id', async () => {
    const { buildNodeMap } = await import('./graph-utils.js')
    const wf = makeWorkflow([{ id: 1, type: 'X' }, { type: 'NoId' }], [])
    const map = buildNodeMap(wf)
    expect(map.size).toBe(1)
  })

  it('buildLinkList parses link arrays into GraphLink objects', async () => {
    const { buildLinkList } = await import('./graph-utils.js')
    const wf = makeWorkflow([], [
      [1, 10, 0, 20, 1, 'MODEL'],
      [2, 11, 0, 21, 0, 'CONDITIONING'],
    ])
    const links = buildLinkList(wf)
    expect(links).toHaveLength(2)
    expect(links[0]).toEqual({
      id: 1, fromNodeId: 10, fromSlot: 0, toNodeId: 20, toSlot: 1, type: 'MODEL',
    })
  })

  it('buildLinkList skips malformed links', async () => {
    const { buildLinkList } = await import('./graph-utils.js')
    const wf = makeWorkflow([], [
      [1, 10, 0, 20, 1, 'MODEL'],
      [2, 11],  // too short
      'not-an-array',
    ])
    const links = buildLinkList(wf)
    expect(links).toHaveLength(1)
  })

  it('isReroute, isPrimitive, isNote identify node types', async () => {
    const { isReroute, isPrimitive, isNote } = await import('./graph-utils.js')
    expect(isReroute({ type: 'Reroute' })).toBe(true)
    expect(isReroute({ type: 'KSampler' })).toBe(false)
    expect(isPrimitive({ type: 'PrimitiveNode' })).toBe(true)
    expect(isPrimitive({ type: 'Reroute' })).toBe(false)
    expect(isNote({ type: 'Note' })).toBe(true)
    expect(isNote({ type: 'PrimitiveNode' })).toBe(false)
  })
})
```

- [ ] **Step 4.2: Run tests to verify they fail** — `cd sga_template && npm test -- src/comfyui/graph-utils.test.ts` → FAIL (module not found).

- [ ] **Step 4.3: Write implementation** — Create `sga_template/src/comfyui/graph-utils.ts`:

```ts
/**
 * Shared graph traversal helpers — used by all validators to avoid
 * duplicating node/link parsing logic.
 *
 * buildNodeMap does NOT trigger NodeDefIndex loads — every node's def
 * starts as null. Consumers that need the NodeDef call await getNodeDef()
 * themselves (validator-scoped async, deduplicated by NodeDefIndex's
 * single-flight).
 */
import type { NodeDef } from './node-def-index.js'

interface GraphNode {
  id: number | string
  type: string
  mode?: number
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
  widgets_values?: unknown[]
}

export interface GraphNodeContext {
  node: GraphNode
  def: NodeDef | null   // null until a validator populates it
  id: number
}

export interface GraphLink {
  id: number
  fromNodeId: number
  fromSlot: number
  toNodeId: number
  toSlot: number
  type: string | number
}

export function buildNodeMap(workflow: Record<string, unknown>): Map<number, GraphNodeContext> {
  const nodes = ((workflow.nodes as GraphNode[] | undefined) ?? [])
    .filter(n => n && typeof n.id !== 'undefined')
  const map = new Map<number, GraphNodeContext>()
  for (const node of nodes) {
    const id = typeof node.id === 'number' ? node.id : Number(node.id)
    if (!Number.isNaN(id)) {
      map.set(id, { node, def: null, id })
    }
  }
  return map
}

export function buildLinkList(workflow: Record<string, unknown>): GraphLink[] {
  const rawLinks = ((workflow.links as unknown[] | undefined) ?? [])
  const links: GraphLink[] = []
  for (const raw of rawLinks) {
    if (!Array.isArray(raw) || raw.length < 6) continue
    const [id, fromNodeId, fromSlot, toNodeId, toSlot, type] = raw
    if (typeof id !== 'number' || typeof fromSlot !== 'number' || typeof toSlot !== 'number') continue
    links.push({
      id,
      fromNodeId: typeof fromNodeId === 'number' ? fromNodeId : Number(fromNodeId),
      fromSlot,
      toNodeId: typeof toNodeId === 'number' ? toNodeId : Number(toNodeId),
      toSlot,
      type: typeof type === 'string' ? type : String(type),
    })
  }
  return links
}

export function isReroute(node: Record<string, unknown>): boolean {
  return node.type === 'Reroute'
}

export function isPrimitive(node: Record<string, unknown>): boolean {
  return node.type === 'PrimitiveNode'
}

export function isNote(node: Record<string, unknown>): boolean {
  return node.type === 'Note'
}
```

- [ ] **Step 4.4: Run tests to verify they pass** — `cd sga_template && npm test -- src/comfyui/graph-utils.test.ts` → PASS (5 tests).

- [ ] **Step 4.5: Run typecheck and full test suite** — `cd sga_template && npm run typecheck && npm test` → PASS.

- [ ] **Step 4.6: Commit** — `git add sga_template/src/comfyui/graph-utils.ts sga_template/src/comfyui/graph-utils.test.ts && git commit -m "feat(comfyui): add shared graph-utils with buildNodeMap and buildLinkList"`

---

## Task 5: Fixture Corpus + Fixture Loader

**Files:**
- Create: `sga_template/src/comfyui/validators/__fixtures__/txt2img-basic.json`
- Create: `sga_template/src/comfyui/validators/__fixtures__/img2img-basic.json`
- Create: `sga_template/src/comfyui/validators/__fixtures__/controlnet-basic.json`
- Create: `sga_template/src/comfyui/validators/__fixtures__/lora-stack.json`
- Create: `sga_template/src/comfyui/validators/__fixtures__/multi-output.json`
- Create: `sga_template/src/comfyui/validators/__fixtures__/missing-model.json`
- Create: `sga_template/src/comfyui/validators/__fixtures__/missing-custom-node.json`
- Create: `sga_template/src/comfyui/validators/__fixtures__/malformed-links.json`
- Create: `sga_template/src/comfyui/validators/__fixtures__/widget-schema-mismatch.json`
- Create: `sga_template/src/comfyui/validators/__fixtures__/reroute-chain-deep.json`
- Create: `sga_template/src/comfyui/validators/fixture-loader.ts`
- Create: `sga_template/src/comfyui/validators/fixture-loader.test.ts`

**Interfaces:**
- Produces: `LoadedFixture` interface, `loadFixture(name)`, `listFixtures()`.

- [ ] **Step 5.1: Write failing test for fixture-loader** — Create `sga_template/src/comfyui/validators/fixture-loader.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

describe('fixture-loader', () => {
  it('loads all 10 fixtures with required fields', async () => {
    const { loadFixture, listFixtures } = await import('./fixture-loader.js')
    const names = listFixtures()
    expect(names).toHaveLength(10)
    expect(names).toContain('txt2img-basic')
    expect(names).toContain('missing-model')
    expect(names).toContain('reroute-chain-deep')

    for (const name of names) {
      const fixture = loadFixture(name)
      expect(fixture.name).toBe(name)
      expect(typeof fixture.description).toBe('string')
      expect(fixture.objectInfo).toBeTypeOf('object')
      expect(fixture.workflow).toBeTypeOf('object')
      expect(Array.isArray(fixture.workflow.nodes)).toBe(true)
      expect(Array.isArray(fixture.workflow.links)).toBe(true)
      expect(Array.isArray(fixture.expectedIssueIds)).toBe(true)
      expect(typeof fixture.models).toBe('object')
      expect(Array.isArray(fixture.input)).toBe(true)
    }
  })
})
```

- [ ] **Step 5.2: Run test to verify it fails** — `cd sga_template && npm test -- src/comfyui/validators/fixture-loader.test.ts` → FAIL (module not found).

- [ ] **Step 5.3: Create the 10 fixture JSON files**

Create `sga_template/src/comfyui/validators/__fixtures__/txt2img-basic.json`:

```json
{
  "name": "txt2img-basic",
  "description": "Standard txt2img workflow with CLIPTextEncode, KSampler, VAEDecode, SaveImage",
  "objectInfo": {
    "CheckpointLoaderSimple": {
      "name": "CheckpointLoaderSimple", "category": "loaders",
      "input": { "required": { "ckpt_name": [["v1-5-pruned-emaonly.safetensors"]] } },
      "output": ["MODEL", "CLIP", "VAE"], "output_name": ["MODEL", "CLIP", "VAE"]
    },
    "CLIPTextEncode": {
      "name": "CLIPTextEncode", "category": "conditioning",
      "input": { "required": { "text": ["STRING"], "clip": ["CLIP"] } },
      "output": ["CONDITIONING"], "output_name": ["CONDITIONING"]
    },
    "KSampler": {
      "name": "KSampler", "category": "sampling",
      "input": { "required": { "model": ["MODEL"], "positive": ["CONDITIONING"], "negative": ["CONDITIONING"], "latent_image": ["LATENT"], "seed": ["INT"] } },
      "output": ["LATENT"], "output_name": ["LATENT"]
    },
    "VAEDecode": {
      "name": "VAEDecode", "category": "latent",
      "input": { "required": { "samples": ["LATENT"], "vae": ["VAE"] } },
      "output": ["IMAGE"], "output_name": ["IMAGE"]
    },
    "SaveImage": {
      "name": "SaveImage", "category": "image",
      "input": { "required": { "images": ["IMAGE"], "filename_prefix": ["STRING"] } },
      "output": [], "output_name": []
    }
  },
  "models": { "checkpoints": ["v1-5-pruned-emaonly.safetensors"] },
  "input": [],
  "workflow": {
    "nodes": [
      { "id": 1, "type": "CheckpointLoaderSimple", "widgets_values": ["v1-5-pruned-emaonly.safetensors"],
        "outputs": [ { "name": "MODEL", "type": "MODEL", "links": [1] }, { "name": "CLIP", "type": "CLIP", "links": [2, 3] }, { "name": "VAE", "type": "VAE", "links": [5] } ] },
      { "id": 2, "type": "CLIPTextEncode", "widgets_values": ["positive prompt"],
        "inputs": [ { "name": "clip", "type": "CLIP", "link": 2 } ],
        "outputs": [ { "name": "CONDITIONING", "type": "CONDITIONING", "links": [4] } ] },
      { "id": 3, "type": "CLIPTextEncode", "widgets_values": ["negative prompt"],
        "inputs": [ { "name": "clip", "type": "CLIP", "link": 3 } ],
        "outputs": [ { "name": "CONDITIONING", "type": "CONDITIONING", "links": [6] } ] },
      { "id": 4, "type": "KSampler", "widgets_values": [0, 8, "euler", "normal", 1],
        "inputs": [ { "name": "model", "type": "MODEL", "link": 1 }, { "name": "positive", "type": "CONDITIONING", "link": 4 }, { "name": "negative", "type": "CONDITIONING", "link": 6 }, { "name": "latent_image", "type": "LATENT", "link": null } ],
        "outputs": [ { "name": "LATENT", "type": "LATENT", "links": [7] } ] },
      { "id": 5, "type": "VAEDecode",
        "inputs": [ { "name": "samples", "type": "LATENT", "link": 7 }, { "name": "vae", "type": "VAE", "link": 5 } ],
        "outputs": [ { "name": "IMAGE", "type": "IMAGE", "links": [8] } ] },
      { "id": 6, "type": "SaveImage", "widgets_values": ["output"],
        "inputs": [ { "name": "images", "type": "IMAGE", "link": 8 } ] }
    ],
    "links": [
      [1, 1, 0, 4, 0, "MODEL"],
      [2, 1, 1, 2, 0, "CLIP"],
      [3, 1, 1, 3, 0, "CLIP"],
      [4, 2, 0, 4, 1, "CONDITIONING"],
      [5, 1, 2, 5, 1, "VAE"],
      [6, 3, 0, 4, 2, "CONDITIONING"],
      [7, 4, 0, 5, 0, "LATENT"],
      [8, 5, 0, 6, 0, "IMAGE"]
    ]
  },
  "expectedIssueIds": []
}
```

Create `sga_template/src/comfyui/validators/__fixtures__/img2img-basic.json`:

```json
{
  "name": "img2img-basic",
  "description": "Standard img2img workflow with LoadImage, KSampler, VAEDecode, SaveImage",
  "objectInfo": {
    "LoadImage": {
      "name": "LoadImage", "category": "image",
      "input": { "required": { "image": ["STRING"] } },
      "output": ["IMAGE", "MASK"], "output_name": ["IMAGE", "MASK"]
    },
    "CheckpointLoaderSimple": {
      "name": "CheckpointLoaderSimple", "category": "loaders",
      "input": { "required": { "ckpt_name": [["v1-5-pruned-emaonly.safetensors"]] } },
      "output": ["MODEL", "CLIP", "VAE"], "output_name": ["MODEL", "CLIP", "VAE"]
    },
    "VAEDecode": {
      "name": "VAEDecode", "category": "latent",
      "input": { "required": { "samples": ["LATENT"], "vae": ["VAE"] } },
      "output": ["IMAGE"], "output_name": ["IMAGE"]
    },
    "SaveImage": {
      "name": "SaveImage", "category": "image",
      "input": { "required": { "images": ["IMAGE"] } },
      "output": [], "output_name": []
    }
  },
  "models": { "checkpoints": ["v1-5-pruned-emaonly.safetensors"] },
  "input": ["example.png"],
  "workflow": {
    "nodes": [
      { "id": 1, "type": "LoadImage", "widgets_values": ["example.png"],
        "outputs": [ { "name": "IMAGE", "type": "IMAGE", "links": [1] }, { "name": "MASK", "type": "MASK", "links": null } ] },
      { "id": 2, "type": "CheckpointLoaderSimple", "widgets_values": ["v1-5-pruned-emaonly.safetensors"],
        "outputs": [ { "name": "MODEL", "type": "MODEL", "links": [2] }, { "name": "CLIP", "type": "CLIP", "links": null }, { "name": "VAE", "type": "VAE", "links": [3] } ] },
      { "id": 3, "type": "KSampler", "widgets_values": [0, 8, "euler", "normal", 0.7],
        "inputs": [ { "name": "model", "type": "MODEL", "link": 2 } ],
        "outputs": [ { "name": "LATENT", "type": "LATENT", "links": [4] } ] },
      { "id": 4, "type": "VAEDecode",
        "inputs": [ { "name": "samples", "type": "LATENT", "link": 4 }, { "name": "vae", "type": "VAE", "link": 3 } ],
        "outputs": [ { "name": "IMAGE", "type": "IMAGE", "links": [5] } ] },
      { "id": 5, "type": "SaveImage", "widgets_values": ["output"],
        "inputs": [ { "name": "images", "type": "IMAGE", "link": 5 } ] }
    ],
    "links": [
      [1, 1, 0, 3, 0, "IMAGE"],
      [2, 2, 0, 3, 0, "MODEL"],
      [3, 2, 2, 4, 1, "VAE"],
      [4, 3, 0, 4, 0, "LATENT"],
      [5, 4, 0, 5, 0, "IMAGE"]
    ]
  },
  "expectedIssueIds": []
}
```

Create `sga_template/src/comfyui/validators/__fixtures__/controlnet-basic.json`:

```json
{
  "name": "controlnet-basic",
  "description": "Clean workflow with ControlNetLoader and ControlNetApply",
  "objectInfo": {
    "ControlNetLoader": {
      "name": "ControlNetLoader", "category": "loaders",
      "input": { "required": { "control_net_name": [["control_v11p_sd15_canny.pth"]] } },
      "output": ["CONTROL_NET"], "output_name": ["CONTROL_NET"]
    },
    "CheckpointLoaderSimple": {
      "name": "CheckpointLoaderSimple", "category": "loaders",
      "input": { "required": { "ckpt_name": [["v1-5-pruned-emaonly.safetensors"]] } },
      "output": ["MODEL", "CLIP", "VAE"], "output_name": ["MODEL", "CLIP", "VAE"]
    }
  },
  "models": { "checkpoints": ["v1-5-pruned-emaonly.safetensors"], "controlnet": ["control_v11p_sd15_canny.pth"] },
  "input": [],
  "workflow": {
    "nodes": [
      { "id": 1, "type": "CheckpointLoaderSimple", "widgets_values": ["v1-5-pruned-emaonly.safetensors"],
        "outputs": [ { "name": "MODEL", "type": "MODEL", "links": [1] }, { "name": "CLIP", "type": "CLIP", "links": null }, { "name": "VAE", "type": "VAE", "links": null } ] },
      { "id": 2, "type": "ControlNetLoader", "widgets_values": ["control_v11p_sd15_canny.pth"],
        "outputs": [ { "name": "CONTROL_NET", "type": "CONTROL_NET", "links": [2] } ] }
    ],
    "links": [
      [1, 1, 0, 2, 0, "MODEL"],
      [2, 2, 0, 1, 0, "CONTROL_NET"]
    ]
  },
  "expectedIssueIds": []
}
```

Create `sga_template/src/comfyui/validators/__fixtures__/lora-stack.json`:

```json
{
  "name": "lora-stack",
  "description": "Multiple LoraLoaders stacked on a CheckpointLoaderSimple",
  "objectInfo": {
    "CheckpointLoaderSimple": {
      "name": "CheckpointLoaderSimple", "category": "loaders",
      "input": { "required": { "ckpt_name": [["v1-5-pruned-emaonly.safetensors"]] } },
      "output": ["MODEL", "CLIP", "VAE"], "output_name": ["MODEL", "CLIP", "VAE"]
    },
    "LoraLoader": {
      "name": "LoraLoader", "category": "loaders",
      "input": { "required": { "model": ["MODEL"], "clip": ["CLIP"], "lora_name": [["style.safetensors", "detail.safetensors"]], "strength_model": ["FLOAT"], "strength_clip": ["FLOAT"] } },
      "output": ["MODEL", "CLIP"], "output_name": ["MODEL", "CLIP"]
    }
  },
  "models": { "checkpoints": ["v1-5-pruned-emaonly.safetensors"], "loras": ["style.safetensors", "detail.safetensors"] },
  "input": [],
  "workflow": {
    "nodes": [
      { "id": 1, "type": "CheckpointLoaderSimple", "widgets_values": ["v1-5-pruned-emaonly.safetensors"],
        "outputs": [ { "name": "MODEL", "type": "MODEL", "links": [1] }, { "name": "CLIP", "type": "CLIP", "links": [2] }, { "name": "VAE", "type": "VAE", "links": null } ] },
      { "id": 2, "type": "LoraLoader", "widgets_values": ["style.safetensors", 0.8, 0.8],
        "inputs": [ { "name": "model", "type": "MODEL", "link": 1 }, { "name": "clip", "type": "CLIP", "link": 2 } ],
        "outputs": [ { "name": "MODEL", "type": "MODEL", "links": [3] }, { "name": "CLIP", "type": "CLIP", "links": [4] } ] },
      { "id": 3, "type": "LoraLoader", "widgets_values": ["detail.safetensors", 0.5, 0.5],
        "inputs": [ { "name": "model", "type": "MODEL", "link": 3 }, { "name": "clip", "type": "CLIP", "link": 4 } ],
        "outputs": [ { "name": "MODEL", "type": "MODEL", "links": null }, { "name": "CLIP", "type": "CLIP", "links": null } ] }
    ],
    "links": [
      [1, 1, 0, 2, 0, "MODEL"],
      [2, 1, 1, 2, 1, "CLIP"],
      [3, 2, 0, 3, 0, "MODEL"],
      [4, 2, 1, 3, 1, "CLIP"]
    ]
  },
  "expectedIssueIds": []
}
```

Create `sga_template/src/comfyui/validators/__fixtures__/multi-output.json`:

```json
{
  "name": "multi-output",
  "description": "KSampler branches to two SaveImage nodes",
  "objectInfo": {
    "CheckpointLoaderSimple": {
      "name": "CheckpointLoaderSimple", "category": "loaders",
      "input": { "required": { "ckpt_name": [["v1-5-pruned-emaonly.safetensors"]] } },
      "output": ["MODEL", "CLIP", "VAE"], "output_name": ["MODEL", "CLIP", "VAE"]
    },
    "VAEDecode": {
      "name": "VAEDecode", "category": "latent",
      "input": { "required": { "samples": ["LATENT"], "vae": ["VAE"] } },
      "output": ["IMAGE"], "output_name": ["IMAGE"]
    },
    "SaveImage": {
      "name": "SaveImage", "category": "image",
      "input": { "required": { "images": ["IMAGE"] } },
      "output": [], "output_name": []
    }
  },
  "models": { "checkpoints": ["v1-5-pruned-emaonly.safetensors"] },
  "input": [],
  "workflow": {
    "nodes": [
      { "id": 1, "type": "CheckpointLoaderSimple", "widgets_values": ["v1-5-pruned-emaonly.safetensors"],
        "outputs": [ { "name": "MODEL", "type": "MODEL", "links": [1] }, { "name": "CLIP", "type": "CLIP", "links": null }, { "name": "VAE", "type": "VAE", "links": [3] } ] },
      { "id": 2, "type": "VAEDecode",
        "inputs": [ { "name": "vae", "type": "VAE", "link": 3 } ],
        "outputs": [ { "name": "IMAGE", "type": "IMAGE", "links": [4, 5] } ] },
      { "id": 3, "type": "SaveImage", "widgets_values": ["output_a"],
        "inputs": [ { "name": "images", "type": "IMAGE", "link": 4 } ] },
      { "id": 4, "type": "SaveImage", "widgets_values": ["output_b"],
        "inputs": [ { "name": "images", "type": "IMAGE", "link": 5 } ] }
    ],
    "links": [
      [1, 1, 0, 2, 0, "MODEL"],
      [3, 1, 2, 2, 1, "VAE"],
      [4, 2, 0, 3, 0, "IMAGE"],
      [5, 2, 0, 4, 0, "IMAGE"]
    ]
  },
  "expectedIssueIds": []
}
```

Create `sga_template/src/comfyui/validators/__fixtures__/missing-model.json`:

```json
{
  "name": "missing-model",
  "description": "CheckpointLoaderSimple references a non-existent checkpoint file",
  "objectInfo": {
    "CheckpointLoaderSimple": {
      "name": "CheckpointLoaderSimple", "category": "loaders",
      "input": { "required": { "ckpt_name": [["v1-5-pruned-emaonly.safetensors", "nonexistent.safetensors"]] } },
      "output": ["MODEL", "CLIP", "VAE"], "output_name": ["MODEL", "CLIP", "VAE"]
    }
  },
  "models": { "checkpoints": ["v1-5-pruned-emaonly.safetensors"] },
  "input": [],
  "workflow": {
    "nodes": [
      { "id": 1, "type": "CheckpointLoaderSimple", "widgets_values": ["nonexistent.safetensors"],
        "outputs": [ { "name": "MODEL", "type": "MODEL", "links": null }, { "name": "CLIP", "type": "CLIP", "links": null }, { "name": "VAE", "type": "VAE", "links": null } ] }
    ],
    "links": []
  },
  "expectedIssueIds": ["missing_model:1"]
}
```

Create `sga_template/src/comfyui/validators/__fixtures__/missing-custom-node.json`:

```json
{
  "name": "missing-custom-node",
  "description": "Workflow uses CustomNode_X which is not in object_info",
  "objectInfo": {
    "CheckpointLoaderSimple": {
      "name": "CheckpointLoaderSimple", "category": "loaders",
      "input": { "required": { "ckpt_name": [["v1-5-pruned-emaonly.safetensors"]] } },
      "output": ["MODEL", "CLIP", "VAE"], "output_name": ["MODEL", "CLIP", "VAE"]
    }
  },
  "models": { "checkpoints": ["v1-5-pruned-emaonly.safetensors"] },
  "input": [],
  "workflow": {
    "nodes": [
      { "id": 1, "type": "CheckpointLoaderSimple", "widgets_values": ["v1-5-pruned-emaonly.safetensors"],
        "outputs": [ { "name": "MODEL", "type": "MODEL", "links": [1] } ] },
      { "id": 2, "type": "CustomNode_X",
        "inputs": [ { "name": "model", "type": "MODEL", "link": 1 } ] }
    ],
    "links": [
      [1, 1, 0, 2, 0, "MODEL"]
    ]
  },
  "expectedIssueIds": ["unknown_node_type:2:CustomNode_X"]
}
```

Create `sga_template/src/comfyui/validators/__fixtures__/malformed-links.json`:

```json
{
  "name": "malformed-links",
  "description": "Links with dangling reference, slot OOB, bidirectional inconsistency, and self-loop",
  "objectInfo": {
    "CLIPTextEncode": {
      "name": "CLIPTextEncode", "category": "conditioning",
      "input": { "required": { "text": ["STRING"], "clip": ["CLIP"] } },
      "output": ["CONDITIONING"], "output_name": ["CONDITIONING"]
    }
  },
  "models": {},
  "input": [],
  "workflow": {
    "nodes": [
      { "id": 1, "type": "CLIPTextEncode", "widgets_values": ["prompt"],
        "inputs": [ { "name": "clip", "type": "CLIP", "link": null } ],
        "outputs": [ { "name": "CONDITIONING", "type": "CONDITIONING", "links": [1] } ] },
      { "id": 2, "type": "CLIPTextEncode", "widgets_values": ["prompt"],
        "inputs": [ { "name": "clip", "type": "CLIP", "link": null } ],
        "outputs": [ { "name": "CONDITIONING", "type": "CONDITIONING", "links": [3] } ] }
    ],
    "links": [
      [1, 1, 0, 99, 0, "CONDITIONING"],
      [2, 1, 5, 2, 0, "CONDITIONING"],
      [3, 2, 0, 2, 0, "CONDITIONING"]
    ]
  },
  "expectedIssueIds": [
    "illegal_link:1:dangling",
    "illegal_link:2:slot_oob",
    "illegal_link:3:self_loop"
  ]
}
```

Create `sga_template/src/comfyui/validators/__fixtures__/widget-schema-mismatch.json`:

```json
{
  "name": "widget-schema-mismatch",
  "description": "PrimitiveNode output connected to inputs of different types (STRING and INT)",
  "objectInfo": {
    "PrimitiveNode": {
      "name": "PrimitiveNode", "category": "utils",
      "input": { "required": { "value": ["STRING"] } },
      "output": ["*"], "output_name": ["*"]
    },
    "CLIPTextEncode": {
      "name": "CLIPTextEncode", "category": "conditioning",
      "input": { "required": { "text": ["STRING"], "clip": ["CLIP"] } },
      "output": ["CONDITIONING"], "output_name": ["CONDITIONING"]
    },
    "KSampler": {
      "name": "KSampler", "category": "sampling",
      "input": { "required": { "model": ["MODEL"], "positive": ["CONDITIONING"], "negative": ["CONDITIONING"], "latent_image": ["LATENT"], "seed": ["INT"] } },
      "output": ["LATENT"], "output_name": ["LATENT"]
    }
  },
  "models": {},
  "input": [],
  "workflow": {
    "nodes": [
      { "id": 1, "type": "PrimitiveNode", "widgets_values": ["hello"],
        "outputs": [ { "name": "*", "type": "*", "links": [1, 2] } ] },
      { "id": 2, "type": "CLIPTextEncode",
        "inputs": [ { "name": "text", "type": "STRING", "link": 1 }, { "name": "clip", "type": "CLIP", "link": null } ] },
      { "id": 3, "type": "KSampler",
        "inputs": [ { "name": "seed", "type": "INT", "link": 2 } ] }
    ],
    "links": [
      [1, 1, 0, 2, 0, "STRING"],
      [2, 1, 0, 3, 4, "INT"]
    ]
  },
  "expectedIssueIds": ["unsupported_structure:1:primitive_multi_type"]
}
```

Create `sga_template/src/comfyui/validators/__fixtures__/reroute-chain-deep.json`:

```json
{
  "name": "reroute-chain-deep",
  "description": "10-deep Reroute chain exceeding SGA_MAX_REROUTE_DEPTH default of 8",
  "objectInfo": {
    "Reroute": {
      "name": "Reroute", "category": "utils",
      "input": { "required": {} },
      "output": ["*"], "output_name": ["*"]
    },
    "SaveImage": {
      "name": "SaveImage", "category": "image",
      "input": { "required": { "images": ["IMAGE"] } },
      "output": [], "output_name": []
    }
  },
  "models": {},
  "input": [],
  "workflow": {
    "nodes": [
      { "id": 1, "type": "Reroute", "inputs": [ { "name": "*", "type": "*", "link": null } ], "outputs": [ { "name": "*", "type": "*", "links": [1] } ] },
      { "id": 2, "type": "Reroute", "inputs": [ { "name": "*", "type": "*", "link": 1 } ], "outputs": [ { "name": "*", "type": "*", "links": [2] } ] },
      { "id": 3, "type": "Reroute", "inputs": [ { "name": "*", "type": "*", "link": 2 } ], "outputs": [ { "name": "*", "type": "*", "links": [3] } ] },
      { "id": 4, "type": "Reroute", "inputs": [ { "name": "*", "type": "*", "link": 3 } ], "outputs": [ { "name": "*", "type": "*", "links": [4] } ] },
      { "id": 5, "type": "Reroute", "inputs": [ { "name": "*", "type": "*", "link": 4 } ], "outputs": [ { "name": "*", "type": "*", "links": [5] } ] },
      { "id": 6, "type": "Reroute", "inputs": [ { "name": "*", "type": "*", "link": 5 } ], "outputs": [ { "name": "*", "type": "*", "links": [6] } ] },
      { "id": 7, "type": "Reroute", "inputs": [ { "name": "*", "type": "*", "link": 6 } ], "outputs": [ { "name": "*", "type": "*", "links": [7] } ] },
      { "id": 8, "type": "Reroute", "inputs": [ { "name": "*", "type": "*", "link": 7 } ], "outputs": [ { "name": "*", "type": "*", "links": [8] } ] },
      { "id": 9, "type": "Reroute", "inputs": [ { "name": "*", "type": "*", "link": 8 } ], "outputs": [ { "name": "*", "type": "*", "links": [9] } ] },
      { "id": 10, "type": "Reroute", "inputs": [ { "name": "*", "type": "*", "link": 9 } ], "outputs": [ { "name": "*", "type": "*", "links": [10] } ] },
      { "id": 11, "type": "SaveImage", "widgets_values": ["output"], "inputs": [ { "name": "images", "type": "IMAGE", "link": 10 } ] }
    ],
    "links": [
      [1, 1, 0, 2, 0, "*"],
      [2, 2, 0, 3, 0, "*"],
      [3, 3, 0, 4, 0, "*"],
      [4, 4, 0, 5, 0, "*"],
      [5, 5, 0, 6, 0, "*"],
      [6, 6, 0, 7, 0, "*"],
      [7, 7, 0, 8, 0, "*"],
      [8, 8, 0, 9, 0, "*"],
      [9, 9, 0, 10, 0, "*"],
      [10, 10, 0, 11, 0, "*"]
    ]
  },
  "expectedIssueIds": ["unsupported_structure:1:deep_reroute_chain"]
}
```

- [ ] **Step 5.4: Write fixture-loader implementation** — Create `sga_template/src/comfyui/validators/fixture-loader.ts`:

```ts
/**
 * Fixture loader — reads and parses JSON test fixtures from __fixtures__/.
 * Each fixture contains a workflow, object_info stub, model list, and
 * expected issue ids for validator tests.
 */
import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, '__fixtures__')

export interface LoadedFixture {
  name: string
  description: string
  objectInfo: Record<string, unknown>
  models: Record<string, string[]>
  input: string[]
  workflow: Record<string, unknown>
  expectedIssueIds: string[]
}

export function loadFixture(name: string): LoadedFixture {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8')
  return JSON.parse(raw) as LoadedFixture
}

export function listFixtures(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
    .sort()
}
```

- [ ] **Step 5.5: Run test to verify it passes** — `cd sga_template && npm test -- src/comfyui/validators/fixture-loader.test.ts` → PASS (1 test, all 10 fixtures load).

- [ ] **Step 5.6: Run typecheck and full test suite** — `cd sga_template && npm run typecheck && npm test` → PASS.

- [ ] **Step 5.7: Commit** — `git add sga_template/src/comfyui/validators/__fixtures__/ sga_template/src/comfyui/validators/fixture-loader.ts sga_template/src/comfyui/validators/fixture-loader.test.ts && git commit -m "test(comfyui): add 10-fixture corpus and fixture-loader for validator tests"`

---

## Task 6: Missing-Reference Validator (Model + Media)

**Files:**
- Create: `sga_template/src/comfyui/validators/missing-ref-validator.ts`
- Create: `sga_template/src/comfyui/validators/missing-ref-validator.test.ts`

**Interfaces:**
- Consumes: `MODEL_LOADER_MAPPING`, `MEDIA_LOADER_TYPES` from `../model-categories.js`; `getModelFile`, `getMediaFile` from `../model-index.js`; `WorkflowIssue` from `../issue-types.js`.
- Produces: `validateMissingReferences(workflow: Record<string, unknown>): Promise<WorkflowIssue[]>`.

- [ ] **Step 6.1: Write failing tests** — Create `sga_template/src/comfyui/validators/missing-ref-validator.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const sampleObjectInfo = {
  CheckpointLoaderSimple: {
    name: 'CheckpointLoaderSimple', category: 'loaders',
    input: { required: { ckpt_name: [['model1.safetensors', 'model2.safetensors']] } },
    output: ['MODEL', 'CLIP', 'VAE'], output_name: ['MODEL', 'CLIP', 'VAE'],
  },
  LoraLoader: {
    name: 'LoraLoader', category: 'loaders',
    input: { required: { model: ['MODEL'], clip: ['CLIP'], lora_name: [['style.safetensors']] } },
    output: ['MODEL', 'CLIP'], output_name: ['MODEL', 'CLIP'],
  },
  LoadImage: {
    name: 'LoadImage', category: 'image',
    input: { required: { image: ['STRING'] } },
    output: ['IMAGE', 'MASK'], output_name: ['IMAGE', 'MASK'],
  },
}

async function createModelFile(baseDir: string, category: string, name: string): Promise<void> {
  const dir = join(baseDir, 'models', category)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, name), 'fake')
}

function makeWorkflow(nodes: any[], links: any[]) {
  return { nodes, links, last_node_id: nodes.length, last_link_id: links.length }
}

describe('missing-ref-validator', () => {
  let tmpHome: string
  let tmpBaseDir: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-missing-ref-'))
    tmpBaseDir = await fs.mkdtemp(join(tmpdir(), 'sga-comfyui-'))
    vi.stubEnv('SGA_HOME', tmpHome)
    vi.stubEnv('COMFYUI_BASE_DIR', tmpBaseDir)
    vi.stubEnv('COMFYUI_API_HOST', '127.0.0.1')
    vi.stubEnv('COMFYUI_API_PORT', '8188')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    vi.resetModules()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fs.rm(tmpHome, { recursive: true, force: true })
    await fs.rm(tmpBaseDir, { recursive: true, force: true })
  })

  it('returns empty for clean workflow with all models present', async () => {
    await createModelFile(tmpBaseDir, 'checkpoints', 'model1.safetensors')
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['model1.safetensors'],
        outputs: [{ name: 'MODEL', type: 'MODEL', links: null }] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toEqual([])
  })

  it('detects missing checkpoint model', async () => {
    await createModelFile(tmpBaseDir, 'checkpoints', 'model1.safetensors')
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['nonexistent.safetensors'],
        outputs: [{ name: 'MODEL', type: 'MODEL', links: null }] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].category).toBe('missing_model')
    expect(issues[0].nodeId).toBe(1)
    expect(issues[0].message).toMatch(/nonexistent\.safetensors/)
    expect(issues[0].source).toBe('native')
  })

  it('detects missing lora model', async () => {
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'LoraLoader', widgets_values: ['missing_lora.safetensors', 0.8, 0.8] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toHaveLength(1)
    expect(issues[0].category).toBe('missing_model')
    expect(issues[0].message).toMatch(/missing_lora\.safetensors/)
  })

  it('detects missing media file', async () => {
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'LoadImage', widgets_values: ['nonexistent.png'] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toHaveLength(1)
    expect(issues[0].category).toBe('missing_media')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].message).toMatch(/nonexistent\.png/)
  })

  it('finds media file when present', async () => {
    const inputDir = join(tmpBaseDir, 'input')
    await fs.mkdir(inputDir, { recursive: true })
    await fs.writeFile(join(inputDir, 'photo.png'), 'fake')
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'LoadImage', widgets_values: ['photo.png'] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toEqual([])
  })

  it('skips unknown loader types', async () => {
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'SomeUnknownLoader', widgets_values: ['something'] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toEqual([])
  })

  it('skips nodes with no widgets_values', async () => {
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'CheckpointLoaderSimple' }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toEqual([])
  })

  it('issues carry source: native', async () => {
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['missing.safetensors'] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues.every(i => i.source === 'native')).toBe(true)
    expect(issues.every(i => typeof i.id === 'string' && i.id.length > 0)).toBe(true)
  })
})
```

- [ ] **Step 6.2: Run tests to verify they fail** — `cd sga_template && npm test -- src/comfyui/validators/missing-ref-validator.test.ts` → FAIL (module not found).

- [ ] **Step 6.3: Write implementation** — Create `sga_template/src/comfyui/validators/missing-ref-validator.ts`:

```ts
/**
 * Missing-Reference Validator — checks model-loader and media-loader nodes
 * against the ModelIndex to detect references to files not present on disk.
 *
 * Emits WorkflowIssue[] with category 'missing_model' or 'missing_media'.
 */
import type { WorkflowIssue } from '../issue-types.js'
import { MODEL_LOADER_MAPPING, MEDIA_LOADER_TYPES } from '../model-categories.js'
import { getModelFile, getMediaFile } from '../model-index.js'

interface GraphNode {
  id: number | string
  type: string
  widgets_values?: unknown[]
}

export async function validateMissingReferences(workflow: Record<string, unknown>): Promise<WorkflowIssue[]> {
  const nodes = ((workflow.nodes as GraphNode[] | undefined) ?? [])
    .filter(n => n && typeof n.id !== 'undefined')
  const issues: WorkflowIssue[] = []

  for (const node of nodes) {
    const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : []
    if (widgets.length === 0) continue

    // Check model loaders
    const loaderMapping = MODEL_LOADER_MAPPING[node.type]
    if (loaderMapping) {
      const widgetIndex = findWidgetIndex(node, loaderMapping.widget)
      const modelName = widgetIndex !== -1 ? widgets[widgetIndex] : undefined
      if (typeof modelName === 'string' && modelName.length > 0) {
        const entry = await getModelFile(loaderMapping.category, modelName)
        if (!entry) {
          issues.push({
            id: `missing_model:${node.id}`,
            nodeId: typeof node.id === 'number' ? node.id : null,
            severity: 'warning',
            category: 'missing_model',
            message: `Model file '${modelName}' not found in ${loaderMapping.category}/`,
            impact: 'ComfyUI will fail to load this node when the workflow is queued.',
            fixSuggestion: `Check that the file exists under models/${loaderMapping.category}/ or restart ComfyUI to re-index.`,
            nodeType: node.type,
            modelName,
            modelFolder: loaderMapping.category,
            source: 'native',
          })
        }
      }
      continue
    }

    // Check media loaders
    if (MEDIA_LOADER_TYPES.has(node.type)) {
      const mediaName = widgets[0]
      if (typeof mediaName === 'string' && mediaName.length > 0) {
        const entry = await getMediaFile(mediaName)
        if (!entry) {
          issues.push({
            id: `missing_media:${node.id}`,
            nodeId: typeof node.id === 'number' ? node.id : null,
            severity: 'warning',
            category: 'missing_media',
            message: `Media file '${mediaName}' not found in input/`,
            impact: 'ComfyUI will fail to load this image/video when the workflow is queued.',
            fixSuggestion: `Check that the file exists under input/ or upload it via ComfyUI's input directory.`,
            nodeType: node.type,
            source: 'native',
          })
        }
      }
    }
  }

  return issues
}

/**
 * Find the index of a widget by name in the node's inputs.
 * ComfyUI stores widget values positionally, but the widget name comes from
 * the node definition. For the graph format, widgets_values aligns with
 * the order of input.required in /object_info. We use a simple heuristic:
 * if the widget name matches a known position (e.g. ckpt_name is always
 * index 0 for CheckpointLoaderSimple), return that index.
 *
 * For v1, we assume the widget is at index 0 for most loaders (which is
 * true for all entries in MODEL_LOADER_MAPPING). This is a known limitation.
 */
function findWidgetIndex(_node: GraphNode, widgetName: string): number {
  // All current MODEL_LOADER_MAPPING entries have the model name as the
  // first widget (index 0). This matches ComfyUI's /object_info ordering
  // where required inputs come first and model names precede numeric params.
  void widgetName  // acknowledged — not used in v1 heuristic
  return 0
}
```

- [ ] **Step 6.4: Run tests to verify they pass** — `cd sga_template && npm test -- src/comfyui/validators/missing-ref-validator.test.ts` → PASS (8 tests).

- [ ] **Step 6.5: Run typecheck and full test suite** — `cd sga_template && npm run typecheck && npm test` → PASS.

- [ ] **Step 6.6: Commit** — `git add sga_template/src/comfyui/validators/missing-ref-validator.ts sga_template/src/comfyui/validators/missing-ref-validator.test.ts && git commit -m "feat(comfyui): add missing-ref validator for model and media file existence"`

---

## Task 7: Illegal-Link Validator

**Files:**
- Create: `sga_template/src/comfyui/validators/illegal-link-validator.ts`
- Create: `sga_template/src/comfyui/validators/illegal-link-validator.test.ts`

**Interfaces:**
- Consumes: `buildNodeMap`, `buildLinkList` from `../graph-utils.js`; `WorkflowIssue` from `../issue-types.js`.
- Produces: `validateLinkStructure(workflow: Record<string, unknown>): WorkflowIssue[]` (sync, no async deps).

- [ ] **Step 7.1: Write failing tests** — Create `sga_template/src/comfyui/validators/illegal-link-validator.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

function makeWorkflow(nodes: any[], links: any[]) {
  return { nodes, links, last_node_id: nodes.length, last_link_id: links.length }
}

describe('illegal-link-validator', () => {
  it('returns empty for clean valid links', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      [[1, 1, 0, 2, 0, 'MODEL']],
    )
    expect(validateLinkStructure(wf)).toEqual([])
  })

  it('detects dangling link (to_node_id not in nodeMap)', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] }],
      [[1, 1, 0, 99, 0, 'MODEL']],
    )
    const issues = validateLinkStructure(wf)
    const dangling = issues.find(i => i.id.endsWith(':dangling'))
    expect(dangling).toBeDefined()
    expect(dangling?.severity).toBe('error')
    expect(dangling?.category).toBe('illegal_link')
  })

  it('detects slot out of bounds (from_slot >= outputs.length)', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      [[1, 1, 5, 2, 0, 'MODEL']],
    )
    const issues = validateLinkStructure(wf)
    const oob = issues.find(i => i.id.endsWith(':slot_oob'))
    expect(oob).toBeDefined()
    expect(oob?.severity).toBe('error')
  })

  it('detects bidirectional inconsistency', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [null] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: null }] },
      ],
      [[1, 1, 0, 2, 0, 'MODEL']],
    )
    const issues = validateLinkStructure(wf)
    const bidi = issues.find(i => i.id.endsWith(':bidirectional'))
    expect(bidi).toBeDefined()
    expect(bidi?.severity).toBe('error')
  })

  it('detects self-loop', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'A', inputs: [{ name: 'in', type: 'MODEL', link: 1 }], outputs: [{ name: 'X', type: 'MODEL', links: [1] }] }],
      [[1, 1, 0, 1, 0, 'MODEL']],
    )
    const issues = validateLinkStructure(wf)
    const selfLoop = issues.find(i => i.id.endsWith(':self_loop'))
    expect(selfLoop).toBeDefined()
    expect(selfLoop?.severity).toBe('error')
  })

  it('detects multiple violations in one workflow', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1, 2] }] }],
      [
        [1, 1, 0, 99, 0, 'MODEL'],   // dangling
        [2, 1, 0, 1, 0, 'MODEL'],    // self-loop
      ],
    )
    const issues = validateLinkStructure(wf)
    expect(issues.length).toBeGreaterThanOrEqual(2)
    expect(issues.every(i => i.category === 'illegal_link')).toBe(true)
  })

  it('skips malformed link entries', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [] }] }],
      ['not-an-array', [1], [2, 1, 0, 2, 0]],
    )
    expect(validateLinkStructure(wf)).toEqual([])
  })

  it('issues carry source: native', async () => {
    const { validateLinkStructure } = await import('./illegal-link-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] }],
      [[1, 1, 0, 99, 0, 'MODEL']],
    )
    const issues = validateLinkStructure(wf)
    expect(issues.every(i => i.source === 'native')).toBe(true)
    expect(issues.every(i => typeof i.id === 'string' && i.id.length > 0)).toBe(true)
  })
})
```

- [ ] **Step 7.2: Run tests to verify they fail** — `cd sga_template && npm test -- src/comfyui/validators/illegal-link-validator.test.ts` → FAIL (module not found).

- [ ] **Step 7.3: Write implementation** — Create `sga_template/src/comfyui/validators/illegal-link-validator.ts`:

```ts
/**
 * Illegal-Link Validator — detects structural link issues.
 *
 * Four sub-rules (all severity: 'error', category: 'illegal_link'):
 *   a) Dangling link: from_node_id or to_node_id not in nodeMap
 *   b) Slot out of bounds: from_slot >= outputs.length or to_slot >= inputs.length
 *   c) Bidirectional inconsistency: link in links[] but neither endpoint references it
 *   d) Self-loop: from_node_id === to_node_id
 *
 * Pure graph topology — no async dependencies. Runs synchronously.
 */
import type { WorkflowIssue } from '../issue-types.js'
import { buildNodeMap, buildLinkList } from '../graph-utils.js'

interface GraphNode {
  id: number | string
  type: string
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
}

export function validateLinkStructure(workflow: Record<string, unknown>): WorkflowIssue[] {
  const nodeMap = buildNodeMap(workflow)
  const links = buildLinkList(workflow)
  const issues: WorkflowIssue[] = []

  for (const link of links) {
    const fromCtx = nodeMap.get(link.fromNodeId)
    const toCtx = nodeMap.get(link.toNodeId)

    // Rule a: dangling link
    if (!fromCtx || !toCtx) {
      const missingId = !fromCtx ? link.fromNodeId : link.toNodeId
      issues.push({
        id: `illegal_link:${link.id}:dangling`,
        nodeId: null,
        nodeIds: [link.fromNodeId, link.toNodeId].filter(() => true),
        severity: 'error',
        category: 'illegal_link',
        message: `Link ${link.id} references node ${missingId} which does not exist in the workflow.`,
        impact: 'ComfyUI will crash or silently drop this connection at load time.',
        fixSuggestion: `Remove link ${link.id} or reconnect it to existing nodes.`,
        source: 'native',
      })
      continue
    }

    const fromNode = fromCtx.node as GraphNode
    const toNode = toCtx.node as GraphNode

    // Rule d: self-loop
    if (link.fromNodeId === link.toNodeId) {
      issues.push({
        id: `illegal_link:${link.id}:self_loop`,
        nodeId: link.fromNodeId,
        nodeIds: [link.fromNodeId],
        severity: 'error',
        category: 'illegal_link',
        message: `Link ${link.id} connects node ${link.fromNodeId} to itself.`,
        impact: 'Creates an infinite cycle; ComfyUI will reject this workflow.',
        fixSuggestion: `Remove link ${link.id} or connect it to a different node.`,
        source: 'native',
      })
      continue
    }

    // Rule b: slot out of bounds
    const fromOutputs = Array.isArray(fromNode.outputs) ? fromNode.outputs : []
    const toInputs = Array.isArray(toNode.inputs) ? toNode.inputs : []
    if (link.fromSlot >= fromOutputs.length || link.toSlot >= toInputs.length) {
      issues.push({
        id: `illegal_link:${link.id}:slot_oob`,
        nodeId: link.fromNodeId,
        nodeIds: [link.fromNodeId, link.toNodeId],
        severity: 'error',
        category: 'illegal_link',
        message: `Link ${link.id}: slot index out of bounds (from_slot ${link.fromSlot} >= ${fromOutputs.length} outputs, or to_slot ${link.toSlot} >= ${toInputs.length} inputs).`,
        impact: 'ComfyUI will crash or misconnect ports when loading this workflow.',
        fixSuggestion: `Reconnect link ${link.id} to valid ports on nodes ${link.fromNodeId} and ${link.toNodeId}.`,
        source: 'native',
      })
      continue
    }

    // Rule c: bidirectional inconsistency
    // Link is in links[] but neither endpoint's inputs[].link nor outputs[].links references it
    const fromOutputLinks = fromOutputs[link.fromSlot]?.links
    const toInputLink = toInputs[link.toSlot]?.link
    const fromReferences = Array.isArray(fromOutputLinks) && fromOutputLinks.includes(link.id)
    const toReferences = toInputLink === link.id
    if (!fromReferences && !toReferences) {
      issues.push({
        id: `illegal_link:${link.id}:bidirectional`,
        nodeId: link.fromNodeId,
        nodeIds: [link.fromNodeId, link.toNodeId],
        severity: 'error',
        category: 'illegal_link',
        message: `Link ${link.id} is declared in links[] but neither node ${link.fromNodeId} output ${link.fromSlot} nor node ${link.toNodeId} input ${link.toSlot} references it.`,
        impact: 'ComfyUI may silently drop this connection or display it incorrectly.',
        fixSuggestion: `Remove link ${link.id} or fix the node port references to include it.`,
        source: 'native',
      })
    }
  }

  return issues
}
```

- [ ] **Step 7.4: Run tests to verify they pass** — `cd sga_template && npm test -- src/comfyui/validators/illegal-link-validator.test.ts` → PASS (8 tests).

- [ ] **Step 7.5: Run typecheck and full test suite** — `cd sga_template && npm run typecheck && npm test` → PASS.

- [ ] **Step 7.6: Commit** — `git add sga_template/src/comfyui/validators/illegal-link-validator.ts sga_template/src/comfyui/validators/illegal-link-validator.test.ts && git commit -m "feat(comfyui): add illegal-link validator with 4 sub-rules"`

---

## Task 8: Unsupported-Structure Validator

**Files:**
- Create: `sga_template/src/comfyui/validators/unsupported-structure-validator.ts`
- Create: `sga_template/src/comfyui/validators/unsupported-structure-validator.test.ts`

**Interfaces:**
- Consumes: `buildNodeMap`, `buildLinkList`, `isReroute`, `isPrimitive`, `isNote` from `../graph-utils.js`; `getNodeDef` from `../node-def-index.js`; `WorkflowIssue` from `../issue-types.js`.
- Produces: `validateUnsupportedStructures(workflow: Record<string, unknown>): Promise<WorkflowIssue[]>` (async — rule d requires NodeDef lookups).

- [ ] **Step 8.1: Write failing tests** — Create `sga_template/src/comfyui/validators/unsupported-structure-validator.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const sampleObjectInfo = {
  Reroute: {
    name: 'Reroute', category: 'utils',
    input: { required: {} },
    output: ['*'], output_name: ['*'],
  },
  PrimitiveNode: {
    name: 'PrimitiveNode', category: 'utils',
    input: { required: { "value": ["STRING"] } },
    output: ['*'], output_name: ['*'],
  },
  Note: {
    name: 'Note', category: 'utils',
    input: { required: { "text": ["STRING"] } },
    output: [], output_name: [],
  },
  KSampler: {
    name: 'KSampler', category: 'sampling',
    input: { required: { "seed": ["INT"] } },
    output: ['LATENT'], output_name: ['LATENT'],
  },
}

function makeWorkflow(nodes: any[], links: any[]) {
  return { nodes, links, last_node_id: nodes.length, last_link_id: links.length }
}

describe('unsupported-structure-validator', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-unsup-str-'))
    vi.stubEnv('SGA_HOME', tmpHome)
    vi.stubEnv('COMFYUI_API_HOST', '127.0.0.1')
    vi.stubEnv('COMFYUI_API_PORT', '8188')
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

  it('returns empty for clean workflow', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const wf = makeWorkflow([], [])
    expect(await validateUnsupportedStructures(wf)).toEqual([])
  })

  it('detects unconnected Reroute (input null, output empty)', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'Reroute', inputs: [{ name: '*', type: '*', link: null }], outputs: [{ name: '*', type: '*', links: [] }] }],
      [],
    )
    const issues = await validateUnsupportedStructures(wf)
    const unconnected = issues.find(i => i.id.endsWith(':reroute_unconnected'))
    expect(unconnected).toBeDefined()
    expect(unconnected?.severity).toBe('info')
    expect(unconnected?.category).toBe('unsupported_structure')
  })

  it('detects orphaned Note', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'Note', widgets_values: ['a note'] }],
      [],
    )
    const issues = await validateUnsupportedStructures(wf)
    const orphaned = issues.find(i => i.id.endsWith(':orphaned_aux'))
    expect(orphaned).toBeDefined()
    expect(orphaned?.severity).toBe('info')
  })

  it('detects orphaned PrimitiveNode', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'PrimitiveNode', widgets_values: ['hello'], outputs: [{ name: '*', type: '*', links: [] }] }],
      [],
    )
    const issues = await validateUnsupportedStructures(wf)
    const orphaned = issues.find(i => i.id.endsWith(':orphaned_aux'))
    expect(orphaned).toBeDefined()
  })

  it('allows reroute chain at depth 8 (default threshold)', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const nodes: any[] = []
    const links: any[] = []
    for (let i = 1; i <= 8; i++) {
      nodes.push({ id: i, type: 'Reroute', inputs: [{ name: '*', type: '*', link: i > 1 ? i - 1 : null }], outputs: [{ name: '*', type: '*', links: i < 8 ? [i] : [] }] })
      if (i < 8) links.push([i, i, 0, i + 1, 0, '*'])
    }
    const wf = makeWorkflow(nodes, links)
    const issues = await validateUnsupportedStructures(wf)
    const deep = issues.find(i => i.id.endsWith(':deep_reroute_chain'))
    expect(deep).toBeUndefined()
  })

  it('detects reroute chain deeper than 8', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const nodes: any[] = []
    const links: any[] = []
    for (let i = 1; i <= 10; i++) {
      nodes.push({ id: i, type: 'Reroute', inputs: [{ name: '*', type: '*', link: i > 1 ? i - 1 : null }], outputs: [{ name: '*', type: '*', links: i < 10 ? [i] : [] }] })
      if (i < 10) links.push([i, i, 0, i + 1, 0, '*'])
    }
    const wf = makeWorkflow(nodes, links)
    const issues = await validateUnsupportedStructures(wf)
    const deep = issues.find(i => i.id.endsWith(':deep_reroute_chain'))
    expect(deep).toBeDefined()
    expect(deep?.severity).toBe('info')
  })

  it('detects PrimitiveNode multi-type output', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const wf = makeWorkflow(
      [
        { id: 1, type: 'PrimitiveNode', widgets_values: ['hello'], outputs: [{ name: '*', type: '*', links: [1, 2] }] },
        { id: 2, type: 'KSampler', inputs: [{ name: 'seed', type: 'INT', link: 1 }] },
        { id: 3, type: 'KSampler', inputs: [{ name: 'seed', type: 'STRING', link: 2 }] },
      ],
      [[1, 1, 0, 2, 0, 'INT'], [2, 1, 0, 3, 0, 'STRING']],
    )
    const issues = await validateUnsupportedStructures(wf)
    const multiType = issues.find(i => i.id.endsWith(':primitive_multi_type'))
    expect(multiType).toBeDefined()
    expect(multiType?.severity).toBe('info')
  })

  it('issues carry source: native', async () => {
    const { validateUnsupportedStructures } = await import('./unsupported-structure-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'Reroute', inputs: [{ name: '*', type: '*', link: null }], outputs: [{ name: '*', type: '*', links: [] }] }],
      [],
    )
    const issues = await validateUnsupportedStructures(wf)
    expect(issues.every(i => i.source === 'native')).toBe(true)
    expect(issues.every(i => typeof i.id === 'string' && i.id.length > 0)).toBe(true)
  })
})
```

- [ ] **Step 8.2: Run tests to verify they fail** — `cd sga_template && npm test -- src/comfyui/validators/unsupported-structure-validator.test.ts` → FAIL (module not found).

- [ ] **Step 8.3: Write implementation** — Create `sga_template/src/comfyui/validators/unsupported-structure-validator.ts`:

```ts
/**
 * Unsupported-Structure Validator — detects fragile graph patterns.
 *
 * Four sub-rules (all severity: 'info', category: 'unsupported_structure'):
 *   a) Reroute unconnected: input[0].link === null OR outputs[0].links empty
 *   b) Note/Primitive orphaned: not connected to any other node
 *   c) Deep Reroute chain: chain longer than SGA_MAX_REROUTE_DEPTH (default 8)
 *   d) Primitive multi-type: single output connected to inputs of different types
 *
 * Rule (d) requires NodeDef lookups → validator is async overall.
 */
import type { WorkflowIssue } from '../issue-types.js'
import type { NodeDef } from '../node-def-index.js'
import { getNodeDef } from '../node-def-index.js'
import { buildNodeMap, buildLinkList, isReroute, isPrimitive, isNote } from '../graph-utils.js'

interface GraphNode {
  id: number | string
  type: string
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
  widgets_values?: unknown[]
}

function getMaxRerouteDepth(): number {
  return Number(process.env.SGA_MAX_REROUTE_DEPTH) || 8
}

export async function validateUnsupportedStructures(workflow: Record<string, unknown>): Promise<WorkflowIssue[]> {
  const nodeMap = buildNodeMap(workflow)
  const links = buildLinkList(workflow)
  const issues: WorkflowIssue[] = []

  // Build link lookup: nodeId → linkIds that touch this node
  const linksByNode = new Map<number, Set<number>>()
  for (const link of links) {
    if (!linksByNode.has(link.fromNodeId)) linksByNode.set(link.fromNodeId, new Set())
    if (!linksByNode.has(link.toNodeId)) linksByNode.set(link.toNodeId, new Set())
    linksByNode.get(link.fromNodeId)!.add(link.id)
    linksByNode.get(link.toNodeId)!.add(link.id)
  }

  // Rule a: Reroute unconnected
  for (const ctx of nodeMap.values()) {
    const node = ctx.node as GraphNode
    if (!isReroute(node)) continue
    const inputLink = node.inputs?.[0]?.link
    const outputLinks = node.outputs?.[0]?.links
    const hasInput = inputLink != null && inputLink !== undefined
    const hasOutput = Array.isArray(outputLinks) && outputLinks.some(l => l !== null)
    if (!hasInput || !hasOutput) {
      issues.push({
        id: `unsupported_structure:${node.id}:reroute_unconnected`,
        nodeId: ctx.id,
        severity: 'info',
        category: 'unsupported_structure',
        message: `Reroute node ${node.id} is not fully connected (input: ${hasInput ? 'yes' : 'no'}, output: ${hasOutput ? 'yes' : 'no'}).`,
        impact: 'An unconnected Reroute serves no purpose and may indicate an incomplete edit.',
        fixSuggestion: `Connect both sides of the Reroute or remove it.`,
        source: 'native',
      })
    }
  }

  // Rule b: Note/Primitive orphaned (no links at all)
  for (const ctx of nodeMap.values()) {
    const node = ctx.node as GraphNode
    if (!isNote(node) && !isPrimitive(node)) continue
    const connectedLinks = linksByNode.get(ctx.id)
    if (!connectedLinks || connectedLinks.size === 0) {
      issues.push({
        id: `unsupported_structure:${node.id}:orphaned_aux`,
        nodeId: ctx.id,
        severity: 'info',
        category: 'unsupported_structure',
        message: `${node.type} node ${node.id} is not connected to any other node.`,
        impact: 'Orphaned auxiliary nodes clutter the canvas and serve no purpose.',
        fixSuggestion: `Connect this node or remove it.`,
        source: 'native',
      })
    }
  }

  // Rule c: Deep Reroute chain
  const rerouteNodes = Array.from(nodeMap.values()).filter(ctx => isReroute(ctx.node))
  if (rerouteNodes.length > 0) {
    const maxDepth = getMaxRerouteDepth()
    const rerouteLinks = links.filter(l => {
      const fromCtx = nodeMap.get(l.fromNodeId)
      const toCtx = nodeMap.get(l.toNodeId)
      return fromCtx && toCtx && isReroute(fromCtx.node) && isReroute(toCtx.node)
    })

    // Build adjacency: fromNodeId → [toNodeId]
    const adjacency = new Map<number, number[]>()
    for (const link of rerouteLinks) {
      if (!adjacency.has(link.fromNodeId)) adjacency.set(link.fromNodeId, [])
      adjacency.get(link.fromNodeId)!.push(link.toNodeId)
    }

    // Find the longest chain starting from each reroute with no incoming reroute link
    const visited = new Set<number>()
    for (const start of rerouteNodes) {
      if (visited.has(start.id)) continue
      // Check if this node has an incoming reroute link
      const hasIncoming = rerouteLinks.some(l => l.toNodeId === start.id)
      if (hasIncoming) continue

      // Walk the chain
      let depth = 1
      let current: number | null = start.id
      visited.add(start.id)
      while (current !== null) {
        const neighbors = adjacency.get(current)
        if (!neighbors || neighbors.length === 0) break
        current = neighbors[0]
        if (current !== null) {
          depth++
          visited.add(current)
        }
      }
      if (depth > maxDepth) {
        issues.push({
          id: `unsupported_structure:${start.id}:deep_reroute_chain`,
          nodeId: start.id,
          severity: 'info',
          category: 'unsupported_structure',
          message: `Reroute chain starting at node ${start.id} has depth ${depth} (max ${maxDepth}).`,
          impact: 'Deep Reroute chains make workflows harder to read and debug.',
          fixSuggestion: `Reduce the chain length to ${maxDepth} or fewer, or use a direct connection.`,
          source: 'native',
        })
      }
    }
  }

  // Rule d: Primitive multi-type output
  for (const ctx of nodeMap.values()) {
    const node = ctx.node as GraphNode
    if (!isPrimitive(node)) continue
    const outputLinks = node.outputs?.[0]?.links
    if (!Array.isArray(outputLinks)) continue

    const linkIds = outputLinks.filter((l): l is number => l !== null)
    if (linkIds.length < 2) continue  // need at least 2 connections to have multi-type

    // Look up the input type of each connected destination
    const inputTypes = new Set<string>()
    for (const linkId of linkIds) {
      const link = links.find(l => l.id === linkId)
      if (!link) continue
      const toCtx = nodeMap.get(link.toNodeId)
      if (!toCtx) continue
      const toNode = toCtx.node as GraphNode
      const inputDef = toNode.inputs?.[link.toSlot]
      if (inputDef) {
        inputTypes.add(inputDef.type)
      } else {
        // Fall back to NodeDef
        const def: NodeDef | null = await getNodeDef(toNode.type)
        const defInput = def?.inputs[link.toSlot]
        if (defInput) inputTypes.add(defInput.type)
      }
    }

    // Also check NodeDef for more accurate types
    if (inputTypes.size <= 1) {
      // Try harder with NodeDef lookups
      const defTypes = new Set<string>()
      for (const linkId of linkIds) {
        const link = links.find(l => l.id === linkId)
        if (!link) continue
        const toCtx = nodeMap.get(link.toNodeId)
        if (!toCtx) continue
        const toNode = toCtx.node as GraphNode
        const def: NodeDef | null = await getNodeDef(toNode.type)
        const defInput = def?.inputs[link.toSlot]
        if (defInput) defTypes.add(defInput.type)
      }
      if (defTypes.size > 1) {
        issues.push({
          id: `unsupported_structure:${node.id}:primitive_multi_type`,
          nodeId: ctx.id,
          severity: 'info',
          category: 'unsupported_structure',
          message: `PrimitiveNode ${node.id} output is connected to inputs of different types: ${Array.from(defTypes).join(', ')}.`,
          impact: 'PrimitiveNode outputs a single type; connecting to incompatible types may cause runtime errors.',
          fixSuggestion: `Ensure all connections from this PrimitiveNode go to the same input type.`,
          source: 'native',
        })
      }
    } else {
      issues.push({
        id: `unsupported_structure:${node.id}:primitive_multi_type`,
        nodeId: ctx.id,
        severity: 'info',
        category: 'unsupported_structure',
        message: `PrimitiveNode ${node.id} output is connected to inputs of different types: ${Array.from(inputTypes).join(', ')}.`,
        impact: 'PrimitiveNode outputs a single type; connecting to incompatible types may cause runtime errors.`,
        fixSuggestion: `Ensure all connections from this PrimitiveNode go to the same input type.`,
        source: 'native',
      })
    }
  }

  return issues
}
```

- [ ] **Step 8.4: Run tests to verify they pass** — `cd sga_template && npm test -- src/comfyui/validators/unsupported-structure-validator.test.ts` → PASS (8 tests).

- [ ] **Step 8.5: Run typecheck and full test suite** — `cd sga_template && npm run typecheck && npm test` → PASS.

- [ ] **Step 8.6: Commit** — `git add sga_template/src/comfyui/validators/unsupported-structure-validator.ts sga_template/src/comfyui/validators/unsupported-structure-validator.test.ts && git commit -m "feat(comfyui): add unsupported-structure validator with 4 sub-rules"`

---

## Task 9: Validate-Workflow Orchestrator

**Files:**
- Create: `sga_template/src/comfyui/validators/validate-workflow.ts`
- Create: `sga_template/src/comfyui/validators/validate-workflow.test.ts`

**Interfaces:**
- Consumes: `validatePortTypes` from `./port-type-validator.js`, `validateMissingReferences` from `./missing-ref-validator.js`, `validateLinkStructure` from `./illegal-link-validator.js`, `validateUnsupportedStructures` from `./unsupported-structure-validator.js`, `WorkflowIssue` from `../issue-types.js`.
- Produces: `validateWorkflow(workflow: Record<string, unknown>): Promise<WorkflowIssue[]>`.

- [ ] **Step 9.1: Write failing tests** — Create `sga_template/src/comfyui/validators/validate-workflow.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadFixture } from './fixture-loader.js'

const sampleObjectInfo = {
  CheckpointLoaderSimple: {
    name: 'CheckpointLoaderSimple', category: 'loaders',
    input: { required: { "ckpt_name": [["model1.safetensors"]] } },
    output: ['MODEL', 'CLIP', 'VAE'], output_name: ['MODEL', 'CLIP', 'VAE'],
  },
  CLIPTextEncode: {
    name: 'CLIPTextEncode', category: 'conditioning',
    input: { required: { "text": ["STRING"], "clip": ["CLIP"] } },
    output: ['CONDITIONING'], output_name: ['CONDITIONING'],
  },
}

describe('validate-workflow', () => {
  let tmpHome: string
  let tmpBaseDir: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-orch-'))
    tmpBaseDir = await fs.mkdtemp(join(tmpdir(), 'sga-comfyui-'))
    vi.stubEnv('SGA_HOME', tmpHome)
    vi.stubEnv('COMFYUI_BASE_DIR', tmpBaseDir)
    vi.stubEnv('COMFYUI_API_HOST', '127.0.0.1')
    vi.stubEnv('COMFYUI_API_PORT', '8188')
    vi.resetModules()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fs.rm(tmpHome, { recursive: true, force: true })
    await fs.rm(tmpBaseDir, { recursive: true, force: true })
  })

  it('runs all 4 validators and returns combined issues', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    const { validateWorkflow } = await import('./validate-workflow.js')
    const wf = {
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['missing.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: null }] },
      ],
      links: [],
    }
    const issues = await validateWorkflow(wf)
    // Should have at least: missing_model from missing-ref validator
    const categories = new Set(issues.map(i => i.category))
    expect(categories.has('missing_model')).toBe(true)
  })

  it('deduplicates issues by id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    const { validateWorkflow } = await import('./validate-workflow.js')
    const wf = {
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['missing.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: null }] },
      ],
      links: [],
    }
    const issues = await validateWorkflow(wf)
    const ids = issues.map(i => i.id)
    const uniqueIds = new Set