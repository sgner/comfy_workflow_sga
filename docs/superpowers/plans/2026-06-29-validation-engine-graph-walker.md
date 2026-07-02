# Approach C (Graph Walker + Rule Plugins) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a graph-walker + rule-plugin validation architecture that performs a single graph walk and runs all rules against the compiled graph, producing identical issue ids to Approach A.

**Architecture:** `compileGraph(workflow)` builds a `CompiledGraph` once (nodes Map + links array + linksByNode index). Each `ValidationRule` receives the compiled graph and returns issues. Orchestrator runs all rules in parallel via `Promise.all` and dedups by id. Lives in `validators/graph-walker/` subdirectory, coexists with Approach A's modular files during deprecation period.

**Tech Stack:** TypeScript, Vitest, Node.js fs/promises. Reuses shared modules from Approach A (graph-utils, node-def-index, model-index, model-categories, issue-types, fixture-loader).

## Global Constraints

- **Issue id format MUST match Approach A exactly** (cross-implementation consistency, verified by shared 10-fixture corpus):
  - `unknown_node_type:${node.id}:${node.type}` (warning)
  - `port_type_mismatch:${linkId}` (error) — link id only, NOT nodeId:slot
  - `orphaned_output:${node.id}:${slot}` (info)
  - `missing_required_widget:${node.id}` (warning)
  - `missing_model:${node.id}` (warning)
  - `missing_media:${node.id}` (warning)
  - `illegal_link:${link.id}:dangling|slot_oob|self_loop|bidirectional` (error)
  - `unsupported_structure:${node.id}:reroute_unconnected|orphaned_aux|deep_reroute_chain|primitive_multi_type` (info)
- **Source: 'native'** on all issues
- **No degradation:** no try/catch around external service calls; errors propagate (per spec §9)
- **Inherit env vars:** `SGA_MODEL_INDEX_TTL_MS` (300000), `SGA_MAX_REROUTE_DEPTH` (8), `SGA_NODE_DEF_INDEX_TTL_MS` (120000), `COMFYUI_BASE_DIR`, `SGA_HOME` — no new env vars
- **File layout:** all new files under `sga_template/src/comfyui/validators/graph-walker/` (subdirectory). Approach A's files in `validators/` top level remain untouched.
- **Branch:** `feat/validation-engine-graph-walker` (stacked on `feat/validation-engine-modular`)
- **Commit prefix:** `feat(comfyui-graph-walker): ...` (to distinguish from Approach A's `feat(comfyui): ...`)
- **Test commands:** `cd sga_template; npm run typecheck` (expect 0 errors); `cd sga_template; npm test` (expect all green)
- **PowerShell note:** use `;` not `&&` to separate commands. For multi-line commit messages, write to a temp file and use `git commit -F <file>`.

---

## Spec corrections (applied inline)

The spec §5 table has two inaccuracies that this plan corrects by reading Approach A's source:

1. **`portTypeRule` issue id format** — spec §5 table says `port_type_mismatch:<nodeId>:<slot>`, but Approach A's `port-type-validator.ts` line 100 uses `port_type_mismatch:${link[0]}` (link id only, NOT nodeId:slot). This plan uses the correct format: `port_type_mismatch:${link.id}`.
2. **`portTypeRule` emits 4 issue ids, not 1** — spec §5 table lists only `port_type_mismatch` for `portTypeRule`, but Approach A's `port-type-validator.ts` emits 4 distinct issue ids: `unknown_node_type`, `port_type_mismatch`, `orphaned_output`, `missing_required_widget`. This plan ports all 4 sub-rules into `portTypeRule`.

---

## Task 1: Foundation — graph-walker.ts, rule.ts, validator-registry.ts, validate-workflow.ts skeleton

**Files:**
- Create: `sga_template/src/comfyui/validators/graph-walker/graph-walker.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/graph-walker.test.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rule.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/validator-registry.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/validate-workflow.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/validate-workflow.test.ts`

**Interfaces:**
- Consumes: `buildNodeMap`, `buildLinkList`, `GraphNodeContext`, `GraphLink` from `../../graph-utils.js`; `WorkflowIssue` from `../../issue-types.js`.
- Produces: `CompiledGraph` interface, `compileGraph(workflow)`, `ValidationRule` interface, `RULES` array, `validateWorkflow(workflow)`, `dedupById(issues)`.

- [ ] **Step 1.1: Write failing tests for compileGraph** — Create `sga_template/src/comfyui/validators/graph-walker/graph-walker.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { compileGraph } from './graph-walker.js'

describe('compileGraph', () => {
  it('returns empty graph for empty workflow', () => {
    const graph = compileGraph({ nodes: [], links: [] })
    expect(graph.nodes.size).toBe(0)
    expect(graph.links).toHaveLength(0)
    expect(graph.linksByNode.size).toBe(0)
  })

  it('builds nodes map from workflow nodes with null def', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'KSampler' },
        { id: 2, type: 'CLIPTextEncode' },
      ],
      links: [],
    })
    expect(graph.nodes.size).toBe(2)
    expect(graph.nodes.get(1)?.node.type).toBe('KSampler')
    expect(graph.nodes.get(1)?.def).toBeNull()
    expect(graph.nodes.get(2)?.id).toBe(2)
  })

  it('builds links array and linksByNode index with incoming/outgoing', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    expect(graph.links).toHaveLength(1)
    expect(graph.links[0]).toEqual({
      id: 1, fromNodeId: 1, fromSlot: 0, toNodeId: 2, toSlot: 0, type: 'MODEL',
    })
    expect(graph.linksByNode.get(1)?.outgoing).toHaveLength(1)
    expect(graph.linksByNode.get(1)?.incoming).toHaveLength(0)
    expect(graph.linksByNode.get(2)?.incoming).toHaveLength(1)
    expect(graph.linksByNode.get(2)?.outgoing).toHaveLength(0)
    // Same link object reference shared between incoming and outgoing
    expect(graph.linksByNode.get(1)?.outgoing[0]).toBe(graph.links[0])
    expect(graph.linksByNode.get(2)?.incoming[0]).toBe(graph.links[0])
  })

  it('handles multiple links per node', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1, 2] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
        { id: 3, type: 'C', inputs: [{ name: 'in', type: 'MODEL', link: 2 }] },
      ],
      links: [
        [1, 1, 0, 2, 0, 'MODEL'],
        [2, 1, 0, 3, 0, 'MODEL'],
      ],
    })
    expect(graph.linksByNode.get(1)?.outgoing).toHaveLength(2)
    expect(graph.linksByNode.get(2)?.incoming).toHaveLength(1)
    expect(graph.linksByNode.get(3)?.incoming).toHaveLength(1)
  })

  it('returns no linksByNode entry for nodes with no links', () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'A' }],
      links: [],
    })
    expect(graph.linksByNode.has(1)).toBe(false)
  })
})
```

- [ ] **Step 1.2: Write failing tests for validateWorkflow** — Create `sga_template/src/comfyui/validators/graph-walker/validate-workflow.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WorkflowIssue } from '../../issue-types.js'

describe('validate-workflow', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns empty issues for empty workflow', async () => {
    const { validateWorkflow } = await import('./validate-workflow.js')
    const issues = await validateWorkflow({ nodes: [], links: [] })
    expect(issues).toEqual([])
  })

  it('deduplicates issues by id', async () => {
    const { RULES } = await import('./validator-registry.js')
    const mockIssue: WorkflowIssue = {
      id: 'test:1', nodeId: 1, severity: 'info', message: 'test', source: 'native',
    }
    RULES.push({
      id: 'mockDuplicate',
      run: () => [mockIssue, { ...mockIssue }],
    })
    const { validateWorkflow } = await import('./validate-workflow.js')
    const issues = await validateWorkflow({ nodes: [], links: [] })
    expect(issues.filter(i => i.id === 'test:1')).toHaveLength(1)
  })
})
```

- [ ] **Step 1.3: Run tests to verify they fail** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/`
Expected: FAIL with "Cannot find module './graph-walker.js'" and "Cannot find module './validate-workflow.js'".

- [ ] **Step 1.4: Implement graph-walker.ts** — Create `sga_template/src/comfyui/validators/graph-walker/graph-walker.ts`:

```ts
/**
 * Graph Walker — compiles a ComfyUI workflow into a CompiledGraph that
 * all validation rules share. Single walk; rules reuse the result.
 *
 * Pure synchronous graph topology — no async, no external services.
 */
import {
  buildNodeMap,
  buildLinkList,
  type GraphNodeContext,
  type GraphLink,
} from '../../graph-utils.js'

export interface CompiledGraph {
  nodes: Map<number, GraphNodeContext>
  links: GraphLink[]
  linksByNode: Map<number, { incoming: GraphLink[]; outgoing: GraphLink[] }>
}

export function compileGraph(workflow: Record<string, unknown>): CompiledGraph {
  const nodes = buildNodeMap(workflow)
  const links = buildLinkList(workflow)
  const linksByNode = new Map<number, { incoming: GraphLink[]; outgoing: GraphLink[] }>()
  for (const link of links) {
    let fromEntry = linksByNode.get(link.fromNodeId)
    if (!fromEntry) {
      fromEntry = { incoming: [], outgoing: [] }
      linksByNode.set(link.fromNodeId, fromEntry)
    }
    fromEntry.outgoing.push(link)
    let toEntry = linksByNode.get(link.toNodeId)
    if (!toEntry) {
      toEntry = { incoming: [], outgoing: [] }
      linksByNode.set(link.toNodeId, toEntry)
    }
    toEntry.incoming.push(link)
  }
  return { nodes, links, linksByNode }
}
```

- [ ] **Step 1.5: Implement rule.ts** — Create `sga_template/src/comfyui/validators/graph-walker/rule.ts`:

```ts
/**
 * ValidationRule — standardized contract for all graph-walker rules.
 * Each rule receives the compiled graph and returns issues.
 */
import type { WorkflowIssue } from '../../issue-types.js'
import type { CompiledGraph } from './graph-walker.js'

export interface ValidationRule {
  /** Rule identifier for diagnostics (e.g. "portType", "danglingLink"). Not the issue id. */
  id: string
  run(graph: CompiledGraph): Promise<WorkflowIssue[]> | WorkflowIssue[]
}
```

- [ ] **Step 1.6: Implement validator-registry.ts** — Create `sga_template/src/comfyui/validators/graph-walker/validator-registry.ts`:

```ts
/**
 * Rule registry — all validation rules registered here run on each validateWorkflow call.
 * Starts empty; later tasks append rules as they are implemented.
 */
import type { ValidationRule } from './rule.js'

export const RULES: ValidationRule[] = []
```

- [ ] **Step 1.7: Implement validate-workflow.ts** — Create `sga_template/src/comfyui/validators/graph-walker/validate-workflow.ts`:

```ts
/**
 * Orchestrator — compiles the graph once, runs all registered rules in
 * parallel via Promise.all, flattens, and deduplicates by issue id.
 *
 * No degradation (spec §9): if any rule throws, Promise.all rejects and
 * validateWorkflow propagates the error.
 */
import type { WorkflowIssue } from '../../issue-types.js'
import { compileGraph } from './graph-walker.js'
import { RULES } from './validator-registry.js'

export async function validateWorkflow(workflow: Record<string, unknown>): Promise<WorkflowIssue[]> {
  const graph = compileGraph(workflow)
  const results = await Promise.all(RULES.map(r => Promise.resolve(r.run(graph))))
  return dedupById(results.flat())
}

export function dedupById(issues: WorkflowIssue[]): WorkflowIssue[] {
  return Array.from(new Map(issues.map(i => [i.id, i])).values())
}
```

- [ ] **Step 1.8: Run tests to verify they pass** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/`
Expected: PASS (7 tests — 5 for compileGraph, 2 for validateWorkflow).

- [ ] **Step 1.9: Run typecheck** — Run: `cd sga_template; npm run typecheck`
Expected: 0 errors.

- [ ] **Step 1.10: Commit** — Run:
```powershell
git add sga_template/src/comfyui/validators/graph-walker/; git commit -m "feat(comfyui-graph-walker): add compileGraph, ValidationRule, registry, and orchestrator skeleton"
```

---

## Task 2: 4 sync illegal-link rules

**Files:**
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/dangling-link.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/dangling-link.test.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/slot-oob.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/slot-oob.test.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/self-loop.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/self-loop.test.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/bidirectional-link.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/bidirectional-link.test.ts`
- Modify: `sga_template/src/comfyui/validators/graph-walker/validator-registry.ts`

**Interfaces:**
- Consumes: `CompiledGraph` from `../graph-walker.js`; `ValidationRule` from `../rule.js`; `WorkflowIssue` from `../../../issue-types.js`.
- Produces: `danglingLinkRule`, `slotOobRule`, `selfLoopRule`, `bidirectionalLinkRule` (all `ValidationRule`).

**Note on behavioral parity:** Approach A's `illegal-link-validator.ts` checks rules in order (dangling → self-loop → slot_oob → bidirectional) with `continue` after each. To produce the exact same issue SET (not just id format), each rule in Approach C includes guards that skip links already caught by earlier rules.

- [ ] **Step 2.1: Write failing test for danglingLinkRule** — Create `sga_template/src/comfyui/validators/graph-walker/rules/dangling-link.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { danglingLinkRule } from './dangling-link.js'

describe('danglingLinkRule', () => {
  it('returns no issues for clean graph', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    expect(danglingLinkRule.run(graph)).toEqual([])
  })

  it('detects dangling link when toNodeId missing', () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] }],
      links: [[1, 1, 0, 99, 0, 'MODEL']],
    })
    const issues = danglingLinkRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('illegal_link:1:dangling')
    expect(issues[0].severity).toBe('error')
    expect(issues[0].category).toBe('illegal_link')
    expect(issues[0].source).toBe('native')
  })

  it('detects dangling link when fromNodeId missing', () => {
    const graph = compileGraph({
      nodes: [{ id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] }],
      links: [[1, 99, 0, 2, 0, 'MODEL']],
    })
    const issues = danglingLinkRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('illegal_link:1:dangling')
  })
})
```

- [ ] **Step 2.2: Implement dangling-link.ts** — Create `sga_template/src/comfyui/validators/graph-walker/rules/dangling-link.ts`:

```ts
import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'

