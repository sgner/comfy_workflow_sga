import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'

export class BashTool extends BaseTool<{ command: string; timeout?: number }, string> {
  name = 'Bash'
  description = 'Execute a bash command and return its output'
  searchHint = 'shell command execute run'

  isReadOnly(input: { command: string }): boolean {
    const readOnlyPatterns = /^(ls|cat|head|tail|grep|find|pwd|echo|which|type|stat|wc|sort|uniq|diff|git status|git log|git diff|git branch)/i
    return readOnlyPatterns.test(input.command.trim())
  }

  isConcurrencySafe(input: { command: string }): boolean {
    return this.isReadOnly(input)
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const cmd = (input as { command?: string }).command
    if (!cmd || typeof cmd !== 'string') return { success: false, error: 'command is required and must be a string' }
    return { success: true }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000)' },
      },
      required: ['command'],
    }
  }

  async call(input: { command: string; timeout?: number }, _context: ToolUseContext): Promise<string> {
    const { execSync } = await import('child_process')
    const timeout = input.timeout ?? 120000
    try {
      const result = execSync(input.command, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf-8',
        shell: '/bin/bash',
      })
      return result
    } catch (error: unknown) {
      const e = error as { stdout?: string; stderr?: string; message?: string }
      const output = (e.stdout ?? '') + (e.stderr ?? '')
      if (output) return output
      throw error
    }
  }
}
