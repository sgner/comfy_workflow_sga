# Validation Engine — Approach C (Graph Walker + Rule Plugins) Design Spec

**Date:** 2026-06-29
**Status:** Draft (pending user review)
**Scope:** Full implementation of spec §8 from `2026-06-28-workflow-validation-engine-completion-design.md`
**Predecessor:** `feat/validation-engine-modular` (PR 1, Approach A — modular validators)
**This branch:** `feat/validation-engine-graph-walker` (stacked on PR 1)

## 1. Goal & Scope

Implement Approach C from §8 of the predecessor spec: a graph-walker + rule-plugin architecture that performs a single graph walk and runs all rules against the compiled graph. Same 4 validation rules and same 10 fixtures as Approach A — differs only in code organization.

### In scope

* `compileGraph()` — single-walk graph compiler producing `CompiledGraph`.
* `ValidationRule` interface — standardized rule contract.
* 11 rule plugins covering the same semantics as Approach A's 4 modular validators.
* New `validate-workflow.ts` orchestrator using `compileGraph` + `RULES`.
* Per-rule unit tests + integration test reusing Approach A's 10 fixtures.

### Out of scope

* New validation rules — semantics match Approach A exactly (cross-implementation consistency).
* New fixtures — reuse Approach A's 10-fixture corpus.
* New env vars — inherit existing (`SGA_MODEL_INDEX_TTL_MS`, `SGA_MAX_REROUTE_DEPTH`, `SGA_NODE_DEF_INDEX_TTL_MS`).
* Removal of Approach A's modular files — deferred to a follow-up PR after the deprecation period (per §8.3).

## 2. Architecture

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
  portTypeRule, missingModelRule, missingMediaRule,
  danglingLinkRule, slotOobRule, bidirectionalLinkRule, selfLoopRule,
  rerouteUnconnectedRule, orphanedAuxRule, deepRerouteChainRule, primitiveMultiTypeRule,
]

// validate-workflow.ts
export async function validateWorkflow(workflow: Record<string, unknown>): Promise<WorkflowIssue[]> {
  const graph = compileGraph(workflow)
  const results = await Promise.all(RULES.map(r => Promise.resolve(r.run(graph))))
  return dedupById(results.flat())
}
```

### Key differences from Approach A (per §8.2)

| Aspect | Approach A | Approach C |
|---|---|---|
| Graph walk | Once per validator (4×) | Once total (`compileGraph`) |
| Rule definition | Function per file | `ValidationRule` object |
| Adding new rule | New file + register in orchestrator | Push to `RULES` array |
| Rule API | Free-form signature | Standardized `(graph) => issues` |
| Testability | Validator-level | Rule-level (more granular) |

## 3. File Layout

```
sga_template/src/comfyui/validators/graph-walker/
├── graph-walker.ts              # compileGraph() + CompiledGraph interface
├── graph-walker.test.ts         # compileGraph unit tests
├── rule.ts                      # ValidationRule interface
├── validator-registry.ts        # RULES array (imports all rules)
├── validate-workflow.ts         # orchestrator: compileGraph + Promise.all + dedup
├── validate-workflow.test.ts    # integration test (reuses 10 fixtures)
└── rules/
    ├── port-type.ts             # portTypeRule (async — NodeDefIndex)
    ├── port-type.test.ts
    ├── missing-model.ts         # missingModelRule (async — ModelIndex)
    ├── missing-model.test.ts
    ├── missing-media.ts         # missingMediaRule (async — ModelIndex)
    ├── missing-media.test.ts
    ├── dangling-link.ts         # danglingLinkRule (sync)
    ├── dangling-link.test.ts
    ├── slot-oob.ts              # slotOobRule (sync)
    ├── slot-oob.test.ts
    ├── bidirectional-link.ts    # bidirectionalLinkRule (sync)
    ├── bidirectional-link.test.ts
    ├── self-loop.ts             # selfLoopRule (sync)
    ├── self-loop.test.ts
    ├── reroute-unconnected.ts   # rerouteUnconnectedRule (sync)
    ├── reroute-unconnected.test.ts
    ├── orphaned-aux.ts          # orphanedAuxRule (sync)
    ├── orphaned-aux.test.ts
    ├── deep-reroute-chain.ts    # deepRerouteChainRule (sync, SGA_MAX_REROUTE_DEPTH)
    ├── deep-reroute-chain.test.ts
    ├── primitive-multi-type.ts  # primitiveMultiTypeRule (async — NodeDefIndex)
    └── primitive-multi-type.test.ts