export const danglingLinkRule: ValidationRule = {
  id: 'danglingLink',
  run(graph: CompiledGraph): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []
    for (const link of graph.links) {
      const fromCtx = graph.nodes.get(link.fromNodeId)
      const toCtx = graph.nodes.get(link.toNodeId)
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
      }
    }
    return issues
  },
}
```

- [ ] **Step 2.3: Run test to verify it passes** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/rules/dangling-link.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 2.4: Write failing test for slotOobRule** — Create `sga_template/src/comfyui/validators/graph-walker/rules/slot-oob.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { slotOobRule } from './slot-oob.js'

describe('slotOobRule', () => {
  it('returns no issues for clean graph', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    expect(slotOobRule.run(graph)).toEqual([])
  })

  it('detects slot out of bounds (fromSlot >= outputs.length)', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 5, 2, 0, 'MODEL']],
    })
    const issues = slotOobRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('illegal_link:1:slot_oob')
    expect(issues[0].severity).toBe('error')
    expect(issues[0].source).toBe('native')
  })

  it('detects slot out of bounds (toSlot >= inputs.length)', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 5, 'MODEL']],
    })
    const issues = slotOobRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('illegal_link:1:slot_oob')
  })

  it('skips dangling links (parity with Approach A continue pattern)', () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] }],
      links: [[1, 1, 5, 99, 5, 'MODEL']],
    })
    // Dangling + slot oob — slotOobRule must skip because fromCtx/toCtx missing
    expect(slotOobRule.run(graph)).toEqual([])
  })
})
```

- [ ] **Step 2.5: Implement slot-oob.ts** — Create `sga_template/src/comfyui/validators/graph-walker/rules/slot-oob.ts`:

```ts
import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
}

export const slotOobRule: ValidationRule = {
  id: 'slotOob',
  run(graph: CompiledGraph): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []
    for (const link of graph.links) {
      const fromCtx = graph.nodes.get(link.fromNodeId)
      const toCtx = graph.nodes.get(link.toNodeId)
      // Guard: skip dangling (parity with Approach A continue)
      if (!fromCtx || !toCtx) continue
      // Guard: skip self-loop (parity with Approach A continue)
      if (link.fromNodeId === link.toNodeId) continue

      const fromNode = fromCtx.node as GraphNode
      const toNode = toCtx.node as GraphNode
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
      }
    }
    return issues
  },
}
```

- [ ] **Step 2.6: Run test to verify it passes** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/rules/slot-oob.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 2.7: Write failing test for selfLoopRule** — Create `sga_template/src/comfyui/validators/graph-walker/rules/self-loop.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { selfLoopRule } from './self-loop.js'

describe('selfLoopRule', () => {
  it('returns no issues for clean graph', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    expect(selfLoopRule.run(graph)).toEqual([])
  })

  it('detects self-loop', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', inputs: [{ name: 'in', type: 'MODEL', link: 1 }], outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
      ],
      links: [[1, 1, 0, 1, 0, 'MODEL']],
    })
    const issues = selfLoopRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('illegal_link:1:self_loop')
    expect(issues[0].severity).toBe('error')
    expect(issues[0].source).toBe('native')
  })

  it('skips dangling links (parity with Approach A continue pattern)', () => {
    const graph = compileGraph({
      nodes: [],
      links: [[1, 1, 0, 1, 0, 'MODEL']],
    })
    expect(selfLoopRule.run(graph)).toEqual([])
  })
})
```

- [ ] **Step 2.8: Implement self-loop.ts** — Create `sga_template/src/comfyui/validators/graph-walker/rules/self-loop.ts`:

```ts
import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'

