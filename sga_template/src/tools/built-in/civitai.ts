import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult, type PermissionResult } from '../base.js'

/**
 * CivitAI 模型管理工具
 *
 * 提供:
 * 1. 搜索模型 (action=search)
 * 2. 获取模型详情 (action=get)
 * 3. 列出模型文件 (action=list_files)
 * 4. 下载模型到 ComfyUI 正确目录 (action=download)
 * 5. 浏览 tag (action=tags)
 * 6. 列举枚举值 (action=enums)
 *
 * 文档: https://developer.civitai.com/site/reference/
 */

const CIVITAI_API_BASE = process.env.CIVITAI_API_BASE ?? 'https://civitai.com/api/v1'

// CivitAI 的 ModelType 枚举值 -> ComfyUI models 子目录
const TYPE_TO_FOLDER: Record<string, string> = {
  Checkpoint: 'checkpoints',
  TextualInversion: 'embeddings',
  Hypernetwork: 'hypernetworks',
  AestheticGradient: 'embeddings',
  LORA: 'loras',
  LoCon: 'loras',
  DoRA: 'loras',
  Controlnet: 'controlnet',
  Upscaler: 'upscale_models',
  MotionModule: 'motion_models',
  VAE: 'vae',
  Poses: 'poses',
  Wildcards: 'wildcards',
  Workflows: 'workflows',
  Detection: 'detection',
  Other: 'other',
}

