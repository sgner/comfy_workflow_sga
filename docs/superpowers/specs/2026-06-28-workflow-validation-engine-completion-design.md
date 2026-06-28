# Workflow Validation Engine Completion — Design Spec

**Date:** 2026-06-28
**Status:** Approved (pending user review)
**Scope:** WS3 remaining validation rules + WS6 test corpus (from `docs/workflow-domain-capability-plan.md`)
**Predecessor:** `docs/superpowers/plans/2026-06-28-node-def-index-and-port-validator.md` (merged as PR #1: NodeDefIndex + Port-Type Validator)

## 1. Goal & Scope

Complete Workstream 3 (Validation Engine) by adding 4 new validation rules on top of the existing `port-type-validator`, and establish Workstream 6 (Domain Test Corpus) with 10 fixtures. Two parallel implementations are planned:

* **Branch A** (`feat/validation-engine-modular`): Approach A — modular validators (one file per concern). Mirrors the existing `port-type-validator.ts` pattern. **This is the spec's primary focus.**

* **Branch C** (`feat/validation-engine-graph-walker`): Approach C — graph walker + rule plugins. Becomes the future default for `ModelIndex` and reroute-related rules. **Spec sketches the architecture; full plan deferred to a follow-up.**

Both branches ship the same 4 rules and the same 10 fixtures. Two PRs (one per branch).

### Out of scope

* Workstream 1 (Workflow Normalizer) — future

* Workstream 4/5/7 (Patch Planner / Transactional Apply / UI Diagnostics Upgrade) — future

* Refactoring the existing `port-type-validator.ts` — left as-is to avoid regression

## 2. Validation Rules (common to both branches)

All issues use the backend-canonical `WorkflowIssue` type (from `sga_template/src/comfyui/issue-types.ts`) with `source: 'native'` and a stable string `id` so the UI Diagnostics tab renders without translation.

### 2.1 missing-model (model file existence)

**Severity:** `warning`
**Category:** `missing_model`
**Trigger:** A model-loader node references a model filename not present on disk.

* Iterates over model-loader nodes (identified by node type → widget name → category mapping in `model-categories.ts`).

* Primary check: `ModelIndex.getModelFile(category, widgetValue)` returns `null`.

* Emits one issue per missing reference, with `nodeId`, `nodeType`, `message` ("Model file 'X' not found in checkpoints/"), `fixSuggestion` ("Check that the file exists under models/checkpoints/ or restart ComfyUI to re-index").

### 2.2 missing-media (media file existence)

**Severity:** `warning`
**Category:** `missing_media`
**Trigger:** A `LoadImage` / `LoadVideo` / `VHS_LoadVideo` node references an input file not present in `COMFYUI_BASE_DIR/input/`.

* Uses `ModelIndex.getMediaFile(widgetValue)` (media listing is part of `model-index.ts` — see §4.1).

* Same shape as `missing_model`.

### 2.3 illegal-link (4 sub-rules)

**Severity:** `error` for all four
**Category:** `illegal_link` with subcategory in `message` / `impact`

| Sub-rule                       | id suffix        | Trigger                                                                                                |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------ |
| a) Dangling link               | `:dangling`      | `link.from_node_id` or `link.to_node_id` not in `nodeMap`                                              |
| b) Slot out of bounds          | `:slot_oob`      | `from_slot >= node.outputs.length` OR `to_slot >= node.inputs.length`                                  |
| c) Bidirectional inconsistency | `:bidirectional` | `link` declared in `links[]` but neither endpoint's `inputs[].link` nor `outputs[].link` references it |
| d) Self-loop                   | `:self_loop`     | `from_node_id === to_node_id`                                                                          |

Pure graph topology — no async dependencies. Can run synchronously.

### 2.4 unsupported-structure (4 sub-rules)

**Severity:** `info` for all four
**Category:** `unsupported_structure`