export const selfLoopRule: ValidationRule = {
  id: 'selfLoop',
  run(graph: CompiledGraph): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []
    for (const link of graph.links) {
      const fromCtx = graph.nodes.get(link.fromNodeId)
      const toCtx = graph.nodes.get(link.toNodeId)
      // Guard: skip dangling (parity with Approach A continue)
      if (!fromCtx || !toCtx) continue
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
      }
    }
    return issues
  },
}
```

- [ ] **Step 2.9: Run test to verify it passes** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/rules/self-loop.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 2.10: Write failing test for bidirectionalLinkRule** — Create `sga_template/src/comfyui/validators/graph-walker/rules/bidirectional-link.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { bidirectionalLinkRule } from './bidirectional-link.js'

describe('bidirectionalLinkRule', () => {
  it('returns no issues for clean graph', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    expect(bidirectionalLinkRule.run(graph)).toEqual([])
  })

  it('detects bidirectional inconsistency', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [null] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: null }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    const issues = bidirectionalLinkRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('illegal_link:1:bidirectional')
    expect(issues[0].severity).toBe('error')
    expect(issues[0].source).toBe('native')
  })

  it('skips dangling and self-loop and slot_oob links (parity guards)', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: null }] },
      ],
      links: [
        [1, 1, 0, 99, 0, 'MODEL'],   // dangling — skip
        [2, 1, 0, 1, 0, 'MODEL'],    // self-loop — skip
        [3, 1, 5, 2, 0, 'MODEL'],    // slot_oob — skip
      ],
    })
    expect(bidirectionalLinkRule.run(graph)).toEqual([])
  })
})
```

- [ ] **Step 2.11: Implement bidirectional-link.ts** — Create `sga_template/src/comfyui/validators/graph-walker/rules/bidirectional-link.ts`:

```ts
import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
}

export const bidirectionalLinkRule: ValidationRule = {
  id: 'bidirectionalLink',
  run(graph: CompiledGraph): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []
    for (const link of graph.links) {
      const fromCtx = graph.nodes.get(link.fromNodeId)
      const toCtx = graph.nodes.get(link.toNodeId)
      // Guard: skip dangling (parity with Approach A continue)
      if (!fromCtx || !toCtx) continue
      // Guard: skip self-loop (parity with Approach A continue)
      if (link.fromNodeId === link.toNodeId) continue

      const fromNode = fromCtx.node as GraphNode
      const toNode = toCtx.node as GraphNode
      const fromOutputs = Array.isArray(fromNode.outputs) ? fromNode.outputs : []
      const toInputs = Array.isArray(toNode.inputs) ? toNode.inputs : []
      // Guard: skip slot_oob (parity with Approach A continue)
      if (link.fromSlot >= fromOutputs.length || link.toSlot >= toInputs.length) continue

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
  },
}
```

- [ ] **Step 2.12: Run test to verify it passes** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/rules/bidirectional-link.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 2.13: Register 4 rules in validator-registry.ts** — Replace `sga_template/src/comfyui/validators/graph-walker/validator-registry.ts` with:

```ts
/**
 * Rule registry — all validation rules registered here run on each validateWorkflow call.
 */
import type { ValidationRule } from './rule.js'
import { danglingLinkRule } from './rules/dangling-link.js'
import { slotOobRule } from './rules/slot-oob.js'
import { selfLoopRule } from './rules/self-loop.js'
import { bidirectionalLinkRule } from './rules/bidirectional-link.js'

export const RULES: ValidationRule[] = [
  danglingLinkRule,
  slotOobRule,
  selfLoopRule,
  bidirectionalLinkRule,
]
```

- [ ] **Step 2.14: Run typecheck and full test suite** — Run: `cd sga_template; npm run typecheck; npm test`
Expected: 0 type errors; all tests pass.

- [ ] **Step 2.15: Commit** — Run:
```powershell
git add sga_template/src/comfyui/validators/graph-walker/; git commit -m "feat(comfyui-graph-walker): add 4 illegal-link rules with parity guards"
```

---

## Task 3: 3 sync unsupported-structure rules

**Files:**
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/reroute-unconnected.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/reroute-unconnected.test.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/orphaned-aux.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/orphaned-aux.test.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/deep-reroute-chain.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/deep-reroute-chain.test.ts`
- Modify: `sga_template/src/comfyui/validators/graph-walker/validator-registry.ts`

**Interfaces:**
- Consumes: `CompiledGraph` from `../graph-walker.js`; `ValidationRule` from `../rule.js`; `WorkflowIssue` from `../../../issue-types.js`; `isReroute`, `isPrimitive`, `isNote` from `../../../graph-utils.js`.
- Produces: `rerouteUnconnectedRule`, `orphanedAuxRule`, `deepRerouteChainRule` (all `ValidationRule`).

- [ ] **Step 3.1: Write failing test for rerouteUnconnectedRule** — Create `sga_template/src/comfyui/validators/graph-walker/rules/reroute-unconnected.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { rerouteUnconnectedRule } from './reroute-unconnected.js'

describe('rerouteUnconnectedRule', () => {
  it('returns no issues for connected reroute', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'Reroute', inputs: [{ name: '*', type: '*', link: 1 }], outputs: [{ name: '*', type: '*', links: [2] }] },
        { id: 2, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
        { id: 3, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 2 }] },
      ],
      links: [
        [1, 2, 0, 1, 0, 'MODEL'],
        [2, 1, 0, 3, 0, 'MODEL'],
      ],
    })
    expect(rerouteUnconnectedRule.run(graph)).toEqual([])
  })

  it('detects reroute with no input', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'Reroute', inputs: [{ name: '*', type: '*', link: null }], outputs: [{ name: '*', type: '*', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    const issues = rerouteUnconnectedRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('unsupported_structure:1:reroute_unconnected')
    expect(issues[0].severity).toBe('info')
    expect(issues[0].source).toBe('native')
  })

  it('detects reroute with no output', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'Reroute', inputs: [{ name: '*', type: '*', link: 1 }], outputs: [{ name: '*', type: '*', links: [] }] },
        { id: 2, type: 'A', outputs: [{ name: 'X', type: 'MODEL', links: [1] }] },
      ],
      links: [[1, 2, 0, 1, 0, 'MODEL']],
    })
    const issues = rerouteUnconnectedRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('unsupported_structure:1:reroute_unconnected')
  })

  it('skips non-reroute nodes', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'KSampler', inputs: [{ name: 'in', type: 'MODEL', link: null }] },
      ],
      links: [],
    })
    expect(rerouteUnconnectedRule.run(graph)).toEqual([])
  })
})
```

- [ ] **Step 3.2: Implement reroute-unconnected.ts** — Create `sga_template/src/comfyui/validators/graph-walker/rules/reroute-unconnected.ts`:

```ts
import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'
import { isReroute } from '../../../graph-utils.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
}

export const rerouteUnconnectedRule: ValidationRule = {
  id: 'rerouteUnconnected',
  run(graph: CompiledGraph): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []
    for (const ctx of graph.nodes.values()) {
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
    return issues
  },
}
```

- [ ] **Step 3.3: Run test to verify it passes** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/rules/reroute-unconnected.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3.4: Write failing test for orphanedAuxRule** — Create `sga_template/src/comfyui/validators/graph-walker/rules/orphaned-aux.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { orphanedAuxRule } from './orphaned-aux.js'

describe('orphanedAuxRule', () => {
  it('returns no issues for connected Note', () => {
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'Note', widgets_values: ['a note'], outputs: [{ name: '*', type: '*', links: [1] }] },
        { id: 2, type: 'B', inputs: [{ name: 'in', type: 'MODEL', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    expect(orphanedAuxRule.run(graph)).toEqual([])
  })

  it('detects orphaned Note', () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'Note', widgets_values: ['a note'] }],
      links: [],
    })
    const issues = orphanedAuxRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('unsupported_structure:1:orphaned_aux')
    expect(issues[0].severity).toBe('info')
    expect(issues[0].source).toBe('native')
  })

  it('detects orphaned PrimitiveNode', () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'PrimitiveNode', widgets_values: ['hello'], outputs: [{ name: '*', type: '*', links: [] }] }],
      links: [],
    })
    const issues = orphanedAuxRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('unsupported_structure:1:orphaned_aux')
  })

  it('skips non-aux nodes with no links', () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'KSampler' }],
      links: [],
    })
    expect(orphanedAuxRule.run(graph)).toEqual([])
  })
})
```

