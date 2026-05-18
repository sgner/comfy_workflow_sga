import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'

export class FileWriteTool extends BaseTool<{ path: string; content: string }, string> {
  name = 'Write'
  description = 'Write content to a file, creating or overwriting it'
  searchHint = 'file write create save'

  isReadOnly(): boolean {
    return false
  }

  isDestructive(): boolean {
    return true
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const { path, content } = input as { path?: string; content?: string }
    if (!path || typeof path !== 'string') return { success: false, error: 'path is required' }
    if (content === undefined || content === null) return { success: false, error: 'content is required' }
    return { success: true }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to write to' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['path', 'content'],
    }
  }

  async call(input: { path: string; content: string }, _context: ToolUseContext): Promise<string> {
    const fs = await import('fs/promises')
    const path = await import('path')
    const absolutePath = path.isAbsolute(input.path) ? input.path : path.resolve(process.cwd(), input.path)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, input.content, 'utf-8')
    return `Successfully wrote to ${input.path}`
  }
}
