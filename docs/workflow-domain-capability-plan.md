# Workflow Domain Capability Plan

Last updated: 2026-06-28

This plan tracks future work for stronger ComfyUI workflow understanding. It is intentionally not implemented in the current stabilization pass.

## Goal

Make the agent reason about ComfyUI workflows as structured domain data instead of loose JSON. The desired path is:

```text
workflow input -> normalizer -> node definition index -> validator -> patch planner -> preview -> transactional apply/undo
```

## Workstreams

### 1. Workflow Normalizer

- Accept both ComfyUI graph JSON and API prompt JSON.
- Convert both formats into one internal model.
- Preserve source IDs, node types, ports, widgets, links, and metadata needed for round-trip stability.
- Add fixtures for common txt2img, img2img, ControlNet, LoRA, and multi-output workflows.

### 2. Node Definition Index

- Pull node definitions from ComfyUI `/object_info`.
- Cache node type, input ports, output ports, widget schemas, defaults, and type constraints.
- Track cache freshness and ComfyUI reachability.
- Surface missing custom-node definitions as explicit diagnostics.

### 3. Validation Engine

Detect and report:

- missing node types;
- missing model or media references;
- illegal links;
- port type mismatches;
- missing required widgets;
- orphaned outputs;
- unstable or unsupported structures.

Each issue should include a stable node, port, widget, or link reference when possible.

### 4. Patch Planner

- Generate a readable diff before modifying a workflow.
- Produce reversible patch operations.
- Separate proposed changes from applied changes.
- Let the UI preview changes before apply.

### 5. Transactional Apply And Undo

- Apply a patch atomically: all operations succeed or the workflow rolls back.
- Keep recent patch history.
- Allow one-click undo for applied workflow changes.
- Record audit metadata without storing unnecessary sensitive prompt content.

### 6. Domain Test Corpus

Create a local fixture corpus covering:

- txt2img;
- img2img;
- ControlNet;
- LoRA;
- multi-output graph branches;
- missing models;
- missing custom nodes;
- malformed links;
- widget schema mismatches.

### 7. UI Workflow Diagnostics Upgrade

- Show issue reason, impact, and location.
- Offer `Apply fix` only when an automatic fix is deterministic and reversible.
- Give clear next steps when a fix requires user action.
- Keep this separate from System Diagnostics, which covers backend/provider/Codex/MCP state.

## Acceptance Criteria

- The same workflow remains structurally stable through `normalizer -> validator -> patch preview -> apply`.
- Validation issues point to specific node, port, widget, or link references.
- Patch preview is understandable before apply.
- Apply/undo is transactional and preserves workflow integrity.
- Automated tests cover representative ComfyUI workflow samples without requiring network access.