- [ ] **Step 3.5: Implement orphaned-aux.ts** — Create `sga_template/src/comfyui/validators/graph-walker/rules/orphaned-aux.ts`:

```ts
import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'
import { isNote, isPrimitive } from '../../../graph-utils.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
}

export const orphanedAuxRule: ValidationRule = {
  id: 'orphanedAux',
  run(graph: CompiledGraph): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []
    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      if (!isNote(node) && !isPrimitive(node)) continue
      const links = graph.linksByNode.get(ctx.id)
      const hasLinks = !!links && (links.incoming.length > 0 || links.outgoing.length > 0)
      if (!hasLinks) {
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
    return issues
  },
}
```

- [ ] **Step 3.6: Run test to verify it passes** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/rules/orphaned-aux.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3.7: Write failing test for deepRerouteChainRule** — Create `sga_template/src/comfyui/validators/graph-walker/rules/deep-reroute-chain.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { compileGraph } from '../graph-walker.js'
import { deepRerouteChainRule } from './deep-reroute-chain.js'

function makeChain(depth: number) {
  const nodes: any[] = []
  const links: any[] = []
  for (let i = 1; i <= depth; i++) {
    nodes.push({
      id: i, type: 'Reroute',
      inputs: [{ name: '*', type: '*', link: i > 1 ? i - 1 : null }],
      outputs: [{ name: '*', type: '*', links: i < depth ? [i] : [] }],
    })
    if (i < depth) links.push([i, i, 0, i + 1, 0, '*'])
  }
  return { nodes, links }
}

describe('deepRerouteChainRule', () => {
  it('returns no issues for chain at depth 8 (default threshold)', () => {
    const wf = makeChain(8)
    const graph = compileGraph(wf)
    expect(deepRerouteChainRule.run(graph)).toEqual([])
  })

  it('detects chain deeper than 8', () => {
    const wf = makeChain(10)
    const graph = compileGraph(wf)
    const issues = deepRerouteChainRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('unsupported_structure:1:deep_reroute_chain')
    expect(issues[0].severity).toBe('info')
    expect(issues[0].source).toBe('native')
  })

  it('terminates on cycle (visited set prevents infinite loop)', () => {
    // Two reroutes pointing at each other — cycle
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'Reroute', inputs: [{ name: '*', type: '*', link: 2 }], outputs: [{ name: '*', type: '*', links: [1] }] },
        { id: 2, type: 'Reroute', inputs: [{ name: '*', type: '*', link: 1 }], outputs: [{ name: '*', type: '*', links: [2] }] },
      ],
      links: [
        [1, 1, 0, 2, 0, '*'],
        [2, 2, 0, 1, 0, '*'],
      ],
    })
    // Must not hang — visited set breaks the cycle
    const issues = deepRerouteChainRule.run(graph)
    // Depth 2, below threshold of 8 — no issue
    expect(issues).toEqual([])
  })

  it('returns no issues when no reroutes exist', () => {
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'KSampler' }],
      links: [],
    })
    expect(deepRerouteChainRule.run(graph)).toEqual([])
  })
})
```

- [ ] **Step 3.8: Implement deep-reroute-chain.ts** — Create `sga_template/src/comfyui/validators/graph-walker/rules/deep-reroute-chain.ts`:

```ts
import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'
import { isReroute } from '../../../graph-utils.js'

function getMaxRerouteDepth(): number {
  return Number(process.env.SGA_MAX_REROUTE_DEPTH) || 8
}

export const deepRerouteChainRule: ValidationRule = {
  id: 'deepRerouteChain',
  run(graph: CompiledGraph): WorkflowIssue[] {
    const issues: WorkflowIssue[] = []
    const rerouteNodes = Array.from(graph.nodes.values()).filter(ctx => isReroute(ctx.node))
    if (rerouteNodes.length === 0) return issues

    const maxDepth = getMaxRerouteDepth()
    const rerouteLinks = graph.links.filter(l => {
      const fromCtx = graph.nodes.get(l.fromNodeId)
      const toCtx = graph.nodes.get(l.toNodeId)
      return fromCtx && toCtx && isReroute(fromCtx.node) && isReroute(toCtx.node)
    })

    // Build adjacency: fromNodeId → [toNodeId]
    const adjacency = new Map<number, number[]>()
    for (const link of rerouteLinks) {
      if (!adjacency.has(link.fromNodeId)) adjacency.set(link.fromNodeId, [])
      adjacency.get(link.fromNodeId)!.push(link.toNodeId)
    }

    // Walk from each reroute with no incoming reroute link.
    // Cycle detection: visited set + break on revisit (parity with Approach A commit e56209b).
    const visited = new Set<number>()
    for (const start of rerouteNodes) {
      if (visited.has(start.id)) continue
      const hasIncoming = rerouteLinks.some(l => l.toNodeId === start.id)
      if (hasIncoming) continue

      let depth = 1
      let current = start.id
      visited.add(start.id)
      while (true) {
        const neighbors = adjacency.get(current)
        if (!neighbors || neighbors.length === 0) break
        const next = neighbors[0]
        if (visited.has(next)) break  // cycle detected — stop walking
        current = next
        depth++
        visited.add(current)
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
    return issues
  },
}
```

- [ ] **Step 3.9: Run test to verify it passes** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/rules/deep-reroute-chain.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3.10: Register 3 rules in validator-registry.ts** — Replace `sga_template/src/comfyui/validators/graph-walker/validator-registry.ts` with:

```ts
/**
 * Rule registry — all validation rules registered here run on each validateWorkflow call.
 */
import type { ValidationRule } from './rule.js'
import { danglingLinkRule } from './rules/dangling-link.js'
import { slotOobRule } from './rules/slot-oob.js'
import { selfLoopRule } from './rules/self-loop.js'
import { bidirectionalLinkRule } from './rules/bidirectional-link.js'
import { rerouteUnconnectedRule } from './rules/reroute-unconnected.js'
import { orphanedAuxRule } from './rules/orphaned-aux.js'
import { deepRerouteChainRule } from './rules/deep-reroute-chain.js'

export const RULES: ValidationRule[] = [
  danglingLinkRule,
  slotOobRule,
  selfLoopRule,
  bidirectionalLinkRule,
  rerouteUnconnectedRule,
  orphanedAuxRule,
  deepRerouteChainRule,
]
```

- [ ] **Step 3.11: Run typecheck and full test suite** — Run: `cd sga_template; npm run typecheck; npm test`
Expected: 0 type errors; all tests pass.

- [ ] **Step 3.12: Commit** — Run:
```powershell
git add sga_template/src/comfyui/validators/graph-walker/; git commit -m "feat(comfyui-graph-walker): add reroute-unconnected, orphaned-aux, and deep-reroute-chain rules"
```

---

## Task 4: 2 async missing-* rules

**Files:**
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/missing-model.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/missing-model.test.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/missing-media.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/missing-media.test.ts`
- Modify: `sga_template/src/comfyui/validators/graph-walker/validator-registry.ts`

**Interfaces:**
- Consumes: `CompiledGraph` from `../graph-walker.js`; `ValidationRule` from `../rule.js`; `WorkflowIssue` from `../../../issue-types.js`; `MODEL_LOADER_MAPPING`, `MEDIA_LOADER_TYPES` from `../../../model-categories.js`; `getModelFile`, `getMediaFile` from `../../../model-index.js`.
- Produces: `missingModelRule`, `missingMediaRule` (both `ValidationRule`, async).

- [ ] **Step 4.1: Write failing test for missingModelRule** — Create `sga_template/src/comfyui/validators/graph-walker/rules/missing-model.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { compileGraph } from '../graph-walker.js'

const sampleObjectInfo = {
  CheckpointLoaderSimple: {
    name: 'CheckpointLoaderSimple', category: 'loaders',
    input: { required: { ckpt_name: [['model1.safetensors']] } },
    output: ['MODEL', 'CLIP', 'VAE'], output_name: ['MODEL', 'CLIP', 'VAE'],
  },
}

