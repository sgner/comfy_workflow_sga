import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'

export class FileReadTool extends BaseTool<{ path: string; offset?: number; limit?: number }, string> {
  name = 'Read'
  description = 'Read a file from the local filesystem'
  searchHint = 'file read cat'

  isReadOnly(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const path = (input as { path?: string }).path
    if (!path || typeof path !== 'string') return { success: false, error: 'path is required and must be a string' }
    return { success: true }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file to read' },
        offset: { type: 'number', description: 'Line offset to start reading from' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['path'],
    }
  }

  async call(input: { path: string; offset?: number; limit?: number }, _context: ToolUseContext): Promise<string> {
    const fs = await import('fs/promises')
    const path = await import('path')
    const absolutePath = path.isAbsolute(input.path) ? input.path : path.resolve(process.cwd(), input.path)
    const content = await fs.readFile(absolutePath, 'utf-8')
    const lines = content.split('\n')
    const offset = input.offset ?? 1
    const limit = input.limit ?? lines.length
    const selected = lines.slice(offset - 1, offset - 1 + limit)
    return selected.map((line, i) => `${offset + i}\t${line}`).join('\n')
  }
}
