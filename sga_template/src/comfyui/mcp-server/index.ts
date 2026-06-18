import { createServer } from 'http'
import { readdir as readdirCb, stat as statCb, readFile as readFileCb, existsSync } from 'fs'
import { readdir, stat, readFile } from 'fs/promises'
import { join, extname } from 'path'
import type { ServerResponse } from 'http'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('comfyui-mcp-server')

const COMFYUI_API_HOST = process.env.COMFYUI_HOST ?? '127.0.0.1'
const COMFYUI_API_PORT = parseInt(process.env.COMFYUI_PORT ?? '8188', 10)

const MODEL_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.bin', '.pth', '.onnx'])

const MODEL_SUBDIRS = [
  'checkpoints',
  'loras',
  'vae',
  'controlnet',
  'upscale_models',
  'embeddings',
  'clip',
  'unet',
  'diffusion_models',
  'style_models',
  'hypernetworks',
  'gligen',
  'ipadapter',
]

interface MCPToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface JSONRPCRequest {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

interface JSONRPCResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const TOOLS: MCPToolDef[] = [
  {
    name: 'comfyui_list_models',
    description: 'List available ComfyUI models by type (checkpoints, loras, vae, controlnet, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        model_type: {
          type: 'string',
          description: 'Model type filter (checkpoints, loras, vae, controlnet, upscale_models, embeddings, etc.)',
        },
        search: {
          type: 'string',
          description: 'Search pattern to filter model names',
        },
      },
    },
  },
  {
    name: 'comfyui_queue_prompt',
    description: 'Submit a workflow JSON to the ComfyUI queue for execution',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: {
          type: 'object',
          description: 'The complete ComfyUI workflow JSON to execute',
        },
      },
      required: ['workflow'],
    },
  },
  {
    name: 'comfyui_get_queue',
    description: 'Get the current ComfyUI execution queue status',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'comfyui_get_history',
    description: 'Get execution history for completed prompts',
    inputSchema: {
      type: 'object',
      properties: {
        prompt_id: {
          type: 'string',
          description: 'Specific prompt ID to get history for. If omitted, returns recent history.',
        },
        max_items: {
          type: 'number',
          description: 'Maximum number of history items to return (default: 10)',
        },
      },
    },
  },
  {
    name: 'comfyui_interrupt',
    description: 'Interrupt the current running prompt execution',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'comfyui_get_system_stats',
    description: 'Get ComfyUI system statistics including VRAM usage and device info',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'comfyui_list_nodes',
    description: 'List available ComfyUI node types from the API',
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Search pattern to filter node names',
        },
      },
    },
  },
]

async function comfyuiApiRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const options = {
      hostname: COMFYUI_API_HOST,
      port: COMFYUI_API_PORT,
      path,
      method,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
    }

    const req = createRequest(options, (res) => {
      let chunks = ''
      res.on('data', (chunk: Buffer) => { chunks += chunk.toString() })
      res.on('end', () => {
        try {
          resolve(JSON.parse(chunks))
        } catch {
          resolve(chunks)
        }
      })
    })

    req.on('error', reject)
    req.setTimeout(30000, () => {
      req.destroy()
      reject(new Error('ComfyUI API request timed out'))
    })

    if (data) req.write(data)
    req.end()
  })
}

function createRequest(
  options: import('http').RequestOptions,
  callback: (res: import('http').IncomingMessage) => void,
) {
  return createServer === undefined
    ? require('http').request(options, callback)
    : require('http').request(options, callback)
}

async function handleListModels(params: Record<string, unknown>): Promise<unknown> {
  const modelType = params.model_type as string | undefined
  const search = params.search as string | undefined

  const comfyuiBase = process.env.COMFYUI_BASE_PATH ?? findComfyUIBasePath()
  if (!comfyuiBase) {
    return {
      content: [{ type: 'text' as const, text: 'Could not locate ComfyUI models directory. Set COMFYUI_BASE_PATH environment variable.' }],
    }
  }

  const modelsDir = join(comfyuiBase, 'models')
  const dirsToScan = modelType ? [modelType] : MODEL_SUBDIRS
  const result: Record<string, string[]> = {}

  for (const dir of dirsToScan) {
    const dirPath = join(modelsDir, dir)
    if (!existsSync(dirPath)) continue

    try {
      const files = await scanModelDir(dirPath)
      const filtered = search
        ? files.filter(f => f.toLowerCase().includes(search.toLowerCase()))
        : files
      if (filtered.length > 0) {
        result[dir] = filtered
      }
    } catch {
      // skip unreadable directories
    }
  }

  const text = Object.entries(result)
    .map(([type, files]) => `${type}:\n${files.map(f => `  - ${f}`).join('\n')}`)
    .join('\n\n')

  return {
    content: [{ type: 'text' as const, text: text || 'No models found' }],
  }
}

async function scanModelDir(dirPath: string): Promise<string[]> {
  const results: string[] = []

  async function walk(currentPath: string, relativeTo: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name)
      const relPath = join(relativeTo, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath, relPath)
      } else if (entry.isFile() && MODEL_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        results.push(relPath)
      }
    }
  }

  await walk(dirPath, '')
  return results.sort()
}

function findComfyUIBasePath(): string | null {
  const candidates = [
    process.env.COMFYUI_BASE_PATH,
    join(process.cwd(), '..'),
  ]

  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, 'models'))) {
      return candidate
    }
  }

  return null
}