| Sub-rule                       | id suffix               | Trigger                                                                                                                    |
| ------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| a) Reroute unconnected         | `:reroute_unconnected`  | `Reroute` node with `inputs[0].link === null` OR `outputs[0].links` empty/null                                             |
| b) Note/Primitive orphaned     | `:orphaned_aux`         | `Note` or `PrimitiveNode` not connected to any other node                                                                  |
| c) Deep Reroute chain          | `:deep_reroute_chain`   | Chain of `Reroute` nodes longer than `SGA_MAX_REROUTE_DEPTH` (default 8)                                                   |
| d) Primitive multi-type output | `:primitive_multi_type` | `PrimitiveNode`'s single output connected to inputs of different `NodeDef.inputs[].type` (requires async `NodeDef` lookup) |

Rule (d) requires `NodeDef` lookups → validator is async overall.

## 3. Approach A — Modular Architecture (Branch A primary)

One file per concern, mirroring the existing `port-type-validator.ts` pattern. An orchestrator concatenates results.

### 3.1 Module layout

```
sga_template/src/comfyui/
├── api-base.ts                       (existing)
├── issue-types.ts                    (existing)
├── node-def-index.ts                 (extended — see §4.2)
├── model-categories.ts               (NEW — shared constants)
├── model-index.ts                    (NEW — filesystem cache)
├── graph-utils.ts                    (NEW — shared graph helpers)
└── validators/
    ├── port-type-validator.ts        (existing — untouched)
    ├── missing-ref-validator.ts     (NEW — model + media)
    ├── illegal-link-validator.ts    (NEW — 4 sub-rules)
    ├── unsupported-structure-validator.ts  (NEW — 4 sub-rules)
    └── validate-workflow.ts          (NEW — orchestrator)
```

### 3.2 Orchestrator (`validate-workflow.ts`)

```ts
export async function validateWorkflow(workflow: Record<string, unknown>): Promise<WorkflowIssue[]> {
  const results = await Promise.all([
    validatePortTypes(workflow),
    validateMissingReferences(workflow),
    validateLinkStructure(workflow),       // sync, wrapped in Promise.resolve
    validateUnsupportedStructures(workflow),
  ])
  const all = results.flat()
  // Dedup by id (in case two validators flag the same node)
  return Array.from(new Map(all.map(i => [i.id, i])).values())
}
```

All 4 validators run in parallel. Dedup is by `id` (stable string). The orchestrator does NOT swallow errors — see §6.

### 3.3 Shared graph helpers (`graph-utils.ts`)

```ts
export interface GraphNodeContext {
  node: Record<string, unknown>
  def: NodeDef | null      // null if NodeDefIndex returned null
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
export function buildNodeMap(workflow: Record<string, unknown>): Map<number, GraphNodeContext>
export function buildLinkList(workflow: Record<string, unknown>): GraphLink[]
export function isReroute(node: Record<string, unknown>): boolean
export function isPrimitive(node: Record<string, unknown>): boolean
export function isNote(node: Record<string, unknown>): boolean
```

`buildNodeMap` does NOT trigger `NodeDefIndex` loads — every node's `def` starts as `null`. Consumers that need the `NodeDef` call `await getNodeDef(nodeType)` themselves (validator-scoped async, deduplicated automatically by `NodeDefIndex`'s single-flight). This keeps the sync graph helpers free of async I/O.

## 4. Shared Modules (used by both Branch A and Branch C)

### 4.1 ModelIndex (`model-index.ts`)

Mirrors `node-def-index.ts` architecture (single-flight, TTL, persistence, atomic write).

