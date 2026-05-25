import { registerBundledSkill } from '../bundled-registry.js'

const MODEL_EXPLORE_PROMPT = `# ComfyUI Model Explorer Skill

Explore and find available models in the ComfyUI environment.

## Steps

1. **List models by type:**
   - Use ComfyUIModelList to get an overview of all available models
   - Filter by type: checkpoints, loras, vae, controlnet, embeddings, etc.
2. **Search for specific models:**
   - Use ComfyUIModelList with search parameter to find models by name
   - Use Glob to search for model files if needed
3. **Check extra model paths:**
   - Read extra_model_paths.yaml for additional model directories
   - These may contain models not in the default models/ directory
4. **Get model details:**
   - Use ComfyUIAPI /view_metadata to get model metadata (if available)
   - Check model file sizes to estimate VRAM requirements
5. **Recommend models:**
   - Based on the user's task, suggest appropriate models
   - Consider: task type (txt2img, img2img, controlnet), quality, speed, VRAM

## Model Categories

### Checkpoints
- Full models containing UNet + CLIP + VAE
- Large files (2-7GB typically)
- Examples: sd_xl_base, dreamshaper, realisticVision

### LoRAs
- Lightweight style/concept modifiers
- Small files (10-200MB typically)
- Applied on top of checkpoints

### VAE
- Variational Autoencoders for encoding/decoding
- Small files (~300MB)
- Some checkpoints include built-in VAE

### ControlNet
- Conditioning models for guided generation
- Medium files (~1.5GB)
- Types: depth, canny, pose, scribble, etc.

### Embeddings/Textual Inversion
- Small concept/style vectors
- Very small files (<100MB)
- Used in positive/negative prompts
`

export function registerModelExploreSkill(): void {
  registerBundledSkill({
    name: 'model-explore',
    description: 'Explore available ComfyUI models. Lists checkpoints, LoRAs, VAEs, ControlNets and other models with search and filtering.',
    whenToUse: 'Use when the user wants to find, browse, or check available models in their ComfyUI installation.',
    allowedTools: ['ComfyUIModelList', 'ComfyUIAPI', 'Read', 'Glob', 'Bash'],
    argumentHint: '[model type or search query]',
    userInvocable: true,
    disableModelInvocation: false,
    prompt: MODEL_EXPLORE_PROMPT,
  })
}
