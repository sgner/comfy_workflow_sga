import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'

export class GlobTool extends BaseTool<{ pattern: string; path?: string }, string> {
  name = 'Glob'
  description = 'Find files matching a glob pattern'
  searchHint = 'find files glob pattern match'

  isReadOnly(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const pattern = (input as { pattern?: string }).pattern
    if (!pattern || typeof pattern !== 'string') return { success: false, error: 'pattern is required' }
    return { success: true }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern to match files against' },
        path: { type: 'string', description: 'The directory to search in' },
      },
      required: ['pattern'],
    }
  }

  async call(input: { pattern: string; path?: string }, _context: ToolUseContext): Promise<string> {
    const { execSync } = await import('child_process')
    const searchPath = input.path ?? '.'
    const cmd = `find '${searchPath}' -name '${input.pattern}' -type f`
    try {
      return execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
    } catch {
      return 'No files found'
    }
  }
}