```

Approach A's files in `validators/` top level (`port-type-validator.ts`, `missing-ref-validator.ts`, `illegal-link-validator.ts`, `unsupported-structure-validator.ts`, `validate-workflow.ts`) remain untouched. Both orchestrators coexist during the deprecation period (per §8.3).

## 4. CompiledGraph & Rule Interface

### `CompiledGraph`

* `nodes: Map<number, GraphNodeContext>` — id-indexed node map. Reuses `buildNodeMap()` from `graph-utils.ts`.
* `links: GraphLink[]` — flat link list. Reuses `buildLinkList()` from `graph-utils.ts`.
* `linksByNode: Map<number, { incoming: GraphLink[]; outgoing: GraphLink[] }>` — per-node link index, built during `compileGraph()` in O(links) time. Eliminates per-rule `links.find()` scans.

### `ValidationRule`

* `id: string` — rule identifier (e.g., `"portType"`, `"missingModel"`). Used for diagnostics, not for issue ids (issue ids follow §2 of the predecessor spec).
* `run(graph: CompiledGraph): Promise<WorkflowIssue[]> | WorkflowIssue[]` — sync or async per rule. Orchestrator wraps in `Promise.resolve()`.

### `compileGraph(workflow)`

1. Calls `buildNodeMap(workflow)` to get `nodes` Map.
2. Calls `buildLinkList(workflow)` to get `links` array.
3. Builds `linksByNode` index by iterating `links` once: each link pushes to `incoming[toNodeId]` and `outgoing[fromNodeId]`.
4. Returns `{ nodes, links, linksByNode }`.

No async — graph compilation is pure synchronous graph topology.

## 5. Rules (11 total)

Issue id format matches Approach A exactly (cross-implementation consistency, verified by the shared 10-fixture corpus):

| # | Rule | Sync/Async | Issue id format | Maps to Approach A |
|---|---|---|---|---|
| 1 | `portTypeRule` | async (NodeDef) | `port_type_mismatch:<nodeId>:<slot>` | `port-type-validator.ts` |
| 2 | `missingModelRule` | async (ModelIndex) | `missing_model:<nodeId>` | `missing-ref-validator.ts` (model part) |
| 3 | `missingMediaRule` | async (ModelIndex) | `missing_media:<nodeId>` | `missing-ref-validator.ts` (media part) |
| 4 | `danglingLinkRule` | sync | `illegal_link:<linkId>:dangling` | `illegal-link-validator.ts` (a) |
| 5 | `slotOobRule` | sync | `illegal_link:<linkId>:slot_oob` | `illegal-link-validator.ts` (b) |
| 6 | `bidirectionalLinkRule` | sync | `illegal_link:<linkId>:bidirectional` | `illegal-link-validator.ts` (c) |
| 7 | `selfLoopRule` | sync | `illegal_link:<linkId>:self_loop` | `illegal-link-validator.ts` (d) |
| 8 | `rerouteUnconnectedRule` | sync | `unsupported_structure:<nodeId>:reroute_unconnected` | `unsupported-structure-validator.ts` (a) |
| 9 | `orphanedAuxRule` | sync | `unsupported_structure:<nodeId>:orphaned_aux` | `unsupported-structure-validator.ts` (b) |
| 10 | `deepRerouteChainRule` | sync | `unsupported_structure:<nodeId>:deep_reroute_chain` | `unsupported-structure-validator.ts` (c) |
| 11 | `primitiveMultiTypeRule` | async (NodeDef) | `unsupported_structure:<nodeId>:primitive_multi_type` | `unsupported-structure-validator.ts` (d) |

Each rule consumes `CompiledGraph` plus its required external services (NodeDefIndex / ModelIndex) via the same shared modules used by Approach A. No duplication of business logic — same shared modules, different rule packaging.

### Cycle detection in `deepRerouteChainRule`

Inherits Approach A's cycle-detection fix (commit `e56209b`): chain walk tracks visited nodes and breaks on revisit. Same algorithm, same `SGA_MAX_REROUTE_DEPTH` env default (8).

## 6. Orchestrator (`validate-workflow.ts`)

```ts
export async function validateWorkflow(workflow: Record<string, unknown>): Promise<WorkflowIssue[]> {
  const graph = compileGraph(workflow)
  const results = await Promise.all(RULES.map(r => Promise.resolve(r.run(graph))))
  return dedupById(results.flat())
}