```ts
export const MODEL_INDEX_TTL_MS_DEFAULT = 300_000  // 5 min — models change less often than custom nodes

export interface ModelEntry {
  name: string           // filename only: "v1-5-pruned-emaonly.safetensors"
  category: string       // "checkpoints" | "loras" | "vae" | ...
  relativePath: string   // relative to models/: "checkpoints/v1-5-pruned-emaonly.safetensors"
  sizeBytes: number
}
export interface MediaEntry {
  name: string
  relativePath: string   // relative to input/
  sizeBytes: number
}
export interface ModelIndexStats {
  size: number
  fetchedAt: number | null
  source: 'cache-file' | 'fresh' | 'empty'
}

export async function getModelFile(category: string, name: string): Promise<ModelEntry | null>
export async function getMediaFile(name: string): Promise<MediaEntry | null>
export async function listModels(category?: string): Promise<ModelEntry[]>
export async function listMediaFiles(): Promise<MediaEntry[]>
export async function refreshModelIndex(): Promise<{ count: number; source: 'fresh' }>
export function getModelIndexStats(): ModelIndexStats
```

**Data source:**

* `COMFYUI_BASE_DIR/models/{category}/` (recursive walk)

* `extra_model_paths.yaml` parsed for additional roots

* Media: `COMFYUI_BASE_DIR/input/` recursive walk (matches ComfyUI `LoadImage` which allows subdirectories)

* File extensions: reuse `MODEL_EXTENSIONS` set from `comfyui-model-list.ts`; media extensions: `.png .jpg .jpeg .webp .gif .mp4 .webm .mov .avi`

**Cache:** `<SGA_HOME>/model-index.json` (atomic write via `.tmp` + `fs.rename`).

**Failure behavior:** See §6 (no degradation — error propagates).

### 4.2 NodeDef extension (`node-def-index.ts`)

Extend `NodeDef` to capture widget definitions (which include model-name `options` lists):

```ts
export interface NodeDefWidget {
  name: string
  type: string            // "STRING" | "INT" | "FLOAT" | "BOOLEAN" | "combo"
  options?: string[]      // for combo widgets — this IS the ComfyUI dropdown source
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
  widgets: NodeDefWidget[]   // NEW — extracted from /object_info input.required
  deprecated?: boolean
  experimental?: boolean
}
```

**Backward compatibility:** `widgets` is additive. Existing `getNodeDef` consumers see the new field but don't have to use it. No breaking changes.

The normalizer in `node-def-index.ts` (the `loadFromEntries` function) is updated to extract widget definitions from the `/object_info` response shape:

```
object_info[name].input.required[widgetName] = [type, { options: [...], default: ..., min: ..., max: ... }]
object_info[name].input.optional[widgetName] = ...
```

### 4.3 model-categories.ts (shared constants)

Extracted from `comfyui-model-list.ts` to share between the tool and the validator:

```ts
export const MODEL_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.bin', '.pth', '.onnx', '.engine'])
export const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov', '.avi'])

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

// Node type → (widget name, category) mapping for missing-model validation
export const MODEL_LOADER_MAPPING: Record<string, { widget: string; category: string }> = {
  CheckpointLoaderSimple: { widget: 'ckpt_name', category: 'checkpoints' },
  CheckpointLoader:       { widget: 'ckpt_name', category: 'checkpoints' },
  LoraLoader:             { widget: 'lora_name', category: 'loras' },
  LoraLoaderModelOnly:    { widget: 'lora_name', category: 'loras' },
  VAELoader:               { widget: 'vae_name', category: 'vae' },
  ControlNetLoader:        { widget: 'control_net_name', category: 'controlnet' },
  UpscaleModelLoader:      { widget: 'model_name', category: 'upscale_models' },
  CLIPLoader:              { widget: 'clip_name', category: 'clip' },
  CLIPVisionLoader:        { widget: 'clip_name', category: 'clip' },
  UNETLoader:              { widget: 'unet_name', category: 'unet' },
  UNETLoaderGGUF:          { widget: 'unet_name', category: 'unet' },
  HypernetworkLoader:      { widget: 'hypernetwork_name', category: 'hypernetworks' },
  GligenLoader:            { widget: 'gligen_name', category: 'gligen' },
  EmbeddingLoader:         { widget: 'embedding_name', category: 'embeddings' },
  // Add more as needed; unknown loaders fall through to a widget-name heuristic.
}

export const MEDIA_LOADER_TYPES = new Set([
  'LoadImage', 'LoadImageMask', 'LoadImageBatch',
  'LoadVideo', 'VHS_LoadVideo', 'VHS_LoadVideoPath',
])
```