describe('missingModelRule', () => {
  let tmpHome: string
  let tmpBaseDir: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-mm-'))
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

  it('returns no issues when model exists on disk', async () => {
    const dir = join(tmpBaseDir, 'models', 'checkpoints')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'model1.safetensors'), 'fake')
    const { missingModelRule } = await import('./missing-model.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['model1.safetensors'] }],
      links: [],
    })
    expect(await missingModelRule.run(graph)).toEqual([])
  })

  it('detects missing model file', async () => {
    const { missingModelRule } = await import('./missing-model.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['nonexistent.safetensors'] }],
      links: [],
    })
    const issues = await missingModelRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('missing_model:1')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].category).toBe('missing_model')
    expect(issues[0].source).toBe('native')
  })

  it('skips nodes with no widgets_values', async () => {
    const { missingModelRule } = await import('./missing-model.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'CheckpointLoaderSimple' }],
      links: [],
    })
    expect(await missingModelRule.run(graph)).toEqual([])
  })

  it('skips unknown loader types', async () => {
    const { missingModelRule } = await import('./missing-model.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'SomeUnknownLoader', widgets_values: ['something'] }],
      links: [],
    })
    expect(await missingModelRule.run(graph)).toEqual([])
  })
})
```

- [ ] **Step 4.2: Implement missing-model.ts** — Create `sga_template/src/comfyui/validators/graph-walker/rules/missing-model.ts`:

```ts
import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'
import { MODEL_LOADER_MAPPING } from '../../../model-categories.js'
import { getModelFile } from '../../../model-index.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  widgets_values?: unknown[]
}

export const missingModelRule: ValidationRule = {
  id: 'missingModel',
  async run(graph: CompiledGraph): Promise<WorkflowIssue[]> {
    const issues: WorkflowIssue[] = []
    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : []
      if (widgets.length === 0) continue

      const loaderMapping = MODEL_LOADER_MAPPING[node.type]
      if (!loaderMapping) continue

      // v1 heuristic: model name is always at widget index 0 (parity with Approach A)
      const modelName = widgets[0]
      if (typeof modelName !== 'string' || modelName.length === 0) continue

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
    return issues
  },
}
```

- [ ] **Step 4.3: Run test to verify it passes** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/rules/missing-model.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4.4: Write failing test for missingMediaRule** — Create `sga_template/src/comfyui/validators/graph-walker/rules/missing-media.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { compileGraph } from '../graph-walker.js'

const sampleObjectInfo = {
  LoadImage: {
    name: 'LoadImage', category: 'image',
    input: { required: { image: ['STRING'] } },
    output: ['IMAGE', 'MASK'], output_name: ['IMAGE', 'MASK'],
  },
}

describe('missingMediaRule', () => {
  let tmpHome: string
  let tmpBaseDir: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-mdm-'))
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

  it('returns no issues when media exists on disk', async () => {
    const inputDir = join(tmpBaseDir, 'input')
    await fs.mkdir(inputDir, { recursive: true })
    await fs.writeFile(join(inputDir, 'photo.png'), 'fake')
    const { missingMediaRule } = await import('./missing-media.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'LoadImage', widgets_values: ['photo.png'] }],
      links: [],
    })
    expect(await missingMediaRule.run(graph)).toEqual([])
  })

  it('detects missing media file', async () => {
    const { missingMediaRule } = await import('./missing-media.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'LoadImage', widgets_values: ['nonexistent.png'] }],
      links: [],
    })
    const issues = await missingMediaRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('missing_media:1')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].category).toBe('missing_media')
    expect(issues[0].source).toBe('native')
  })

  it('skips non-media-loader nodes', async () => {
    const { missingMediaRule } = await import('./missing-media.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'KSampler', widgets_values: ['something'] }],
      links: [],
    })
    expect(await missingMediaRule.run(graph)).toEqual([])
  })
})
```

- [ ] **Step 4.5: Implement missing-media.ts** — Create `sga_template/src/comfyui/validators/graph-walker/rules/missing-media.ts`:

```ts
import type { WorkflowIssue } from '../../../issue-types.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'
import { MEDIA_LOADER_TYPES } from '../../../model-categories.js'
import { getMediaFile } from '../../../model-index.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  widgets_values?: unknown[]
}

export const missingMediaRule: ValidationRule = {
  id: 'missingMedia',
  async run(graph: CompiledGraph): Promise<WorkflowIssue[]> {
    const issues: WorkflowIssue[] = []
    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : []
      if (widgets.length === 0) continue

      if (!MEDIA_LOADER_TYPES.has(node.type)) continue

      const mediaName = widgets[0]
      if (typeof mediaName !== 'string' || mediaName.length === 0) continue

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
    return issues
  },
}
```

- [ ] **Step 4.6: Run test to verify it passes** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/rules/missing-media.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4.7: Register 2 rules in validator-registry.ts** — Replace `sga_template/src/comfyui/validators/graph-walker/validator-registry.ts` with:

```ts
/**
 * Rule registry — all validation rules registered here run on each validateWorkflow call.
 */
import type { ValidationRule } from './rule.js'
import { danglingLinkRule } from './rules/dangling-link.js'
import { slotOobRule } from './rules/slot-oob.js'
import { selfLoopRule } from './rules/self-loop.js'
import { bidirectionalLinkRule } from './rules/bidirectional-link.js'
import { rerouteUnconnectedRule } from './rules/reroute-unconnected.js'
import { orphanedAuxRule } from './rules/orphaned-aux.js'
import { deepRerouteChainRule } from './rules/deep-reroute-chain.js'
import { missingModelRule } from './rules/missing-model.js'
import { missingMediaRule } from './rules/missing-media.js'

export const RULES: ValidationRule[] = [
  danglingLinkRule,
  slotOobRule,
  selfLoopRule,
  bidirectionalLinkRule,
  rerouteUnconnectedRule,
  orphanedAuxRule,
  deepRerouteChainRule,
  missingModelRule,
  missingMediaRule,
]
```

- [ ] **Step 4.8: Run typecheck and full test suite** — Run: `cd sga_template; npm run typecheck; npm test`
Expected: 0 type errors; all tests pass.

- [ ] **Step 4.9: Commit** — Run:
```powershell
git add sga_template/src/comfyui/validators/graph-walker/; git commit -m "feat(comfyui-graph-walker): add missing-model and missing-media async rules"
```

---

## Task 5: portTypeRule (4 sub-concerns)

**Files:**
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/port-type.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/port-type.test.ts`
- Modify: `sga_template/src/comfyui/validators/graph-walker/validator-registry.ts`

**Interfaces:**
- Consumes: `CompiledGraph` from `../graph-walker.js`; `ValidationRule` from `../rule.js`; `WorkflowIssue` from `../../../issue-types.js`; `NodeDef`, `getNodeDef` from `../../../node-def-index.js`.
- Produces: `portTypeRule` (`ValidationRule`, async). Emits 4 distinct issue ids: `unknown_node_type`, `port_type_mismatch`, `orphaned_output`, `missing_required_widget`.

**Spec correction:** The spec §5 table lists only `port_type_mismatch` for `portTypeRule`, but Approach A's `port-type-validator.ts` emits 4 distinct issue ids. This rule ports all 4 sub-rules. The `port_type_mismatch` id uses link id only (NOT nodeId:slot), matching Approach A's `port_type_mismatch:${link[0]}`.

