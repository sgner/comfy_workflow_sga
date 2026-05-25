import { buildConsolidationPrompt, ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES } from '../memory/consolidation/consolidation-prompt.js'

export function buildComfyUIConsolidationPrompt(
  memoryRoot: string,
  extra: string,
): string {
  const basePrompt = buildConsolidationPrompt(memoryRoot, extra)

  return `${basePrompt}

## ComfyUI-Specific Consolidation Directives

When consolidating memories for a ComfyUI Agent, pay special attention to these domain-specific categories:

### 1. Model Paths and Availability
- Record exact model file paths discovered (checkpoints, loras, vae, controlnet, upscale_models, embeddings)
- Note which model directories are configured in extra_model_paths.yaml
- Track model compatibility issues (e.g., SD 1.5 vs SDXL checkpoints requiring different node configurations)

### 2. Common Error Patterns
- Missing model errors: which models are frequently requested but not installed
- Node type mismatches: which node connections commonly fail and why
- Version incompatibilities: custom_nodes that conflict with specific ComfyUI versions
- Common runtime errors and their resolutions

### 3. Node Compatibility Knowledge
- Which custom_nodes provide which node types
- Required inputs and outputs for frequently used nodes
- Node type aliases and alternative names
- Deprecated nodes and their replacements

### 4. Workflow Patterns
- Successful workflow patterns for common tasks (txt2img, img2img, controlnet, etc.)
- Efficient node combinations and shortcuts
- Performance optimization patterns (model offloading, batch processing)

### 5. Environment Configuration
- ComfyUI installation path and directory structure
- Python environment details (version, venv path)
- GPU and VRAM constraints that affect workflow design
- Custom configuration in extra_model_paths.yaml or config files

### Memory File Organization for ComfyUI

Organize consolidated memories into these topic files:
- \`comfyui-models.md\` — Available models, paths, and compatibility
- \`comfyui-errors.md\` — Common errors and their resolutions
- \`comfyui-nodes.md\` — Node types, compatibility, and usage patterns
- \`comfyui-workflows.md\` — Successful workflow patterns and templates
- \`comfyui-environment.md\` — Installation and configuration details

Keep ${ENTRYPOINT_NAME} under ${MAX_ENTRYPOINT_LINES} lines. Prioritize actionable knowledge over verbose descriptions.`
}