`comfyui-model-list.ts` is refactored to import from this module. Its external tool behavior is unchanged.

## 5. Environment Configuration

| Env var                     | Default             | Purpose                                                    |
| --------------------------- | ------------------- | ---------------------------------------------------------- |
| `SGA_MODEL_INDEX_TTL_MS`    | `300000` (5 min)    | ModelIndex cache TTL                                       |
| `SGA_MAX_REROUTE_DEPTH`     | `8`                 | unsupported-structure rule (c) threshold                   |
| `SGA_NODE_DEF_INDEX_TTL_MS` | `120000` (existing) | Existing NodeDefIndex TTL — surface to env for consistency |

Validators read these via a small `config.ts` helper (or directly via `process.env` with the `||` fallback pattern from `api-base.ts`).

## 6. Failure Handling — No Degradation

**Design principle:** When ComfyUI is offline, the SGA agent itself is offline (its tools and chat endpoints are unreachable). Therefore the validator does not implement silent degradation.

| Failure                                                                              | Behavior                                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `NodeDefIndex` fetch fails AND no cache file                                         | `NodeDefIndex.getNodeDef()` throws → validator throws → `validateWorkflow()` rejects with the original error |
| `ModelIndex` filesystem scan fails (e.g. `COMFYUI_BASE_DIR` unset, permission error) | `ModelIndex` throws → validator throws → `validateWorkflow()` rejects                                        |
| Validator encounters a malformed workflow (missing `nodes` or `links` field)         | Throws `Error('Invalid workflow: missing nodes[]')` etc.                                                     |

**Rationale:** The caller (SGA agent / API handler) already knows whether ComfyUI is reachable — it should not call `validateWorkflow()` when ComfyUI is offline. Silent degradation would mask real problems (e.g. misconfigured `COMFYUI_BASE_DIR` looks identical to "no models installed").

The existing `NodeDefIndex` stale-cache fallback (from the merged PR) is **kept as-is** — it's a different concern (cache resilience within NodeDefIndex, not validator-level degradation).

## 7. Test Strategy

### 7.1 Fixture corpus (`sga_template/src/comfyui/validators/__fixtures__/`)

10 JSON files, one per scenario. Each fixture:

```json
{
  "name": "txt2img-basic",
  "description": "Standard txt2img workflow with CLIPTextEncode, KSampler, VAE Decode",
  "objectInfo": { ... },          // minimal /object_info stub for NodeDefIndex
  "models": {                     // minimal ModelIndex stub
    "checkpoints": ["v1-5-pruned-emaonly.safetensors"],
    "loras": []
  },
  "input": [],                    // media files present
  "workflow": { "nodes": [...], "links": [...] },
  "expectedIssueIds": ["missing_model:node_3", "port_type_mismatch:link_5"]
}
```

Fixtures:

1. `txt2img-basic.json` — clean workflow
2. `img2img-basic.json` — clean workflow with LoadImage
3. `controlnet-basic.json` — clean workflow with ControlNet
4. `lora-stack.json` — multiple LoraLoaders
5. `multi-output.json` — workflow branches to multiple SaveImage
6. `missing-model.json` — CheckpointLoaderSimple references non-existent checkpoint
7. `missing-custom-node.json` — workflow uses "CustomNode\_X" not in object\_info
8. `malformed-links.json` — dangling link, slot OOB, bidirectional inconsistency
9. `widget-schema-mismatch.json` — INT widget fed STRING via Primitive
10. `reroute-chain-deep.json` — 10-deep Reroute chain

`fixture-loader.ts` reads + parses each fixture and provides typed access:

```ts
export interface LoadedFixture {
  name: string
  description: string
  objectInfo: Record<string, unknown>
  models: Record<string, string[]>
  input: string[]
  workflow: Record<string, unknown>
  expectedIssueIds: string[]
}
export function loadFixture(name: string): LoadedFixture
export function listFixtures(): string[]
```

