import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult, type PermissionResult } from '../base.js'
import { isSensitivePath } from './sensitive-paths.js'

export class NotebookEditTool extends BaseTool<{
  notebook_path: string
  cell_number: number
  new_source: string
  cell_type?: 'code' | 'markdown'
  operation?: 'replace' | 'insert' | 'delete'
}, string> {
  name = 'NotebookEdit'
  description = 'Edit Jupyter notebook cells. Can replace, insert, or delete cells in .ipynb files.'
  searchHint = 'jupyter notebook cell edit ipynb'

  isReadOnly(): boolean {
    return false
  }

  isConcurrencySafe(): boolean {
    return false
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const path = (input as { notebook_path?: string }).notebook_path
    if (!path || typeof path !== 'string') return { success: false, error: 'notebook_path is required' }
    const cellNumber = (input as { cell_number?: number }).cell_number
    if (typeof cellNumber !== 'number' || cellNumber < 0) return { success: false, error: 'cell_number must be a non-negative number' }
    const operation = (input as { operation?: string }).operation
    if (operation && !['replace', 'insert', 'delete'].includes(operation)) {
      return { success: false, error: 'operation must be replace, insert, or delete' }
    }
    return { success: true }
  }

  async checkPermissions(input: { notebook_path: string }, _context: ToolUseContext): Promise<PermissionResult> {
    const sensitive = isSensitivePath(input.notebook_path)
    if (sensitive) {
      return {
        behavior: 'ask',
        message: `Editing notebook in sensitive path: ${input.notebook_path}. Reason: ${sensitive.reason}. Please confirm.`,
        suggestions: ['Allow once', 'Deny'],
      }
    }
    return {
      behavior: 'ask',
      message: `Notebook edit requires approval: ${input.notebook_path}`,
      suggestions: ['Allow once', 'Deny'],
    }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'Path to the Jupyter notebook file' },
        cell_number: { type: 'number', description: 'The cell number to edit (0-indexed)' },
        new_source: { type: 'string', description: 'The new source content for the cell' },
        cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Type of cell to insert' },
        operation: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Operation to perform (default: replace)' },
      },
      required: ['notebook_path', 'cell_number', 'new_source'],
    }
  }

  async call(input: { notebook_path: string; cell_number: number; new_source: string; cell_type?: 'code' | 'markdown'; operation?: 'replace' | 'insert' | 'delete' }, _context: ToolUseContext): Promise<string> {
    const { readFile, writeFile } = await import('fs/promises')
    const { existsSync } = await import('fs')

    if (!existsSync(input.notebook_path)) {
      return `Notebook not found: ${input.notebook_path}`
    }

    try {
      const content = await readFile(input.notebook_path, 'utf-8')
      const notebook = JSON.parse(content) as { cells: Array<{ cell_type: string; source: string[] | string; metadata?: Record<string, unknown>; outputs?: unknown[]; execution_count?: number | null }> }

      if (!notebook.cells || !Array.isArray(notebook.cells)) {
        return 'Invalid notebook format: no cells array found'
      }

      const operation = input.operation ?? 'replace'

      if (operation === 'delete') {
        if (input.cell_number >= notebook.cells.length) {
          return `Cell number ${input.cell_number} out of range (notebook has ${notebook.cells.length} cells)`
        }
        notebook.cells.splice(input.cell_number, 1)
      } else if (operation === 'insert') {
        const newCell = {
          cell_type: input.cell_type ?? 'code',
          source: input.new_source.split('\n').map((line, i, arr) => i < arr.length - 1 ? line + '\n' : line),
          metadata: {},
          ...(input.cell_type === 'code' || !input.cell_type ? { outputs: [], execution_count: null } : {}),
        }
        notebook.cells.splice(input.cell_number, 0, newCell)
      } else {
        if (input.cell_number >= notebook.cells.length) {
          return `Cell number ${input.cell_number} out of range (notebook has ${notebook.cells.length} cells)`
        }
        const cell = notebook.cells[input.cell_number]!
        cell.source = input.new_source.split('\n').map((line, i, arr) => i < arr.length - 1 ? line + '\n' : line)
        if (input.cell_type) cell.cell_type = input.cell_type
        if (input.cell_type === 'code' || (!input.cell_type && cell.cell_type === 'code')) {
          cell.outputs = []
          cell.execution_count = null
        }
      }

      await writeFile(input.notebook_path, JSON.stringify(notebook, null, 1), 'utf-8')
      return `Successfully ${operation}d cell ${input.cell_number} in ${input.notebook_path}`
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return `Failed to edit notebook: ${msg}`
    }
  }
}
