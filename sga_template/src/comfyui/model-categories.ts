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