function inferTargetFolder(modelType: string, fileType?: string): string {
  if (fileType === 'VAE') return 'vae'
  if (fileType === 'Config') return 'configs'
  if (fileType === 'Text Encoder') return 'clip'
  if (fileType === 'Pruned Model') return 'checkpoints'
  if (fileType === 'Training Data') return 'training_data'
  if (fileType === 'Archive') return 'archives'
  const folder = TYPE_TO_FOLDER[modelType]
  if (folder) return folder
  return 'other'
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

function getApiKey(): string | null {
  // 优先从环境变量读取,然后从 sga .env 读取
  if (process.env.CIVITAI_API_KEY) return process.env.CIVITAI_API_KEY
  if (process.env.CIVITAI_TOKEN) return process.env.CIVITAI_TOKEN
  try {
    const fs = require('fs')
    const path = require('path')
    // 上溯 4 层找 sga_template/.env
    let dir = process.cwd()
    for (let i = 0; i < 6; i++) {
      const envPath = path.join(dir, 'sga_template', '.env')
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8')
        const m = content.match(/^CIVITAI_API_KEY\s*=\s*["']?([^"'\n]+)["']?/m)
        if (m) return m[1].trim()
        const m2 = content.match(/^CIVITAI_TOKEN\s*=\s*["']?([^"'\n]+)["']?/m)
        if (m2) return m2[1].trim()
        break
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // ignore
  }
  return null
}

async function civitaiFetch(endpoint: string, params?: Record<string, string | number | boolean | undefined>): Promise<any> {
  const url = new URL(`${CIVITAI_API_BASE}${endpoint}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue
      url.searchParams.append(k, String(v))
    }
  }
  const headers: Record<string, string> = {
    'User-Agent': process.env.SGA_USER_AGENT ?? 'comfy-workflow-agent/1.0',
    'Content-Type': 'application/json',
  }
  const apiKey = getApiKey()
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  const res = await fetch(url.toString(), { headers })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`CivitAI API error ${res.status}: ${body.slice(0, 300)}`)
  }
  return await res.json()
}

function formatSize(sizeKB: number): string {
  if (!sizeKB || sizeKB < 0) return 'unknown'
  const sizeGB = sizeKB / 1024 / 1024
  if (sizeGB >= 1) return `${sizeGB.toFixed(2)} GB`
  const sizeMB = sizeKB / 1024
  return `${sizeMB.toFixed(1)} MB`
}

function summarizeModel(m: any): string {
  const lines: string[] = []
  lines.push(`#${m.id} ${m.name}  [${m.type}]`)
  if (m.creator?.username) lines.push(`  by ${m.creator.username}`)
  if (m.stats) {
    lines.push(`  ⬇ ${(m.stats.downloadCount || 0).toLocaleString()}  👍 ${(m.stats.thumbsUpCount || 0).toLocaleString()}`)
  }
  if (Array.isArray(m.tags) && m.tags.length) {
    lines.push(`  tags: ${m.tags.slice(0, 10).join(', ')}`)
  }
  if (Array.isArray(m.modelVersions) && m.modelVersions.length) {
    const v = m.modelVersions[0]
    lines.push(`  latest: ${v.name}  baseModel: ${v.baseModel || 'n/a'}  id: ${v.id}`)
  }
  return lines.join('\n')
}

export class CivitAITool extends BaseTool<{
  action: 'search' | 'get' | 'list_files' | 'download' | 'tags' | 'enums'
  query?: string
  model_id?: number
  model_version_id?: number
  filename?: string
  target_folder?: string
  types?: string
  base_models?: string
  sort?: 'Highest Rated' | 'Most Downloaded' | 'Newest' | 'Most Liked' | 'Most Discussed' | 'Most Collect'
  nsfw?: boolean
  limit?: number
  cursor?: string
  supports_generation?: boolean
  page?: number
  tag_query?: string
}, string> {
  name = 'civitai'
  aliases = ['civitai_search', 'civitai_download']
  description = `Interact with CivitAI (https://civitai.com) - the largest hub for Stable Diffusion / Flux / SDXL / Wan / Hunyuan checkpoints, LoRAs, VAEs, ControlNets, etc.

Actions:
- search: search models by free-text query, tag, type, base model. Returns ranked list with model id, name, type, latest version id, base model, stats.
- get: fetch a model by id with full description, all versions, files, and preview images metadata.
- list_files: list all downloadable files for a given model_version_id, including filename, type, sizeKB, hashes, downloadUrl.
- download: download a file from a model version to the correct ComfyUI models subfolder (auto-inferred from ModelType/ModelFileType, e.g. LORA -> loras, VAE -> vae, Checkpoint -> checkpoints, Controlnet -> controlnet, Upscaler -> upscale_models, TextualInversion -> embeddings).
- tags: list or search tags available for filtering models.
- enums: list valid values for ModelType, ModelFileType, BaseModel, ActiveBaseModel, BaseModelType.

Auth: optional API key via env CIVITAI_API_KEY or CIVITAI_TOKEN (some endpoints/features require auth).`
  searchHint = 'civitai model download lora checkpoint sdxl flux wan search'

  isReadOnly(): boolean {
    return false
  }

  isConcurrencySafe(): boolean {
    return false
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const i = input as Record<string, unknown>
    const action = i.action
    if (typeof action !== 'string') return { success: false, error: 'action is required' }
    const allowed = ['search', 'get', 'list_files', 'download', 'tags', 'enums']
    if (!allowed.includes(action)) {
      return { success: false, error: `action must be one of: ${allowed.join(', ')}` }
    }
    if (action === 'get' && (typeof i.model_id !== 'number' || (i.model_id as number) <= 0)) {
      return { success: false, error: 'model_id is required for action=get' }
    }
    if (action === 'list_files' && (typeof i.model_version_id !== 'number' || (i.model_version_id as number) <= 0)) {
      return { success: false, error: 'model_version_id is required for action=list_files' }
    }
    if (action === 'download' && (typeof i.model_version_id !== 'number' || (i.model_version_id as number) <= 0)) {
      return { success: false, error: 'model_version_id is required for action=download' }
    }
    return { success: true }
  }

  async checkPermissions(input: { action: string }, _context: ToolUseContext): Promise<PermissionResult> {
    if (input.action === 'download') {
      return {
        behavior: 'ask',
        message: 'This will download a model file from CivitAI into your ComfyUI installation. Continue?',
        suggestions: ['Allow download', 'Deny'],
      }
    }
    return { behavior: 'allow', decisionReason: 'CivitAI read-only operation' }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'get', 'list_files', 'download', 'tags', 'enums'],
          description: 'Operation to perform on CivitAI',
        },
        query: {
          type: 'string',
          description: 'Full-text search term (uses Meilisearch). Requires cursor-based pagination.',
        },
        model_id: {
          type: 'number',
          description: 'CivitAI model id (used by action=get)',
        },
        model_version_id: {
          type: 'number',
          description: 'CivitAI model version id (used by action=list_files and action=download)',
        },
        filename: {
          type: 'string',
          description: 'Specific filename within the model version to download. If omitted, downloads the primary file.',
        },
        target_folder: {
          type: 'string',
          description: 'Override ComfyUI models subfolder. If omitted, auto-inferred from ModelType/ModelFileType.',
        },
        types: {
          type: 'string',
          description: 'Filter by ModelType. Comma-separated. Common: Checkpoint, LORA, VAE, Controlnet, Upscaler, TextualInversion. Use action=enums to list all.',
        },
        base_models: {
          type: 'string',
          description: 'Filter by base model (e.g. "SDXL 1.0", "Flux.1 D", "Illustrious", "Pony", "Wan Video 2.2 T2V-A14B"). Comma-separated.',
        },
        sort: {
          type: 'string',
          enum: ['Highest Rated', 'Most Downloaded', 'Newest', 'Most Liked', 'Most Discussed', 'Most Collect'],
          description: 'Sort order for search results',
        },
        nsfw: {
          type: 'boolean',
          description: 'Include mature content. Default false. Ignored in SFW-gated regions.',
        },
        limit: {
          type: 'number',
          description: 'Items per page (1-100, default 20).',
        },
        cursor: {
          type: 'string',
          description: 'Opaque pagination cursor from previous response.',
        },
        supports_generation: {
          type: 'boolean',
          description: 'Only return models supported by on-site generation.',
        },
        page: {
          type: 'number',
          description: '1-indexed page number. Incompatible with query (full-text search).',
        },
        tag_query: {
          type: 'string',
          description: 'Full-text search on tag name (used by action=tags).',
        },
      },
      required: ['action'],
    }
  }

  async call(
    input: {
      action: 'search' | 'get' | 'list_files' | 'download' | 'tags' | 'enums'
      query?: string
      model_id?: number
      model_version_id?: number
      filename?: string
      target_folder?: string
      types?: string
      base_models?: string
      sort?: 'Highest Rated' | 'Most Downloaded' | 'Newest' | 'Most Liked' | 'Most Discussed' | 'Most Collect'
      nsfw?: boolean
      limit?: number
      cursor?: string
      supports_generation?: boolean
      page?: number
      tag_query?: string
    },
    _context: ToolUseContext,
  ): Promise<string> {
    try {
      switch (input.action) {
        case 'search':
          return await this.search(input)
        case 'get':
          return await this.get(input.model_id!)
        case 'list_files':
          return await this.listFiles(input.model_version_id!)
        case 'download':
          return await this.download(input.model_version_id!, input.filename, input.target_folder)
        case 'tags':
          return await this.tags(input.tag_query, input.limit, input.page)
        case 'enums':
          return await this.enums()
        default:
          return `Error: unsupported action ${input.action}`
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `CivitAI tool failed: ${msg}`
    }
  }

  private async search(input: {
    query?: string
    types?: string
    base_models?: string
    sort?: 'Highest Rated' | 'Most Downloaded' | 'Newest' | 'Most Liked' | 'Most Discussed' | 'Most Collect'
    nsfw?: boolean
    limit?: number
    cursor?: string
    supports_generation?: boolean
    page?: number
  }): Promise<string> {
    const params: Record<string, string | number | boolean | undefined> = {
      limit: input.limit ?? 20,
      query: input.query,
      types: input.types,
      baseModels: input.base_models,
      sort: input.sort,
      nsfw: input.nsfw,
      supportsGeneration: input.supports_generation,
      cursor: input.cursor,
      page: input.page,
    }
    const data = await civitaiFetch('/models', params)
    const items: any[] = data.items || []
    const md = data.metadata || {}
    const lines: string[] = []
    lines.push(`# CivitAI Search Results (${items.length} of this page)`)
    if (md.nextCursor) lines.push(`nextCursor: ${md.nextCursor}`)
    if (md.currentPage) lines.push(`page: ${md.currentPage}/${md.totalPages ?? '?'}`)
    lines.push('')
    for (const m of items) {
      lines.push(summarizeModel(m))
      lines.push('')
    }
    return lines.join('\n')
  }

  private async get(modelId: number): Promise<string> {
    const m = await civitaiFetch(`/models/${modelId}`)
    const lines: string[] = []
    lines.push(`# ${m.name}  (#${m.id})`)
    lines.push(`Type: ${m.type}`)
    lines.push(`Creator: ${m.creator?.username || 'n/a'}`)
    if (m.description) {
      // strip HTML for brevity
      const text = String(m.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      lines.push('')
      lines.push(text.slice(0, 600) + (text.length > 600 ? '...' : ''))
    }
    if (Array.isArray(m.tags) && m.tags.length) {
      lines.push('')
      lines.push(`Tags: ${m.tags.join(', ')}`)
    }
    if (m.stats) {
      lines.push(`Downloads: ${(m.stats.downloadCount || 0).toLocaleString()}, Likes: ${(m.stats.thumbsUpCount || 0).toLocaleString()}`)
    }
    if (Array.isArray(m.modelVersions) && m.modelVersions.length) {
      lines.push('')
      lines.push('## Versions')
      for (const v of m.modelVersions) {
        lines.push(`- v${v.id} ${v.name}  baseModel=${v.baseModel || 'n/a'}  files=${(v.files || []).length}`)
        for (const f of v.files || []) {
          lines.push(`    - ${f.name}  type=${f.type}  size=${formatSize(f.sizeKB)}  primary=${!!f.primary}`)
        }
      }
    }
    return lines.join('\n')
  }

  private async listFiles(modelVersionId: number): Promise<string> {
    const v = await civitaiFetch(`/model-versions/${modelVersionId}`)
    const lines: string[] = []
    lines.push(`# Model Version ${v.id} (${v.name})`)
    lines.push(`Model: ${v.model?.name || ''} [${v.model?.type || ''}]  baseModel: ${v.baseModel || 'n/a'}`)
    lines.push(`downloadUrl: ${v.downloadUrl || 'n/a'}`)
    lines.push('')
    lines.push('## Files')
    for (const f of v.files || []) {
      lines.push(`- file#${f.id}  ${f.name}`)
      lines.push(`    type: ${f.type}  primary: ${!!f.primary}  size: ${formatSize(f.sizeKB)}`)
      if (f.hashes) {
        const h = Object.entries(f.hashes).map(([k, v]) => `${k}=${v}`).join(', ')
        if (h) lines.push(`    hashes: ${h}`)
      }
      lines.push(`    downloadUrl: ${f.downloadUrl || v.downloadUrl}`)
      if (f.metadata) {
        const md = Object.entries(f.metadata).map(([k, v]) => `${k}=${v}`).join(', ')
        if (md) lines.push(`    metadata: ${md}`)
      }
    }
    return lines.join('\n')
  }

  private async download(modelVersionId: number, filename?: string, targetFolder?: string): Promise<string> {
    const { execSync } = await import('child_process')
    const path = await import('path')
    const fs = await import('fs')

    const v = await civitaiFetch(`/model-versions/${modelVersionId}`)
    const files: any[] = v.files || []
    if (!files.length) {
      return `Error: model version ${modelVersionId} has no files`
    }

    let targetFile: any
    if (filename) {
      targetFile = files.find(f => f.name === filename)
      if (!targetFile) {
        return `Error: filename "${filename}" not found in version ${modelVersionId}. Available: ${files.map(f => f.name).join(', ')}`
      }
    } else {
      targetFile = files.find(f => f.primary) || files[0]
    }

    const downloadUrl: string = targetFile.downloadUrl || v.downloadUrl
    if (!downloadUrl) {
      return `Error: no downloadUrl for file ${targetFile.name} in version ${modelVersionId}`
    }

    const folder = targetFolder || inferTargetFolder(v.model?.type || 'Other', targetFile.type)
    const comfyuiBaseDir = findComfyUIBaseDir()
    if (!comfyuiBaseDir) {
      return `Error: Could not locate ComfyUI installation directory. Set COMFYUI_BASE_DIR env var.\n\nSearched from: ${process.cwd()}`
    }

    const modelsDir = path.join(comfyuiBaseDir, 'models', folder)
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true })
    }

    const outputPath = path.join(modelsDir, targetFile.name)

    // CivitAI 下载通常需要带 token 才能拿到文件
    const apiKey = getApiKey()
    const downloadCmd = apiKey
      ? `curl -L -H "Authorization: Bearer ${apiKey}" -o "${outputPath}" "${downloadUrl}"`
      : `curl -L -o "${outputPath}" "${downloadUrl}"`

    try {
      execSync(downloadCmd, {
        timeout: parseInt(process.env.CIVITAI_DOWNLOAD_TIMEOUT ?? '1800000', 10),
        maxBuffer: parseInt(process.env.CIVITAI_MAX_BUFFER ?? String(10 * 1024 * 1024), 10),
        encoding: 'utf-8',
        shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Failed to download "${targetFile.name}".\n\nCivitAI version: ${modelVersionId}\nTarget folder: ${folder}\nFull path: ${outputPath}\nComfyUI base: ${comfyuiBaseDir}\n\nError: ${msg.slice(0, 500)}\n\nPlease download manually:\n${downloadUrl}\nAnd place the file in: ${modelsDir}`
    }

    return `Model downloaded from CivitAI successfully!\n\nModel: ${v.model?.name || ''} (${v.model?.type})\nVersion: ${v.name} (#${v.id}) baseModel: ${v.baseModel || 'n/a'}\nFile: ${targetFile.name} (${formatSize(targetFile.sizeKB)})\nTarget folder: ${folder}\nFull path: ${outputPath}\nComfyUI base: ${comfyuiBaseDir}\n\nNote: restart ComfyUI to pick up the new model.`
  }

  private async tags(tagQuery?: string, limit?: number, page?: number): Promise<string> {
    const data = await civitaiFetch('/tags', {
      limit: limit ?? 50,
      query: tagQuery,
      page,
    })
    const items: any[] = data.items || []
    const lines: string[] = []
    lines.push(`# CivitAI Tags (${items.length})`)
    for (const t of items) {
      lines.push(`- ${t.name}  ${t.link || ''}`)
    }
    return lines.join('\n')
  }

  private async enums(): Promise<string> {
    const data = await civitaiFetch('/enums')
    const lines: string[] = []
    lines.push('# CivitAI Enums')
    for (const [k, v] of Object.entries(data)) {
      lines.push('')
      lines.push(`## ${k}`)
      lines.push((v as string[]).join(', '))
    }
    lines.push('')
    lines.push('Use ModelType values for types= filter and BaseModel values for baseModels= filter.')
    return lines.join('\n')
  }
}
