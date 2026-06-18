import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'
import { readdir, stat, readFile } from 'fs/promises'
import { join, resolve, extname } from 'path'
import { existsSync } from 'fs'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('comfyui-model-list')

const MODEL_EXTENSIONS = new Set([
  '.safetensors', '.ckpt', '.pt', '.bin', '.pth', '.onnx', '.engine',
])

const MODEL_CATEGORIES: Record<string, string[]> = {
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

function getComfyUIBaseDir(): string {
  return process.env.COMFYUI_BASE_DIR ?? process.cwd()
}

interface ModelEntry {
  name: string
  path: string
  sizeBytes: number
  extension: string
  category: string
}

async function scanModelDir(modelsDir: string, category: string): Promise<ModelEntry[]> {
  const entries: ModelEntry[] = []

  async function walk(dir: string): Promise<void> {
    let files
    try {
      files = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const file of files) {
      if (file.name.startsWith('.')) continue
      const fullPath = join(dir, file.name)

      if (file.isDirectory()) {
        await walk(fullPath)
      } else if (file.isFile()) {
        const ext = extname(file.name).toLowerCase()
        if (MODEL_EXTENSIONS.has(ext)) {
          let sizeBytes = 0
          try {
            const stats = await stat(fullPath)
            sizeBytes = stats.size
          } catch {
            // skip
          }
          entries.push({
            name: file.name,
            path: fullPath,
            sizeBytes,
            extension: ext,
            category,
          })
        }
      }
    }
  }

  await walk(modelsDir)
  return entries
}

async function parseExtraModelPaths(baseDir: string): Promise<Array<{ prefix: string; path: string }>> {
  const yamlPath = join(baseDir, 'extra_model_paths.yaml')
  if (!existsSync(yamlPath)) return []

  try {
    const content = await readFile(yamlPath, 'utf-8')
    const results: Array<{ prefix: string; path: string }> = []

    const lines = content.split('\n')
    let currentPrefix = ''
    for (const line of lines) {
      const prefixMatch = line.match(/^(\w+):\s*$/)
      if (prefixMatch) {
        currentPrefix = prefixMatch[1]
        continue
      }
      const pathMatch = line.match(/^\s+(\w+):\s*(.+?)\s*$/)
      if (pathMatch && currentPrefix) {
        const key = pathMatch[1]
        const value = pathMatch[2].trim()
        if (key === 'base_path') {
          results.push({ prefix: currentPrefix, path: value })
        }
      }
    }

    return results
  } catch {
    return []
  }
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

export class ComfyUIModelListTool extends BaseTool<
  { modelType?: string; search?: string },
  string
> {
  name = 'ComfyUIModelList'
  description = 'List available ComfyUI models organized by type (checkpoints, loras, vae, controlnet, etc.). Searches the models/ directory and extra_model_paths.yaml. Much faster than using Bash/Glob to find models.'
  searchHint = 'comfyui models checkpoints loras vae controlnet list search'

  isReadOnly(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  isDestructive(): boolean {
    return false
  }

  requiresUserInteraction(): boolean {
    return false
  }

  isEnabled(): boolean {
    return !!process.env.COMFYUI_BASE_DIR
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    return { success: true }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        modelType: {
          type: 'string',
          description: 'Filter by model type: checkpoints, loras, vae, controlnet, embeddings, upscale_models, clip, unet, style_models, hypernetworks, or "all" (default: all)',
        },
        search: {
          type: 'string',
          description: 'Search filter - only return models whose filename contains this string (case-insensitive)',
        },
      },
      required: [],
    }
  }

  async call(input: { modelType?: string; search?: string }, _context: ToolUseContext): Promise<string> {
    const baseDir = getComfyUIBaseDir()
    const modelsDir = join(baseDir, 'models')

    if (!existsSync(modelsDir)) {
      return `ComfyUI models directory not found at: ${modelsDir}\nSet COMFYUI_BASE_DIR environment variable to the ComfyUI root directory.`
    }

    const requestedType = input.modelType?.toLowerCase() ?? 'all'
    const searchFilter = input.search?.toLowerCase()

    const categoriesToScan = requestedType === 'all'
      ? Object.entries(MODEL_CATEGORIES)
      : Object.entries(MODEL_CATEGORIES).filter(([key]) => key === requestedType)

    if (categoriesToScan.length === 0) {
      return `Unknown model type: "${requestedType}". Available types: ${Object.keys(MODEL_CATEGORIES).join(', ')}, all`
    }

    const allModels: ModelEntry[] = []

    for (const [category, subdirs] of categoriesToScan) {
      for (const subdir of subdirs) {
        const dirPath = join(modelsDir, subdir)
        if (existsSync(dirPath)) {
          const models = await scanModelDir(dirPath, category)
          allModels.push(...models)
        }
      }
    }

    const extraPaths = await parseExtraModelPaths(baseDir)
    for (const { prefix, path: basePath } of extraPaths) {
      if (requestedType !== 'all' && prefix.toLowerCase() !== requestedType) continue
      if (existsSync(basePath)) {
        const models = await scanModelDir(basePath, prefix)
        allModels.push(...models)
      }
    }

    let filtered = allModels
    if (searchFilter) {
      filtered = filtered.filter(m => m.name.toLowerCase().includes(searchFilter))
    }

    if (filtered.length === 0) {
      return searchFilter
        ? `No models found matching "${input.search}" in type "${requestedType}".`
        : `No models found in type "${requestedType}". The models/ directory may be empty or the path may be incorrect.`
    }

    const grouped = new Map<string, ModelEntry[]>()
    for (const model of filtered) {
      const existing = grouped.get(model.category) ?? []
      existing.push(model)
      grouped.set(model.category, existing)
    }

    const lines: string[] = [`Found ${filtered.length} model(s):`]

    for (const [category, models] of grouped) {
      lines.push(`\n## ${category} (${models.length})`)
      for (const model of models) {
        const sizeStr = formatSize(model.sizeBytes)
        lines.push(`  - ${model.name} (${sizeStr})`)
      }
    }

    return lines.join('\n')
  }
}
