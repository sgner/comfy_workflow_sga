import { registerBundledSkill } from '../bundled-registry.js'

const WORKFLOW_DEBUG_PROMPT = `# ComfyUI Workflow Debug Skill

Debug a ComfyUI workflow that has errors or is not producing expected results.

## Steps

1. **Analyze the error:**
   - Check the error message type (execution error, validation error, model loading error)
   - Identify which node(s) are failing
2. **Validate the workflow structure:**
   - Use ComfyUIWorkflowValidate to check for structural issues
   - Look for: missing connections, invalid node types, broken links
3. **Check model availability:**
   - Use ComfyUIModelList to verify referenced models exist
   - Check model paths and filenames match exactly
4. **Check node compatibility:**
   - Use ComfyUINodeSearch to verify node types exist
   - Check input/output type compatibility between connected nodes
   - Verify widget values are within valid ranges
5. **Check system resources:**
   - Use ComfyUIAPI /system_stats to check VRAM availability
   - Large models may need more VRAM than available
6. **Fix the issues:**
   - Correct any structural problems found
   - Replace missing models with available alternatives
   - Fix incompatible connections
   - Adjust parameters if needed
7. **Present the fix:**
   - Explain what was wrong
   - Show the corrected workflow JSON
   - Validate the fix with ComfyUIWorkflowValidate

## Common Error Patterns

### Model Not Found
- Check exact filename in models/ directory
- Check extra_model_paths.yaml for additional paths
- Suggest downloading the model if missing

### Type Mismatch
- MODEL output must connect to MODEL input
- CLIP output must connect to CLIP input
- CONDITIONING output must connect to CONDITIONING input
- LATENT output must connect to LATENT input

### Execution Errors
- Out of VRAM: reduce batch_size, use lower precision, or enable tiling
- Invalid parameters: check step count, cfg scale, dimensions
- Missing inputs: all required inputs must be connected

### Node Not Found
- Custom node may not be installed
- Use ComfyUINodeSearch to find alternatives
- Check custom_nodes/ directory
`

export function registerWorkflowDebugSkill(): void {
  registerBundledSkill({
    name: 'workflow-debug',
    description: 'Debug a ComfyUI workflow that has errors. Validates structure, checks models, and fixes issues.',
    whenToUse: 'Use when the user reports a workflow error, execution failure, or unexpected output.',
    allowedTools: ['ComfyUIModelList', 'ComfyUINodeSearch', 'ComfyUIWorkflowValidate', 'ComfyUIAPI', 'Read', 'Grep', 'Glob', 'Bash'],
    argumentHint: '[error description or workflow JSON]',
    userInvocable: true,
    disableModelInvocation: false,
    prompt: WORKFLOW_DEBUG_PROMPT,
  })
}