- [ ] **Step 5.1: Write failing test for portTypeRule** — Create `sga_template/src/comfyui/validators/graph-walker/rules/port-type.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { compileGraph } from '../graph-walker.js'

const sampleObjectInfo = {
  CheckpointLoaderSimple: {
    name: 'CheckpointLoaderSimple', category: 'loaders',
    input: { required: { ckpt_name: [['model1.safetensors']] } },
    output: ['MODEL', 'CLIP', 'VAE'], output_name: ['MODEL', 'CLIP', 'VAE'],
  },
  CLIPTextEncode: {
    name: 'CLIPTextEncode', category: 'conditioning',
    input: { required: { text: ['STRING'], clip: ['CLIP'] } },
    output: ['CONDITIONING'], output_name: ['CONDITIONING'],
  },
  KSampler: {
    name: 'KSampler', category: 'sampling',
    input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT'] } },
    output: ['LATENT'], output_name: ['LATENT'],
  },
}

describe('portTypeRule', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-pt-'))
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

  it('emits unknown_node_type when getNodeDef returns null', async () => {
    const { portTypeRule } = await import('./port-type.js')
    const graph = compileGraph({
      nodes: [{ id: 2, type: 'CustomNode_X', inputs: [{ name: 'model', type: 'MODEL', link: null }] }],
      links: [],
    })
    const issues = await portTypeRule.run(graph)
    const unknown = issues.find(i => i.id === 'unknown_node_type:2:CustomNode_X')
    expect(unknown).toBeDefined()
    expect(unknown?.severity).toBe('warning')
    expect(unknown?.source).toBe('native')
  })

  it('emits port_type_mismatch with link id only (not nodeId:slot)', async () => {
    const { portTypeRule } = await import('./port-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['model1.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: null }, { name: 'VAE', type: 'VAE', links: null }] },
        { id: 2, type: 'CLIPTextEncode', widgets_values: ['prompt'],
          inputs: [{ name: 'text', type: 'STRING', link: 1 }, { name: 'clip', type: 'CLIP', link: null }],
          outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: null }] },
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
    })
    const issues = await portTypeRule.run(graph)
    const mismatch = issues.find(i => i.id === 'port_type_mismatch:1')
    expect(mismatch).toBeDefined()
    expect(mismatch?.severity).toBe('error')
    expect(mismatch?.source).toBe('native')
  })

  it('emits orphaned_output for unconnected output slot', async () => {
    const { portTypeRule } = await import('./port-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['model1.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: null }, { name: 'CLIP', type: 'CLIP', links: null }, { name: 'VAE', type: 'VAE', links: null }] },
      ],
      links: [],
    })
    const issues = await portTypeRule.run(graph)
    const orphaned = issues.find(i => i.id === 'orphaned_output:1:0')
    expect(orphaned).toBeDefined()
    expect(orphaned?.severity).toBe('info')
    expect(orphaned?.source).toBe('native')
  })

  it('skips orphaned_output for muted nodes (mode === 4)', async () => {
    const { portTypeRule } = await import('./port-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', mode: 4, widgets_values: ['model1.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: null }, { name: 'CLIP', type: 'CLIP', links: null }, { name: 'VAE', type: 'VAE', links: null }] },
      ],
      links: [],
    })
    const issues = await portTypeRule.run(graph)
    expect(issues.find(i => i.id.startsWith('orphaned_output:1'))).toBeUndefined()
  })

  it('emits missing_required_widget when widgets_values too short', async () => {
    const { portTypeRule } = await import('./port-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'KSampler', widgets_values: [],
          inputs: [{ name: 'model', type: 'MODEL', link: null }, { name: 'positive', type: 'CONDITIONING', link: null }, { name: 'negative', type: 'CONDITIONING', link: null }, { name: 'latent_image', type: 'LATENT', link: null }, { name: 'seed', type: 'INT', link: null }],
          outputs: [{ name: 'LATENT', type: 'LATENT', links: null }] },
      ],
      links: [],
    })
    const issues = await portTypeRule.run(graph)
    const missing = issues.find(i => i.id === 'missing_required_widget:1')
    expect(missing).toBeDefined()
    expect(missing?.severity).toBe('warning')
    expect(missing?.source).toBe('native')
  })

  it('returns no issues for clean compatible workflow', async () => {
    const { portTypeRule } = await import('./port-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['model1.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: null }, { name: 'VAE', type: 'VAE', links: null }] },
        { id: 2, type: 'CLIPTextEncode', widgets_values: ['prompt'],
          inputs: [{ name: 'text', type: 'STRING', link: null }, { name: 'clip', type: 'CLIP', link: 1 }],
          outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: null }] },
      ],
      links: [[1, 1, 0, 2, 1, 'CLIP']],
    })
    const issues = await portTypeRule.run(graph)
    // CLIP -> CLIP is compatible; no mismatch
    expect(issues.find(i => i.id.startsWith('port_type_mismatch'))).toBeUndefined()
    expect(issues.find(i => i.id.startsWith('unknown_node_type'))).toBeUndefined()
  })
})
```

- [ ] **Step 5.2: Run test to verify it fails** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/rules/port-type.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 5.3: Implement port-type.ts** — Create `sga_template/src/comfyui/validators/graph-walker/rules/port-type.ts`:

```ts
import type { WorkflowIssue } from '../../../issue-types.js'
import type { NodeDef } from '../../../node-def-index.js'
import { getNodeDef } from '../../../node-def-index.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'

const PRIMITIVE_WIDGET_TYPES = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN'])

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  mode?: number
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
  widgets_values?: unknown[]
}

function typesCompatible(a: string, b: string): boolean {
  // ComfyUI has subtyping (MODEL -> MODEL*) but reproducing it is out of scope.
  // For v1, only exact match counts as compatible (parity with Approach A).
  return a === b
}

export const portTypeRule: ValidationRule = {
  id: 'portType',
  async run(graph: CompiledGraph): Promise<WorkflowIssue[]> {
    const issues: WorkflowIssue[] = []
    const defCache = new Map<string, NodeDef | null>()
    async function getDef(type: string): Promise<NodeDef | null> {
      if (!defCache.has(type)) defCache.set(type, await getNodeDef(type))
      return defCache.get(type) ?? null
    }

    // Rule 1: unknown node type — iterate graph.nodes
    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      const def = await getDef(node.type)
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

    // Rule 2: port type mismatch — iterate graph.links
    for (const link of graph.links) {
      const fromCtx = graph.nodes.get(link.fromNodeId)
      const toCtx = graph.nodes.get(link.toNodeId)
      if (!fromCtx || !toCtx) continue

      const fromDef = await getDef(fromCtx.node.type as string)
      const toDef = await getDef(toCtx.node.type as string)
      if (!fromDef || !toDef) continue

      const fromNode = fromCtx.node as GraphNode
      const toNode = toCtx.node as GraphNode
      // Graph node's slot is source of truth; fall back to def for real graphs
      const fromOutput = fromNode.outputs?.[link.fromSlot] ?? fromDef.outputs[link.fromSlot]
      const toInput = toNode.inputs?.[link.toSlot] ?? toDef.inputs[link.toSlot]
      if (!fromOutput || !toInput) continue

      const sourceType = (fromOutput as { type: string }).type
      const targetType = (toInput as { type: string }).type
      if (sourceType === '*' || targetType === '*') continue
      if (!typesCompatible(sourceType, targetType)) {
        issues.push({
          id: `port_type_mismatch:${link.id}`,
          nodeId: link.fromNodeId,
          nodeIds: [link.fromNodeId, link.toNodeId],
          severity: 'error',
          category: 'port_type_mismatch',
          message: `Link ${link.id}: output type "${sourceType}" of node ${link.fromNodeId} slot ${link.fromSlot} is not compatible with input type "${targetType}" of node ${link.toNodeId} slot ${link.toSlot}.`,
          impact: 'ComfyUI will reject this workflow at queue time, or silently coerce the value (uncommon).',
          fixSuggestion: `Reconnect node ${link.fromNodeId} output ${link.fromSlot} (${sourceType}) to a ${targetType} input, or replace node ${link.fromNodeId} with one that outputs ${targetType}.`,
          nodeType: fromNode.type,
          source: 'native',
        })
      }
    }

    // Rule 3: orphaned outputs (skip muted nodes) — iterate graph.nodes
    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      if (node.mode === 4) continue
      const def = await getDef(node.type)
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

    // Rule 4: missing required widgets (count-based heuristic) — iterate graph.nodes
    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      const def = await getDef(node.type)
      if (!def) continue
      const requiredWidgets = def.inputs.filter(i => i.required && PRIMITIVE_WIDGET_TYPES.has(i.type.split(' | ')[0]))
      if (requiredWidgets.length === 0) continue
      if (!Array.isArray(node.widgets_values)) continue
      const widgetCount = node.widgets_values.length
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
  },
}
```

- [ ] **Step 5.4: Run test to verify it passes** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/rules/port-type.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5.5: Register portTypeRule in validator-registry.ts** — Replace `sga_template/src/comfyui/validators/graph-walker/validator-registry.ts` with:

```ts
/**
 * Rule registry — all validation rules registered here run on each validateWorkflow call.
 */
import type { ValidationRule } from './rule.js'
import { danglingLinkRule } from './rules/dangling-link.js'
import { slotOobRule } from './rules/slot-oob.js'
import { selfLoopRule } from './rules/self-loop.js'
import { bidirectionalLinkRule } from './rules/bidirectional-link.js'
import { rerouteUnconnectedRule } from './rules/reroute-unconnected.js'
import { orphanedAuxRule } from './rules/orphaned-aux.js'
import { deepRerouteChainRule } from './rules/deep-reroute-chain.js'
import { missingModelRule } from './rules/missing-model.js'
import { missingMediaRule } from './rules/missing-media.js'
import { portTypeRule } from './rules/port-type.js'

export const RULES: ValidationRule[] = [
  danglingLinkRule,
  slotOobRule,
  selfLoopRule,
  bidirectionalLinkRule,
  rerouteUnconnectedRule,
  orphanedAuxRule,
  deepRerouteChainRule,
  missingModelRule,
  missingMediaRule,
  portTypeRule,
]
```

- [ ] **Step 5.6: Run typecheck and full test suite** — Run: `cd sga_template; npm run typecheck; npm test`
Expected: 0 type errors; all tests pass.

- [ ] **Step 5.7: Commit** — Run:
```powershell
git add sga_template/src/comfyui/validators/graph-walker/; git commit -m "feat(comfyui-graph-walker): add portTypeRule with 4 sub-rules (unknown_node_type, port_type_mismatch, orphaned_output, missing_required_widget)"
```

---

## Task 6: primitiveMultiTypeRule