### 7.2 Test files

| File                                      | Tests | Notes                                                                                                                                                 |
| ----------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model-index.test.ts`                     | 6     | Mirrors `node-def-index.test.ts` structure: empty / fresh / cache-file / stale / unknown / multi-category                                             |
| `missing-ref-validator.test.ts`           | 8     | clean / missing ckpt / missing lora / missing vae / missing media / present-on-disk-not-in-widget-options / unknown loader type / unknown widget name |
| `illegal-link-validator.test.ts`          | 8     | clean / dangling / slot OOB / bidirectional / self-loop / multiple violations / valid link ignored / source=native                                    |
| `unsupported-structure-validator.test.ts` | 8     | clean / reroute unconnected / Note orphaned / Primitive orphaned / 8-deep OK / 9-deep warn / Primitive multi-type / source=native                     |
| `validate-workflow.test.ts`               | 3     | runs all 4 / dedup by id / source ordering                                                                                                            |
| `fixture-loader.test.ts`                  | 1     | all 10 fixtures parse and have required fields                                                                                                        |

**Total new tests: \~34** (plus 10 fixtures). Existing 28 tests untouched.

### 7.3 Test setup pattern

Following the existing pattern from `port-type-validator.test.ts`:

* `vi.stubEnv('SGA_HOME', '<tmpdir>')` to redirect cache files

* `vi.stubGlobal('fetch', vi.fn(...))` to stub `/object_info` (return fixture's `objectInfo`)

* Stub `ModelIndex` filesystem scan by pointing `COMFYUI_BASE_DIR` at fixture's virtual fs (or by mocking `getModelFile` directly — fixture-driven approach preferred)

For Branch A, the existing `vi.useFakeTimers()` + `vi.resetModules()` pattern from `node-def-index.test.ts` is reused.

## 8. Approach C — Graph Walker + Rule Plugins (Branch C, future default)

Sketched here; full plan deferred to a follow-up spec after Branch A lands.

### 8.1 Architecture

```ts
// graph-walker.ts
export interface CompiledGraph {
  nodes: Map<number, GraphNodeContext>
  links: GraphLink[]
  linksByNode: Map<number, { incoming: GraphLink[]; outgoing: GraphLink[] }>
}
export function compileGraph(workflow: Record<string, unknown>): CompiledGraph

// rule.ts
export interface ValidationRule {
  id: string
  run(graph: CompiledGraph): Promise<WorkflowIssue[]> | WorkflowIssue[]
}

// validator-registry.ts
export const RULES: ValidationRule[] = [
  portTypeRule,
  missingModelRule,
  missingMediaRule,
  danglingLinkRule,
  slotOobRule,
  bidirectionalLinkRule,
  selfLoopRule,
  rerouteUnconnectedRule,
  orphanedAuxRule,
  deepRerouteChainRule,
  primitiveMultiTypeRule,
]

