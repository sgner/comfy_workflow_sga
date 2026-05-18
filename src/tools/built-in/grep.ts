import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'

export class GrepTool extends BaseTool<{ pattern: string; path?: string; glob?: string; output_mode?: string }, string> {
  name = 'Grep'
  description = 'Search file contents using regex patterns'
  searchHint = 'search grep find regex'

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
        pattern: { type: 'string', description: 'The regex pattern to search for' },
        path: { type: 'string', description: 'Directory to search in' },
        glob: { type: 'string', description: 'Glob pattern to filter files' },
        output_mode: { type: 'string', description: 'Output mode: content, files_with_matches, count' },
      },
      required: ['pattern'],
    }
  }

  async call(input: { pattern: string; path?: string; glob?: string; output_mode?: string }, _context: ToolUseContext): Promise<string> {
    const { execSync } = await import('child_process')
    const searchPath = input.path ?? '.'
    const globFlag = input.glob ? ` --glob '${input.glob}'` : ''
    const outputMode = input.output_mode ?? 'content'
    const modeFlag = outputMode === 'files_with_matches' ? ' -l' : outputMode === 'count' ? ' -c' : ' -n'
    const cmd = `rg${modeFlag}${globFlag} '${input.pattern.replace(/'/g, "'\\''")}' '${searchPath}'`
    try {
      return execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
    } catch (error: unknown) {
      const e = error as { stdout?: string; status?: number }
      if (e.status === 1 && e.stdout) return e.stdout
      if (e.status === 1) return 'No matches found'
      throw error
    }
  }
}
