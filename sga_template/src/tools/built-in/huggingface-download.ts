import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult, type PermissionResult } from '../base.js'

const MODEL_FOLDER_MAP: Record<string, string> = {
  checkpoint: 'checkpoints',
  checkpoints: 'checkpoints',
  lora: 'loras',
  loras: 'loras',
  vae: 'vae',
  controlnet: 'controlnet',
  controlnets: 'controlnet',
  embedding: 'embeddings',
  embeddings: 'embeddings',
  clip: 'clip',
  clip_vision: 'clip_vision',
  unet: 'diffusion_models',
  diffusion_model: 'diffusion_models',
  diffusion_models: 'diffusion_models',
  upscale: 'upscale_models',
  upscale_model: 'upscale_models',
  upscale_models: 'upscale_models',
  hypernetwork: 'hypernetworks',
  hypernetworks: 'hypernetworks',
  ipadapter: 'ipadapter',
  insightface: 'insightface',
  instantid: 'instantid',
  gligen: 'gligen',
  audio_encoder: 'audio_encoders',
  audio_encoders: 'audio_encoders',
  config: 'configs',
  configs: 'configs',
  detector: 'detection',
  detection: 'detection',
  facedetection: 'facedetection',
  facerestore: 'facerestore_models',
  facerestore_models: 'facerestore_models',
  face_parsing: 'face_parsing',
  facexlib: 'facexlib',
  'grounding-dino': 'grounding-dino',
  style_models: 'style_models',
  text_encoder: 'clip',
  transformer: 'diffusion_models',
}

function inferTargetFolder(modelId: string, nodeType?: string): string {
  if (nodeType) {
    const lower = nodeType.toLowerCase()
    for (const [keyword, folder] of Object.entries(MODEL_FOLDER_MAP)) {
      if (lower.includes(keyword)) return folder
    }
  }

  const lower = modelId.toLowerCase()

  if (lower.includes('lora') || lower.includes('lycoris')) return 'loras'
  if (lower.includes('controlnet') || lower.includes('cnet') || lower.includes('t2i-adapter')) return 'controlnet'
  if (lower.includes('vae') || lower.includes('variational')) return 'vae'
  if (lower.includes('embedding') || lower.includes('textual-inversion') || lower.includes('ti_')) return 'embeddings'
  if (lower.includes('clip-vision') || lower.includes('clip_vision') || lower.includes('sigclip') || lower.includes('visual-encoder')) return 'clip_vision'
  if (lower.includes('clip') || lower.includes('text-encoder') || lower.includes('t5') || lower.includes('umt5') || lower.includes('bert')) return 'clip'
  if (lower.includes('upscale') || lower.includes('esrgan') || lower.includes('realesrgan') || lower.includes('swinir')) return 'upscale_models'
  if (lower.includes('ip-adapter') || lower.includes('ipadapter')) return 'ipadapter'
  if (lower.includes('insightface') || lower.includes('antelope') || lower.includes('buffalo')) return 'insightface'
  if (lower.includes('instantid')) return 'instantid'
  if (lower.includes('grounding-dino') || lower.includes('groundingdino')) return 'grounding-dino'
  if (lower.includes('face') && (lower.includes('restore') || lower.includes('gfpgan') || lower.includes('codeformer'))) return 'facerestore_models'
  if (lower.includes('audio') || lower.includes('wav2vec') || lower.includes('whisper')) return 'audio_encoders'
  if (lower.includes('hypernetwork')) return 'hypernetworks'
  if (lower.includes('diffusion') || lower.includes('unet') || lower.includes('transformer')) return 'diffusion_models'

  return 'checkpoints'
}