async function handleQueuePrompt(params: Record<string, unknown>): Promise<unknown> {
  const workflow = params.workflow
  if (!workflow) {
    return { content: [{ type: 'text' as const, text: 'Error: workflow parameter is required' }] }
  }

  try {
    const result = await comfyuiApiRequest('POST', '/prompt', { prompt: workflow })
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error submitting prompt: ${e instanceof Error ? e.message : String(e)}` }] }
  }
}

async function handleGetQueue(): Promise<unknown> {
  try {
    const result = await comfyuiApiRequest('GET', '/queue')
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error getting queue: ${e instanceof Error ? e.message : String(e)}` }] }
  }
}

async function handleGetHistory(params: Record<string, unknown>): Promise<unknown> {
  const promptId = params.prompt_id as string | undefined
  const maxItems = (params.max_items as number) ?? 10

  try {
    const path = promptId ? `/history/${promptId}` : '/history'
    const result = await comfyuiApiRequest('GET', path)

    if (typeof result === 'object' && result !== null && !promptId) {
      const entries = Object.entries(result as Record<string, unknown>)
        .sort((a, b) => {
          const aNum = parseInt(a[0], 10)
          const bNum = parseInt(b[0], 10)
          return bNum - aNum
        })
        .slice(0, maxItems)
      return { content: [{ type: 'text' as const, text: JSON.stringify(Object.fromEntries(entries), null, 2) }] }
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error getting history: ${e instanceof Error ? e.message : String(e)}` }] }
  }
}

async function handleInterrupt(): Promise<unknown> {
  try {
    const result = await comfyuiApiRequest('POST', '/interrupt')
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) || 'Interrupt sent' }] }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error interrupting: ${e instanceof Error ? e.message : String(e)}` }] }
  }
}

async function handleGetSystemStats(): Promise<unknown> {
  try {
    const result = await comfyuiApiRequest('GET', '/system_stats')
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error getting system stats: ${e instanceof Error ? e.message : String(e)}` }] }
  }
}

async function handleListNodes(params: Record<string, unknown>): Promise<unknown> {
  const search = params.search as string | undefined

  try {
    const result = await comfyuiApiRequest('GET', '/object_info') as Record<string, unknown>
    let nodeNames = Object.keys(result)

    if (search) {
      const searchLower = search.toLowerCase()
      nodeNames = nodeNames.filter(n => n.toLowerCase().includes(searchLower))
    }

    if (nodeNames.length > 100) {
      return {
        content: [{
          type: 'text' as const,
          text: `Found ${nodeNames.length} nodes. Showing first 100:\n${nodeNames.slice(0, 100).join('\n')}`,
        }],
      }
    }

    return { content: [{ type: 'text' as const, text: `Found ${nodeNames.length} nodes:\n${nodeNames.join('\n')}` }] }
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Error listing nodes: ${e instanceof Error ? e.message : String(e)}` }] }
  }
}

const TOOL_HANDLERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  comfyui_list_models: handleListModels,
  comfyui_queue_prompt: handleQueuePrompt,
  comfyui_get_queue: handleGetQueue,
  comfyui_get_history: handleGetHistory,
  comfyui_interrupt: handleInterrupt,
  comfyui_get_system_stats: handleGetSystemStats,
  comfyui_list_nodes: handleListNodes,
}

function makeResponse(id: number | string | null, result?: unknown, error?: { code: number; message: string }): JSONRPCResponse {
  const resp: JSONRPCResponse = { jsonrpc: '2.0', id }
  if (error) resp.error = error
  else resp.result = result
  return resp
}

async function handleMessage(msg: JSONRPCRequest): Promise<JSONRPCResponse> {
  const id = msg.id ?? null

  switch (msg.method) {
    case 'initialize':
      return makeResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'comfyui-mcp-server', version: '1.0.0' },
      })

    case 'notifications/initialized':
      return makeResponse(id, {})

    case 'tools/list':
      return makeResponse(id, { tools: TOOLS })

    case 'tools/call': {
      const toolName = msg.params?.name as string
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>

      const handler = TOOL_HANDLERS[toolName]
      if (!handler) {
        return makeResponse(id, undefined, { code: -32601, message: `Unknown tool: ${toolName}` })
      }

      try {
        const result = await handler(args)
        return makeResponse(id, result)
      } catch (e) {
        return makeResponse(id, undefined, { code: -32000, message: e instanceof Error ? e.message : String(e) })
      }
    }

    case 'ping':
      return makeResponse(id, {})

    default:
      return makeResponse(id, undefined, { code: -32601, message: `Method not found: ${msg.method}` })
  }
}

export async function runComfyUIMCPServer(): Promise<void> {
  const { createInterface } = await import('readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })

  rl.on('line', async (line: string) => {
    try {
      const msg = JSON.parse(line.trim()) as JSONRPCRequest
      const response = await handleMessage(msg)
      process.stdout.write(JSON.stringify(response) + '\n')
    } catch (e) {
      const errorResp = makeResponse(null, undefined, {
        code: -32700,
        message: `Parse error: ${e instanceof Error ? e.message : String(e)}`,
      })
      process.stdout.write(JSON.stringify(errorResp) + '\n')
    }
  })

  rl.on('close', () => {
    process.exit(0)
  })

  logger.info('ComfyUI MCP Server started (stdio transport)')
}

export { TOOLS as COMFYUI_MCP_TOOLS }