function dedupById(issues: WorkflowIssue[]): WorkflowIssue[] {
  return Array.from(new Map(issues.map(i => [i.id, i])).values())
}
```

`compileGraph` runs once. All rules share the same `CompiledGraph` instance. Sync rules resolve immediately via `Promise.resolve()`; async rules (portType, missingModel, missingMedia, primitiveMultiType) await their external service calls. `dedupById` uses the same Map-based dedup as Approach A.

## 7. Test Strategy

### Unit tests (per rule)

Each rule has its own `.test.ts` file with focused tests:
* Happy path (clean graph → no issues).
* Each trigger condition for that rule → expected issue.
* Edge cases (empty graph, missing fields, cycle termination for deep-reroute).

### Integration test (`validate-workflow.test.ts`)

Reuses Approach A's 10 fixtures via the shared `fixture-loader.ts`. For each fixture:
1. Stub `fetch` to return `fixture.objectInfo`.
2. Create model/media files on disk per `fixture.models` and `fixture.input`.
3. Clear `node-defs.json` cache file (same cache-isolation fix as Approach A's commit `f124939`).
4. Run `validateWorkflow(fixture.workflow)`.
5. Assert every `expectedIssueIds` entry is present in the output.

### Cross-implementation consistency

Implicitly verified: same fixtures + same issue id format = same expected ids. If Approach C produces a different issue id than Approach A for the same fixture, the integration test fails.

### Cache isolation

Apply the same fix as Approach A's commit `f124939`: clear `<tmpHome>/node-defs.json` before each `vi.resetModules()` in the integration test loop, so each iteration re-fetches its own stubbed `objectInfo`.

## 8. Environment Configuration

Inherits existing env vars (no new env vars):

| Env var | Default | Used by |
|---|---|---|
| `SGA_MODEL_INDEX_TTL_MS` | 300000 | Shared `ModelIndex` (consumed by `missingModelRule` / `missingMediaRule`) |
| `SGA_MAX_REROUTE_DEPTH` | 8 | `deepRerouteChainRule` |
| `SGA_NODE_DEF_INDEX_TTL_MS` | 120000 | Shared `NodeDefIndex` (consumed by `portTypeRule` / `primitiveMultiTypeRule`) |
| `COMFYUI_BASE_DIR` | (required) | Shared `ModelIndex` filesystem scan |
| `SGA_HOME` | (required) | Shared `NodeDefIndex` / `ModelIndex` cache files |

This matches the user's direction: "可作为 Modelindex 和 Reroute 的默认值，需要再 env 里配置" — Approach C inherits the env-configurable defaults already implemented by Approach A.

## 9. Failure Handling — No Degradation

Per spec §6 of the predecessor: no `try/catch` around external service calls. If `NodeDefIndex.ensureLoaded()` throws (e.g., ComfyUI offline → `/object_info` fetch fails), `portTypeRule` and `primitiveMultiTypeRule` propagate the error, `Promise.all` rejects, `validateWorkflow()` rejects.

This matches the user's direction: "comfyui 离线时 agent 同时也会下线降级无意义" — ComfyUI offline → agent offline, no silent degradation.

## 10. Backward Compatibility

* Approach A's files (`validators/port-type-validator.ts`, `missing-ref-validator.ts`, `illegal-link-validator.ts`, `unsupported-structure-validator.ts`, `validate-workflow.ts`) remain untouched and functional.
* Approach A's `validate-workflow.test.ts` continues to pass (regression coverage).
* Approach C's new `validate-workflow.ts` lives at `validators/graph-walker/validate-workflow.ts` — different import path, no naming conflict.
* `port-type-validator.ts` is NOT refactored into `portTypeRule` — Approach C provides a fresh `port-type.ts` rule that mirrors its logic. (Diverges from §8.2's table to avoid breaking Approach A's tests during the deprecation period. The original spec language "refactored into" can be read as "newly implemented as" — both implementations coexist.)
* Deprecation markers: Approach A's modular validator files get `/** @deprecated Use graph-walker/rules/*.ts instead. Will be removed after the next release. */` JSDoc on their exported functions.

### Deprecation path (per §8.3)

1. **This PR:** Approach C lands. Both implementations coexist. Approach A's files marked `@deprecated`.
2. **Next release:** Both implementations available. Consumers migrate to Approach C.
3. **Release after:** Approach A's modular validator files removed. Approach C becomes the only implementation.

## 11. Branch & PR Strategy

* **Branch:** `feat/validation-engine-graph-walker` (created from `feat/validation-engine-modular` — stacked).
* **PR base:** `feat/validation-engine-modular` (GitHub stacked PR).
* **After PR 1 merges to `main`:** Rebase `feat/validation-engine-graph-walker` onto `main`. PR 2 becomes an independent PR against `main`.
* **Commit style:** `feat(comfyui-graph-walker): ...` to distinguish from Approach A's `feat(comfyui): ...`.

## 12. Acceptance Criteria

* [ ] `compileGraph()` produces `CompiledGraph` with correct `nodes`, `links`, and `linksByNode` index.
* [ ] All 11 rules implemented with issue id format matching Approach A.
* [ ] Per-rule unit tests pass (≥1 test per rule trigger condition).
* [ ] Integration test reuses all 10 fixtures; all `expectedIssueIds` confirmed present.
* [ ] Cross-implementation consistency: same fixture → same issue ids as Approach A.
* [ ] `tsc --noEmit` clean.
* [ ] Existing Approach A tests still pass (no regression).
* [ ] Env vars `SGA_MODEL_INDEX_TTL_MS`, `SGA_MAX_REROUTE_DEPTH`, `SGA_NODE_DEF_INDEX_TTL_MS` honored.
* [ ] No degradation logic — failures propagate (per §9).
* [ ] Approach A's files marked `@deprecated`.
* [ ] PR is stackable on `feat/validation-engine-modular` and rebaseable onto `main` after PR 1 merges.

## 13. Open Questions (resolve during plan writing)

1. **`portTypeRule` issue id format** — Approach A's `port-type-validator.ts` uses `port_type_mismatch:<nodeId>:<slot>`. Confirm exact format during plan writing by reading the existing validator's source.
2. **`deepRerouteChainRule` start-node selection** — Approach A walks from each Reroute with no incoming reroute link. Confirm whether Approach C should match this or walk from every Reroute (and dedup by visited set). Lean: match Approach A.
3. **`orphanedAuxRule` Note vs PrimitiveNode** — Approach A treats both as "aux" nodes. Confirm same scope in Approach C. Lean: same.

## 14. References

* Predecessor spec: `docs/superpowers/specs/2026-06-28-workflow-validation-engine-completion-design.md` (§8 sketches Approach C; §9 PR strategy)
* Predecessor plan: `docs/superpowers/plans/2026-06-28-validation-engine-completion.md` (Approach A implementation)
* SDD Ledger: `.superpowers/sdd/progress.md` (Approach A completion record)