function findComfyUIBaseDir(): string | null {
  const path = require('path')
  const fs = require('fs')

  if (process.env.COMFYUI_BASE_DIR) {
    const dir = process.env.COMFYUI_BASE_DIR
    if (fs.existsSync(path.join(dir, 'models'))) return dir
  }

  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'main.py')) && fs.existsSync(path.join(dir, 'models'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'models'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

export class HuggingFaceDownloadTool extends BaseTool<{
  model_id: string
  target_folder?: string
  mirror?: boolean
  filename?: string
  node_type?: string
}, string> {
  name = 'huggingface_download'
  description = `Download models from HuggingFace or hf-mirror.com (China mirror) to the correct ComfyUI models directory. 
Use this when a model is missing from the workflow. The tool automatically:
1. Detects the ComfyUI installation directory
2. Infers the correct model subfolder (checkpoints, loras, vae, controlnet, clip, etc.) based on model name and node type
3. Uses hf-mirror.com by default for faster downloads in China
4. Falls back to curl/wget if huggingface-cli is not available

Common model folder mapping:
- Stable Diffusion / SDXL / Flux checkpoints -> checkpoints
- LoRA / LyCORIS -> loras
- VAE -> vae
- ControlNet / T2I-Adapter -> controlnet
- CLIP / Text encoders -> clip
- CLIP Vision -> clip_vision
- Upscale models -> upscale_models
- IP-Adapter -> ipadapter
- Embeddings -> embeddings`
  searchHint = 'huggingface model download hf mirror'

  isReadOnly(): boolean {
    return false
  }

  isConcurrencySafe(): boolean {
    return false
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const modelId = (input as { model_id?: string }).model_id
    if (!modelId || typeof modelId !== 'string') return { success: false, error: 'model_id is required and must be a string' }
    return { success: true }
  }

  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: 'ask', message: 'This will download a model file from HuggingFace. Continue?', suggestions: ['Allow download', 'Deny'] }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        model_id: { type: 'string', description: 'The HuggingFace model ID (e.g. "stabilityai/stable-diffusion-xl-base-1.0")' },
        target_folder: { type: 'string', description: 'Target subfolder under ComfyUI models directory. If not specified, auto-inferred from model name and node type. Common values: checkpoints, loras, vae, controlnet, clip, clip_vision, upscale_models, ipadapter, embeddings' },
        mirror: { type: 'boolean', description: 'Use hf-mirror.com instead of huggingface.co (recommended for China users)', default: true },
        filename: { type: 'string', description: 'Specific filename to download (if not specified, downloads the main model file)' },
        node_type: { type: 'string', description: 'The ComfyUI node type that needs this model (used to infer the correct target folder)' },
      },
      required: ['model_id'],
    }
  }

  async call(input: { model_id: string; target_folder?: string; mirror?: boolean; filename?: string; node_type?: string }, _context: ToolUseContext): Promise<string> {
    const { execSync } = await import('child_process')
    const path = await import('path')
    const fs = await import('fs')

    const modelId = input.model_id
    const targetFolder = input.target_folder || inferTargetFolder(modelId, input.node_type)
    const useMirror = input.mirror !== false
    const filename = input.filename

    const comfyuiBaseDir = findComfyUIBaseDir()
    if (!comfyuiBaseDir) {
      return `Error: Could not locate ComfyUI installation directory. Please set the COMFYUI_BASE_DIR environment variable.\n\nSearched from: ${process.cwd()}`
    }

    const modelsDir = path.join(comfyuiBaseDir, 'models', targetFolder)

    try {
      if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true })
      }
    } catch {
      return `Error: Could not create models directory at ${modelsDir}`
    }

    const endpoint = useMirror
      ? (process.env.HF_MIRROR_URL ?? 'https://hf-mirror.com')
      : (process.env.HF_ORIGIN_URL ?? 'https://huggingface.co')

    try {
      let command: string

      if (filename) {
        command = `huggingface-cli download --endpoint ${endpoint} "${modelId}" "${filename}" --local-dir "${modelsDir}" --local-dir-use-symlinks False`
      } else {
        command = `huggingface-cli download --endpoint ${endpoint} "${modelId}" --local-dir "${modelsDir}" --local-dir-use-symlinks False`
      }

      const result = execSync(command, {
        timeout: parseInt(process.env.HF_DOWNLOAD_TIMEOUT ?? '600000', 10),
        maxBuffer: parseInt(process.env.HF_MAX_BUFFER ?? String(10 * 1024 * 1024), 10),
        encoding: 'utf-8',
        shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
      })

      return `Model downloaded successfully!\n\nModel: ${modelId}\nTarget folder: ${targetFolder}\nFull path: ${modelsDir}\nSource: ${endpoint}\nComfyUI base: ${comfyuiBaseDir}\n\nOutput:\n${result.slice(-500)}`
    } catch (hfError) {
      const hfErrMsg = hfError instanceof Error ? hfError.message : String(hfError)

      try {
        const modelSlug = modelId.split('/').pop() || modelId
        const downloadFilename = filename || `${modelSlug}.safetensors`
        const downloadUrl = `${endpoint}/${modelId}/resolve/main/${downloadFilename}`
        const outputPath = path.join(modelsDir, downloadFilename)

        let wgetCommand: string
        if (process.platform === 'win32') {
          wgetCommand = `curl -L -o "${outputPath}" "${downloadUrl}"`
        } else {
          wgetCommand = `wget -O "${outputPath}" "${downloadUrl}"`
        }

        const result = execSync(wgetCommand, {
          timeout: parseInt(process.env.HF_DOWNLOAD_TIMEOUT ?? '600000', 10),
          maxBuffer: parseInt(process.env.HF_MAX_BUFFER ?? String(10 * 1024 * 1024), 10),
          encoding: 'utf-8',
          shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
        })

        return `Model downloaded via fallback method!\n\nModel: ${modelId}\nTarget folder: ${targetFolder}\nFull path: ${outputPath}\nSource: ${downloadUrl}\nComfyUI base: ${comfyuiBaseDir}\n\nNote: huggingface-cli was not available, used ${process.platform === 'win32' ? 'curl' : 'wget'} instead.`
      } catch (fallbackError) {
        const fbErrMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        return `Failed to download model "${modelId}".\n\nTarget folder: ${targetFolder}\nComfyUI base: ${comfyuiBaseDir}\n\nhuggingface-cli error: ${hfErrMsg.slice(0, 300)}\n\nFallback error: ${fbErrMsg.slice(0, 300)}\n\nPlease download manually from:\n${endpoint}/${modelId}\nAnd place the file in: ${modelsDir}`
      }
    }
  }
}
