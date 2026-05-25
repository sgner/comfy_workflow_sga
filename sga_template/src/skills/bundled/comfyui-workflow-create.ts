import { registerBundledSkill } from '../bundled-registry.js'

const WORKFLOW_CREATE_PROMPT = `# ComfyUI Workflow Creation Skill

Create a ComfyUI workflow based on the user's description.

## Steps

1. **Understand the user's intent** — what kind of image/video generation task do they want?
2. **Check available resources:**
   - Use ComfyUIModelList to see what models (checkpoints, loras, vae) are available
   - Use ComfyUINodeSearch to find relevant node types
   - Use ComfyUIAPI /system_stats to check GPU availability
3. **Design the workflow:**
   - Choose appropriate model (checkpoint, lora, etc.)
   - Select the right sampler and scheduler for the task
   - Plan the node connections and data flow
   - Consider: input → encode → sample → decode → save
4. **Build the workflow JSON:**
   - Each node needs: id, type, pos, inputs, outputs, widgets_values
   - Each link needs: id, origin_id, origin_slot, target_id, target_slot, type
   - Use proper data types for connections (MODEL, CLIP, VAE, CONDITIONING, LATENT, IMAGE)
5. **Validate the workflow:**
   - Use ComfyUIWorkflowValidate to check for structural issues
   - Fix any errors or warnings found
6. **Present the workflow:**
   - Output the complete JSON in a markdown code block
   - Explain the workflow structure and data flow
   - List the models required and their expected locations

## Common Workflow Patterns

### Basic TXT2IMG
LoadCheckpoint → CLIPTextEncode (positive) → CLIPTextEncode (negative) → KSampler → VAEDecode → SaveImage

### IMG2IMG
LoadCheckpoint → CLIPTextEncode → LoadImage → VAEEncode → KSampler → VAEDecode → SaveImage

### With LoRA
LoadCheckpoint → LoraLoader → CLIPTextEncode → KSampler → VAEDecode → SaveImage

### ControlNet
LoadCheckpoint → CLIPTextEncode → LoadControlNetModel → ApplyControlNet → KSampler → VAEDecode → SaveImage

## Important Rules
- Always use ComfyUIModelList to check available models before referencing them
- Always validate the workflow with ComfyUIWorkflowValidate before presenting
- Ensure all node IDs are unique positive integers
- Ensure all link references point to existing nodes
- Use realistic widget_values (steps: 20-30, cfg: 7-8, etc.)
`

export function registerWorkflowCreateSkill(): void {
  registerBundledSkill({
    name: 'workflow-create',
    description: 'Create a ComfyUI workflow from a user description. Checks available models, designs node graph, and validates the result.',
    whenToUse: 'Use when the user wants to create a new ComfyUI workflow or generate an image/video workflow.',
    allowedTools: ['ComfyUIModelList', 'ComfyUINodeSearch', 'ComfyUIWorkflowValidate', 'ComfyUIAPI', 'Read', 'Grep', 'Glob'],
    argumentHint: '[workflow description]',
    userInvocable: true,
    disableModelInvocation: false,
    prompt: WORKFLOW_CREATE_PROMPT,
  })
}
