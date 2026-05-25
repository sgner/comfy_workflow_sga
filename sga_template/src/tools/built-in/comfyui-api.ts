import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('comfyui-api')

function getComfyUIApiBaseUrl(): string {
  const host = process.env.COMFYUI_API_HOST ?? '127.0.0.1'
  const port = process.env.COMFYUI_API_PORT ?? '8188'
  return `http://${host}:${port}`
}

const READ_ONLY_ENDPOINTS: Record<string, string[]> = {
  GET: ['/system_stats', '/object_info', '/object_info/', '/queue', '/history', '/view', '/extensions', '/userdata', '/settings'],
  POST: ['/prompt', '/interrupt', '/history', '/view_metadata'],
}

export class ComfyUIAPITool extends BaseTool<
  { endpoint: string; method?: string; body?: Record<string, unknown> },
  string
> {
  name = 'ComfyUIAPI'
  description = 'Call ComfyUI REST API endpoints. Supports read-only operations like checking system stats, viewing queue, getting node info, and viewing history. Can also submit prompts for execution.'
  searchHint = 'comfyui api rest endpoint queue history system stats prompt execute'

  isReadOnly(input: { endpoint: string; method?: string; body?: Record<string, unknown> }): boolean {
    const method = (input.method ?? 'GET').toUpperCase()
    if (method === 'GET') return true
    const endpoint = input.endpoint ?? ''
    const allowed = READ_ONLY_ENDPOINTS[method] ?? []
    return allowed.some(e => endpoint.startsWith(e))
  }

  isConcurrencySafe(): boolean {
    return false
  }

  isDestructive(): boolean {
    return false
  }

  requiresUserInteraction(): boolean {
    return false
  }

  isEnabled(): boolean {
    return true
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const endpoint = (input as { endpoint?: string }).endpoint
    if (!endpoint || typeof endpoint !== 'string') return { success: false, error: 'endpoint is required' }
    if (!endpoint.startsWith('/')) return { success: false, error: 'endpoint must start with /' }
    return { success: true }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        endpoint: {
          type: 'string',
          description: 'API endpoint path (e.g. /system_stats, /queue, /object_info/CLIPTextEncode, /history)',
        },
        method: {
          type: 'string',
          description: 'HTTP method: GET (default) or POST',
        },
        body: {
          type: 'object',
          description: 'Request body for POST requests (e.g. { "prompt": {...} } for /prompt endpoint)',
        },
      },
      required: ['endpoint'],
    }
  }

  async call(input: { endpoint: string; method?: string; body?: Record<string, unknown> }, _context: ToolUseContext): Promise<string> {
    const baseUrl = getComfyUIApiBaseUrl()
    const method = (input.method ?? 'GET').toUpperCase()
    const url = `${baseUrl}${input.endpoint}`

    try {
      const fetchOptions: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000),
      }

      if (method === 'POST' && input.body) {
        fetchOptions.body = JSON.stringify(input.body)
      }

      const response = await fetch(url, fetchOptions)

      if (!response.ok) {
        return `ComfyUI API error: ${response.status} ${response.statusText}\nEndpoint: ${method} ${input.endpoint}`
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        const data = await response.json()
        const formatted = JSON.stringify(data, null, 2)
        if (formatted.length > 10000) {
          return formatted.slice(0, 10000) + '\n... (truncated)'
        }
        return formatted
      }

      const text = await response.text()
      if (text.length > 10000) {
        return text.slice(0, 10000) + '\n... (truncated)'
      }
      return text
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        return `Failed to connect to ComfyUI API at ${baseUrl}.\nMake sure ComfyUI is running and the API is accessible.\nError: ${error.message}`
      }
      return `ComfyUI API call failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