**Files:**
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/primitive-multi-type.ts`
- Create: `sga_template/src/comfyui/validators/graph-walker/rules/primitive-multi-type.test.ts`
- Modify: `sga_template/src/comfyui/validators/graph-walker/validator-registry.ts`

**Interfaces:**
- Consumes: `CompiledGraph` from `../graph-walker.js`; `ValidationRule` from `../rule.js`; `WorkflowIssue` from `../../../issue-types.js`; `NodeDef`, `getNodeDef` from `../../../node-def-index.js`; `isPrimitive` from `../../../graph-utils.js`.
- Produces: `primitiveMultiTypeRule` (`ValidationRule`, async).

**Note:** Approach A's `unsupported-structure-validator.ts` rule (d) has a double-check pattern: it first tries workflow-declared input types, and if that yields ≤1 types, it retries with NodeDef lookups. This plan replicates that exact pattern.

- [ ] **Step 6.1: Write failing test for primitiveMultiTypeRule** — Create `sga_template/src/comfyui/validators/graph-walker/rules/primitive-multi-type.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { compileGraph } from '../graph-walker.js'

const sampleObjectInfo = {
  PrimitiveNode: {
    name: 'PrimitiveNode', category: 'utils',
    input: { required: { value: ['STRING'] } },
    output: ['*'], output_name: ['*'],
  },
  KSampler: {
    name: 'KSampler', category: 'sampling',
    input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT'] } },
    output: ['LATENT'], output_name: ['LATENT'],
  },
  CLIPTextEncode: {
    name: 'CLIPTextEncode', category: 'conditioning',
    input: { required: { text: ['STRING'], clip: ['CLIP'] } },
    output: ['CONDITIONING'], output_name: ['CONDITIONING'],
  },
}

describe('primitiveMultiTypeRule', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-pmt-'))
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

  it('returns no issues for PrimitiveNode with single output type', async () => {
    const { primitiveMultiTypeRule } = await import('./primitive-multi-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'PrimitiveNode', widgets_values: ['hello'],
          outputs: [{ name: '*', type: '*', links: [1] }] },
        { id: 2, type: 'KSampler',
          inputs: [{ name: 'seed', type: 'INT', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 4, 'INT']],
    })
    expect(await primitiveMultiTypeRule.run(graph)).toEqual([])
  })

  it('detects PrimitiveNode multi-type via workflow-declared types', async () => {
    const { primitiveMultiTypeRule } = await import('./primitive-multi-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'PrimitiveNode', widgets_values: ['hello'],
          outputs: [{ name: '*', type: '*', links: [1, 2] }] },
        { id: 2, type: 'CLIPTextEncode',
          inputs: [{ name: 'text', type: 'STRING', link: 1 }, { name: 'clip', type: 'CLIP', link: null }] },
        { id: 3, type: 'KSampler',
          inputs: [{ name: 'seed', type: 'INT', link: 2 }] },
      ],
      links: [
        [1, 1, 0, 2, 0, 'STRING'],
        [2, 1, 0, 3, 4, 'INT'],
      ],
    })
    const issues = await primitiveMultiTypeRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('unsupported_structure:1:primitive_multi_type')
    expect(issues[0].severity).toBe('info')
    expect(issues[0].source).toBe('native')
  })

  it('skips PrimitiveNode with fewer than 2 output links', async () => {
    const { primitiveMultiTypeRule } = await import('./primitive-multi-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'PrimitiveNode', widgets_values: ['hello'],
          outputs: [{ name: '*', type: '*', links: [1] }] },
        { id: 2, type: 'KSampler',
          inputs: [{ name: 'seed', type: 'INT', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 4, 'INT']],
    })
    expect(await primitiveMultiTypeRule.run(graph)).toEqual([])
  })

  it('skips non-Primitive nodes', async () => {
    const { primitiveMultiTypeRule } = await import('./primitive-multi-type.js')
    const graph = compileGraph({
      nodes: [
        { id: 1, type: 'KSampler',
          outputs: [{ name: 'LATENT', type: 'LATENT', links: [1, 2] }] },
        { id: 2, type: 'KSampler', inputs: [{ name: 'seed', type: 'INT', link: 1 }] },
        { id: 3, type: 'KSampler', inputs: [{ name: 'seed', type: 'INT', link: 2 }] },
      ],
      links: [[1, 1, 0, 2, 4, 'INT'], [2, 1, 0, 3, 4, 'INT']],
    })
    expect(await primitiveMultiTypeRule.run(graph)).toEqual([])
  })
})
```

- [ ] **Step 6.2: Run test to verify it fails** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/rules/primitive-multi-type.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 6.3: Implement primitive-multi-type.ts** — Create `sga_template/src/comfyui/validators/graph-walker/rules/primitive-multi-type.ts`:

```ts
import type { WorkflowIssue } from '../../../issue-types.js'
import type { NodeDef } from '../../../node-def-index.js'
import { getNodeDef } from '../../../node-def-index.js'
import type { CompiledGraph } from '../graph-walker.js'
import type { ValidationRule } from '../rule.js'
import type { GraphLink } from '../../../graph-utils.js'
import { isPrimitive } from '../../../graph-utils.js'

interface GraphNode {
  [key: string]: unknown
  id: number | string
  type: string
  inputs?: Array<{ name: string; type: string; link?: number | null }>
  outputs?: Array<{ name: string; type: string; links?: Array<number | null> | null }>
  widgets_values?: unknown[]
}

export const primitiveMultiTypeRule: ValidationRule = {
  id: 'primitiveMultiType',
  async run(graph: CompiledGraph): Promise<WorkflowIssue[]> {
    const issues: WorkflowIssue[] = []

    // Build link lookup Map for O(1) access by link id
    const linkMap = new Map<number, GraphLink>()
    for (const link of graph.links) {
      linkMap.set(link.id, link)
    }

    for (const ctx of graph.nodes.values()) {
      const node = ctx.node as GraphNode
      if (!isPrimitive(node)) continue
      const outputLinks = node.outputs?.[0]?.links
      if (!Array.isArray(outputLinks)) continue

      const linkIds = outputLinks.filter((l): l is number => l !== null)
      if (linkIds.length < 2) continue  // need at least 2 connections to have multi-type

      // Look up the input type of each connected destination.
      // Double-check pattern (parity with Approach A):
      //   1. Try workflow-declared input types first.
      //   2. If ≤1 types found, retry with NodeDef lookups.
      const inputTypes = new Set<string>()
      for (const linkId of linkIds) {
        const link = linkMap.get(linkId)
        if (!link) continue
        const toCtx = graph.nodes.get(link.toNodeId)
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

      // Also check NodeDef for more accurate types (double-check pattern)
      if (inputTypes.size <= 1) {
        const defTypes = new Set<string>()
        for (const linkId of linkIds) {
          const link = linkMap.get(linkId)
          if (!link) continue
          const toCtx = graph.nodes.get(link.toNodeId)
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
          impact: 'PrimitiveNode outputs a single type; connecting to incompatible types may cause runtime errors.',
          fixSuggestion: `Ensure all connections from this PrimitiveNode go to the same input type.`,
          source: 'native',
        })
      }
    }

    return issues
  },
}
```

- [ ] **Step 6.4: Run test to verify it passes** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/rules/primitive-multi-type.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6.5: Register primitiveMultiTypeRule in validator-registry.ts** — Replace `sga_template/src/comfyui/validators/graph-walker/validator-registry.ts` with:

```ts
/**
 * Rule registry — all 11 validation rules registered here run on each validateWorkflow call.
 */
import type { ValidationRule } from './rule.js'
import { danglingLinkRule } from './rules/dangling-link.js'
import { slotOobRule } from './rules/slot-oob.js'
import { selfLoopRule } from './rules/self-loop.js'
import { bidirectionalLinkRule } from './rules/bidirectional-link.js'
import { rerouteUnconnectedRule } from './rules/reroute-unconnected.js'
import { orphanedAuxRule } from './rules/orphaned-aux.js'
import { deepRerouteChainRule } from './rules/deep-reroute-chain.js'
import { missingModelRule } from './rules/missing-model.js'
import { missingMediaRule } from './rules/missing-media.js'
import { portTypeRule } from './rules/port-type.js'
import { primitiveMultiTypeRule } from './rules/primitive-multi-type.js'

