import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult, type PermissionResult } from '../base.js'
import { isSensitivePath } from './sensitive-paths.js'

export class FileEditTool extends BaseTool<{ path: string; old_str: string; new_str: string }, string> {
  name = 'Edit'
  description = 'Edit a file by replacing a specific string with a new string'
  searchHint = 'file edit replace modify'

  isReadOnly(): boolean {
    return false
  }

  isDestructive(): boolean {
    return true
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const { path, old_str, new_str } = input as { path?: string; old_str?: string; new_str?: string }
    if (!path || typeof path !== 'string') return { success: false, error: 'path is required' }
    if (!old_str || typeof old_str !== 'string') return { success: false, error: 'old_str is required' }
    if (new_str === undefined || new_str === null) return { success: false, error: 'new_str is required' }
    if (old_str === new_str) return { success: false, error: 'old_str and new_str must be different' }
    return { success: true }
  }

  async checkPermissions(input: { path: string }, _context: ToolUseContext): Promise<PermissionResult> {
    const sensitive = isSensitivePath(input.path)
    if (sensitive) {
      return {
        behavior: 'ask',
        message: `Editing a sensitive file: ${input.path}. Reason: ${sensitive.reason}. Please confirm.`,
        suggestions: ['Allow once', 'Deny'],
      }
    }
    return {
      behavior: 'ask',
      message: `File edit requires approval: ${input.path}`,
      suggestions: ['Allow once', 'Always allow edits to this file', 'Deny'],
    }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file to edit' },
        old_str: { type: 'string', description: 'The text to replace' },
        new_str: { type: 'string', description: 'The text to replace it with' },
      },
      required: ['path', 'old_str', 'new_str'],
    }
  }

  async call(input: { path: string; old_str: string; new_str: string }, _context: ToolUseContext): Promise<string> {
    const fs = await import('fs/promises')
    const path = await import('path')
    const absolutePath = path.isAbsolute(input.path) ? input.path : path.resolve(process.cwd(), input.path)
    const content = await fs.readFile(absolutePath, 'utf-8')
    const index = content.indexOf(input.old_str)
    if (index === -1) {
      throw new Error(`old_str not found in ${input.path}`)
    }
    const count = content.split(input.old_str).length - 1
    if (count > 1) {
      throw new Error(`old_str found ${count} times in ${input.path}, expected exactly 1 occurrence`)
    }
    const newContent = content.slice(0, index) + input.new_str + content.slice(index + input.old_str.length)
    await fs.writeFile(absolutePath, newContent, 'utf-8')
    return `Successfully edited ${input.path}`
  }
}