// validate-workflow.ts
export async function validateWorkflow(workflow: Record<string, unknown>): Promise<WorkflowIssue[]> {
  const graph = compileGraph(workflow)         // single walk
  const results = await Promise.all(RULES.map(r => Promise.resolve(r.run(graph))))
  return dedupById(results.flat())
}
```

### 8.2 Differences from Branch A

| Aspect                                | Branch A (modular)                  | Branch C (graph walker)          |
| ------------------------------------- | ----------------------------------- | -------------------------------- |
| Graph walk                            | Once per validator (4× total)       | Once total (`compileGraph`)      |
| Rule definition                       | Function per file                   | `ValidationRule` object          |
| Adding new rule                       | New file + register in orchestrator | Push to `RULES` array            |
| Rule API                              | Free-form signature                 | Standardized `(graph) => issues` |
| Testability                           | Validator-level (current pattern)   | Rule-level (more granular)       |
| Migration of `port-type-validator.ts` | Untouched                           | Refactored into `portTypeRule`   |

### 8.3 Defaults

Branch C becomes the default for:

* `ModelIndex` (the new `model-index.ts` is shared, but Branch C's `missingModelRule` is the canonical consumer)

* Reroute rules (consolidated under `deepRerouteChainRule` + `rerouteUnconnectedRule`)

After both PRs merge, Branch A's modular files are deprecated in favor of Branch C's rule plugins (deprecation path: 1 release with both available, then remove Branch A's modular files).

## 9. PR Strategy

### PR 1: Approach A (this branch)

**Branch:** `feat/validation-engine-modular` (new branch from `main` after PR #1 of the previous feature merges)
**Implements:** All of §2, §3, §4, §5, §6, §7
**Size:** \~10 new files + 10 fixtures + \~34 tests
**Reviewer note:** Approach C is sketched in §8 but NOT implemented in this PR.

### PR 2: Approach C (parallel branch)

**Branch:** `feat/validation-engine-graph-walker` (new branch from `main`, can be developed in parallel with PR 1)
**Implements:** §8 (full graph walker + rule plugins, refactor of `port-type-validator.ts` into `portTypeRule`)
**Size:** similar to PR 1 (shares fixtures and rules; differs in code organization)
**Lands after PR 1** to avoid merge conflicts on the shared modules (`model-index.ts`, `model-categories.ts`, etc.).

Both PRs use the SAME fixtures and the SAME rule semantics — they differ only in code organization.

## 10. Backward Compatibility

* `NodeDef` schema extension is additive — existing consumers see new `widgets` field, no breakage.

* `comfyui-model-list.ts` refactored to import from `model-categories.ts`; external tool behavior unchanged.

* `port-type-validator.ts` untouched (Approach A) / refactored (Approach C, but only on Branch C).

* No public API removals.

## 11. Open Questions (resolve during plan writing)

1. **Fixture** **`objectInfo`** **shape** — should fixtures include a full `/object_info` stub, or only the node types they reference? (Lean: minimal — only referenced types, to keep fixtures small.)
2. **~~`ModelIndex`~~~~media scan depth~~**  ~~— recursive or flat for~~ ~~`input/`?~~ **Resolved:** recursive (see §4.1).
3. **`MODEL_LOADER_MAPPING`** **completeness** — should we cover all custom-node loaders (AnimateDiff, IPAdapter, etc.) or just core ComfyUI loaders? (Lean: core only for v1; custom-node loaders fall through to widget-name heuristic.)
4. **Dedup collision** — what if two validators legitimately flag the same node with different `id` strings? (Lean: keep both — `id` includes the rule name, so collisions mean different issues.)

## 12. Acceptance Criteria

* [ ] All 4 new validation rules implemented (Approach A) with the exact semantics in §2.

* [ ] 10 fixtures present and parseable by `fixture-loader.ts`.

* [ ] \~34 new tests pass; existing 28 tests still pass; `tsc --noEmit` clean.

* [ ] Env vars `SGA_MODEL_INDEX_TTL_MS` and `SGA_MAX_REROUTE_DEPTH` honored.

* [ ] No degradation logic — failures propagate (per §6).

* [ ] `comfyui-model-list.ts` refactored to use shared `model-categories.ts`; tool behavior unchanged.

* [ ] `NodeDef.widgets` field populated from `/object_info` for at least the loader node types in `MODEL_LOADER_MAPPING`.

* [ ] PR 1 (Approach A) mergeable independently; PR 2 (Approach C) plan sketched in §8.

## References

* Predecessor plan: `docs/superpowers/plans/2026-06-28-node-def-index-and-port-validator.md`

* Capability plan: `docs/workflow-domain-capability-plan.md` (Workstreams 3 + 6)

* Architecture: `ARCHITECTURE.md`

* Existing patterns: `sga_template/src/comfyui/node-def-index.ts`, `sga_template/src/comfyui/validators/port-type-validator.ts`, `sga_template/src/tools/built-in/comfyui-model-list.ts`

