import { registerBundledSkill } from '../bundled-registry.js'

const WORKFLOW_OPTIMIZE_PROMPT = `# ComfyUI Workflow Optimization Skill

Optimize a ComfyUI workflow for better performance, quality, or resource usage.

## Steps

1. **Analyze the current workflow:**
   - Use ComfyUIWorkflowValidate to check for structural issues
   - Read the workflow JSON to understand the node graph
   - Identify the data flow and critical path
2. **Check system resources:**
   - Use ComfyUIAPI /system_stats to check available VRAM
   - Determine if the workflow fits in available memory
3. **Identify optimization opportunities:**
   - **Memory optimization**: Enable tiling, reduce batch size, use fp16
   - **Speed optimization**: Reduce steps, use faster samplers, enable xformers
   - **Quality optimization**: Adjust CFG scale, use better schedulers, add refinement passes
   - **Structure optimization**: Remove redundant nodes, simplify connections
4. **Apply optimizations:**
   - Modify node parameters (steps, cfg, denoise)
   - Replace nodes with more efficient alternatives
   - Add optimization nodes (e.g., VAEDecodeTiled instead of VAEDecode)
   - Adjust model precision settings
5. **Validate the optimized workflow:**
   - Use ComfyUIWorkflowValidate to ensure structural integrity
   - Verify all connections are still valid
6. **Present the optimized workflow:**
   - Show before/after comparison
   - Explain each optimization and its expected impact
   - Provide the complete optimized JSON

## Optimization Strategies

### Memory Optimization
- Use VAEDecodeTiled instead of VAEDecode for large images
- Reduce batch_size to 1
- Use fp16/bf16 precision
- Enable attention slicing
- Use low VRAM mode for large models

### Speed Optimization
- Use Euler or Euler_a sampler (faster than DPM++)
- Reduce steps (20-25 is often sufficient)
- Use simpler schedulers (normal, karras)
- Avoid unnecessary KSampler refinements

### Quality Optimization
- Use DPM++ 2M Karras for photorealistic
- Use Euler a for artistic/creative
- Add a second pass with lower denoise (0.3-0.5)
- Use better VAE (vae-ft-mse for SD1.5)
- Adjust CFG scale (7-8 typical, lower for more creative)

### Structural Optimization
- Remove disconnected nodes
- Merge redundant CLIPTextEncode nodes
- Use CheckpointLoaderSimple instead of separate loaders
- Remove unused LoRA loaders
`

export function registerWorkflowOptimizeSkill(): void {
  registerBundledSkill({
    name: 'workflow-optimize',
    description: 'Optimize a ComfyUI workflow for performance, quality, or memory usage. Analyzes and improves the workflow.',
    whenToUse: 'Use when the user wants to speed up, improve quality, or reduce memory usage of a workflow.',
    allowedTools: ['ComfyUIModelList', 'ComfyUINodeSearch', 'ComfyUIWorkflowValidate', 'ComfyUIAPI', 'Read', 'Grep', 'Glob'],
    argumentHint: '[workflow JSON or optimization goal]',
    userInvocable: true,
    disableModelInvocation: false,
    prompt: WORKFLOW_OPTIMIZE_PROMPT,
  })
}