export const RULES: ValidationRule[] = [
  danglingLinkRule,
  slotOobRule,
  selfLoopRule,
  bidirectionalLinkRule,
  rerouteUnconnectedRule,
  orphanedAuxRule,
  deepRerouteChainRule,
  missingModelRule,
  missingMediaRule,
  portTypeRule,
  primitiveMultiTypeRule,
]
```

- [ ] **Step 6.6: Run typecheck and full test suite** — Run: `cd sga_template; npm run typecheck; npm test`
Expected: 0 type errors; all tests pass.

- [ ] **Step 6.7: Commit** — Run:
```powershell
git add sga_template/src/comfyui/validators/graph-walker/; git commit -m "feat(comfyui-graph-walker): add primitiveMultiTypeRule with double-check pattern"
```

---

## Task 7: Integration test (reuses 10 fixtures)

**Files:**
- Modify: `sga_template/src/comfyui/validators/graph-walker/validate-workflow.test.ts`

**Interfaces:**
- Consumes: `validateWorkflow` from `./validate-workflow.js`; `listFixtures`, `loadFixture` from `../fixture-loader.js`.

**Note:** This test reuses Approach A's 10 fixtures via the shared `fixture-loader.ts`. The cache isolation fix (`await fs.rm(join(tmpHome, 'node-defs.json'), { force: true })`) is critical — without it, iteration 1's cache is read by iterations 2-10.

- [ ] **Step 7.1: Add integration test to validate-workflow.test.ts** — Replace `sga_template/src/comfyui/validators/graph-walker/validate-workflow.test.ts` with:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { WorkflowIssue } from '../../issue-types.js'

describe('validate-workflow', () => {
  let tmpHome: string
  let tmpBaseDir: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-gw-orch-'))
    tmpBaseDir = await fs.mkdtemp(join(tmpdir(), 'sga-gw-comfyui-'))
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

  it('returns empty issues for empty workflow', async () => {
    const { validateWorkflow } = await import('./validate-workflow.js')
    const issues = await validateWorkflow({ nodes: [], links: [] })
    expect(issues).toEqual([])
  })

  it('deduplicates issues by id', async () => {
    const { RULES } = await import('./validator-registry.js')
    const mockIssue: WorkflowIssue = {
      id: 'test:1', nodeId: 1, severity: 'info', message: 'test', source: 'native',
    }
    RULES.push({
      id: 'mockDuplicate',
      run: () => [mockIssue, { ...mockIssue }],
    })
    const { validateWorkflow } = await import('./validate-workflow.js')
    const issues = await validateWorkflow({ nodes: [], links: [] })
    expect(issues.filter(i => i.id === 'test:1')).toHaveLength(1)
  })

  it('loads all fixtures and validates expected issue ids are present', async () => {
    const { listFixtures, loadFixture } = await import('../fixture-loader.js')
    for (const name of listFixtures()) {
      const fixture = loadFixture(name)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => fixture.objectInfo,
      } as unknown as Response))
      // Create model files on disk
      for (const [category, names] of Object.entries(fixture.models)) {
        for (const modelName of names) {
          const dir = join(tmpBaseDir, 'models', category)
          await fs.mkdir(dir, { recursive: true })
          await fs.writeFile(join(dir, modelName), 'fake')
        }
      }
      // Create media files on disk
      for (const mediaName of fixture.input) {
        const dir = join(tmpBaseDir, 'input')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(join(dir, mediaName), 'fake')
      }
      // Cache isolation fix: clear node-defs.json so each iteration re-fetches its own objectInfo
      await fs.rm(join(tmpHome, 'node-defs.json'), { force: true })
      vi.resetModules()
      const { validateWorkflow } = await import('./validate-workflow.js')
      const issues = await validateWorkflow(fixture.workflow)
      for (const expectedId of fixture.expectedIssueIds) {
        const found = issues.some(i => i.id === expectedId || i.id.startsWith(expectedId))
        expect(found, `Fixture "${name}": expected issue id "${expectedId}" not found. Got: ${issues.map(i => i.id).join(', ')}`).toBe(true)
      }
    }
  })
})
```

- [ ] **Step 7.2: Run integration test** — Run: `cd sga_template; npm test -- src/comfyui/validators/graph-walker/validate-workflow.test.ts`
Expected: PASS (3 tests including the 10-fixture integration test). All `expectedIssueIds` from all 10 fixtures are confirmed present.

- [ ] **Step 7.3: Run typecheck and full test suite** — Run: `cd sga_template; npm run typecheck; npm test`
Expected: 0 type errors; all tests pass (both Approach A and Approach C tests green).

- [ ] **Step 7.4: Commit** — Run:
```powershell
git add sga_template/src/comfyui/validators/graph-walker/validate-workflow.test.ts; git commit -m "test(comfyui-graph-walker): add 10-fixture integration test with cache isolation"
```

---

## Task 8: Deprecation markers + final verification

**Files:**
- Modify: `sga_template/src/comfyui/validators/port-type-validator.ts`
- Modify: `sga_template/src/comfyui/validators/missing-ref-validator.ts`
- Modify: `sga_template/src/comfyui/validators/illegal-link-validator.ts`
- Modify: `sga_template/src/comfyui/validators/unsupported-structure-validator.ts`
- Modify: `sga_template/src/comfyui/validators/validate-workflow.ts`

**Interfaces:** No new interfaces. Only JSDoc additions — no logic changes.

**Note:** No code changes to Approach A's logic — only `/** @deprecated ... */` JSDoc on exported functions.

- [ ] **Step 8.1: Add @deprecated to port-type-validator.ts** — In `sga_template/src/comfyui/validators/port-type-validator.ts`, add this JSDoc immediately above `export async function validatePortTypes` (line 41):

```ts
/** @deprecated Use graph-walker/rules/port-type.ts instead. Will be removed after the next release. */
```

- [ ] **Step 8.2: Add @deprecated to missing-ref-validator.ts** — In `sga_template/src/comfyui/validators/missing-ref-validator.ts`, add this JSDoc immediately above `export async function validateMissingReferences` (line 17):

```ts
/** @deprecated Use graph-walker/rules/missing-model.ts and graph-walker/rules/missing-media.ts instead. Will be removed after the next release. */
```

- [ ] **Step 8.3: Add @deprecated to illegal-link-validator.ts** — In `sga_template/src/comfyui/validators/illegal-link-validator.ts`, add this JSDoc immediately above `export function validateLinkStructure` (line 22):

```ts
/** @deprecated Use graph-walker/rules/dangling-link.ts, slot-oob.ts, self-loop.ts, and bidirectional-link.ts instead. Will be removed after the next release. */
```

- [ ] **Step 8.4: Add @deprecated to unsupported-structure-validator.ts** — In `sga_template/src/comfyui/validators/unsupported-structure-validator.ts`, add this JSDoc immediately above `export async function validateUnsupportedStructures` (line 30):

```ts
/** @deprecated Use graph-walker/rules/reroute-unconnected.ts, orphaned-aux.ts, deep-reroute-chain.ts, and primitive-multi-type.ts instead. Will be removed after the next release. */
```

- [ ] **Step 8.5: Add @deprecated to Approach A's validate-workflow.ts** — In `sga_template/src/comfyui/validators/validate-workflow.ts`, add this JSDoc immediately above the exported `validateWorkflow` function:

```ts
/** @deprecated Use graph-walker/validate-workflow.ts instead. Will be removed after the next release. */
```

- [ ] **Step 8.6: Run final typecheck** — Run: `cd sga_template; npm run typecheck`
Expected: 0 errors.

- [ ] **Step 8.7: Run final full test suite** — Run: `cd sga_template; npm test`
Expected: all tests green — both Approach A (deprecated) and Approach C tests pass. No regressions.

- [ ] **Step 8.8: Commit** — Run:
```powershell
git add sga_template/src/comfyui/validators/port-type-validator.ts sga_template/src/comfyui/validators/missing-ref-validator.ts sga_template/src/comfyui/validators/illegal-link-validator.ts sga_template/src/comfyui/validators/unsupported-structure-validator.ts sga_template/src/comfyui/validators/validate-workflow.ts; git commit -m "docs(comfyui-graph-walker): mark Approach A validators as @deprecated"
```

---

## Acceptance criteria checklist

- [ ] `compileGraph()` produces `CompiledGraph` with correct `nodes`, `links`, and `linksByNode` index (Task 1).
- [ ] All 11 rules implemented with issue id format matching Approach A (Tasks 2-6).
- [ ] Per-rule unit tests pass (≥1 test per rule trigger condition) (Tasks 2-6).
- [ ] Integration test reuses all 10 fixtures; all `expectedIssueIds` confirmed present (Task 7).
- [ ] Cross-implementation consistency: same fixture → same issue ids as Approach A (Task 7).
- [ ] `npm run typecheck` clean (all tasks).
- [ ] Existing Approach A tests still pass — no regression (all tasks).
- [ ] Env vars `SGA_MODEL_INDEX_TTL_MS`, `SGA_MAX_REROUTE_DEPTH`, `SGA_NODE_DEF_INDEX_TTL_MS` honored (Tasks 3, 4).
- [ ] No degradation logic — failures propagate (Tasks 4, 5, 6 — no try/catch around external calls).
- [ ] Approach A's files marked `@deprecated` (Task 8).
- [ ] PR is stackable on `feat/validation-engine-modular` and rebaseable onto `main` after PR 1 merges.
