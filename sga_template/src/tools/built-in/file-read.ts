import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'
import { readFile, stat } from 'fs/promises'
import { isAbsolute, resolve } from 'path'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'

const MAX_LINE_LENGTH = 2000
const MAX_TOTAL_LINES = 2000

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line
  return line.slice(0, MAX_LINE_LENGTH) + '... [truncated]'
}

export class FileReadTool extends BaseTool<{ path: string; offset?: number; limit?: number }, string> {
  name = 'Read'
  description = 'Read a file from the local filesystem. You can access any file directly by using this tool. By default, it reads up to 2000 lines starting from the beginning of the file. The limit parameter is REQUIRED and must be a positive integer. You can optionally specify a line offset.'
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
        offset: { type: 'number', description: 'Line offset to start reading from (1-based, default: 1)' },
        limit: { type: 'number', description: 'Number of lines to read (default: 2000, max: 2000)' },
      },
      required: ['path'],
    }
  }

  async call(input: { path: string; offset?: number; limit?: number }, _context: ToolUseContext): Promise<string> {
    const absolutePath = isAbsolute(input.path) ? input.path : resolve(process.cwd(), input.path)

    let fileStat
    try {
      fileStat = await stat(absolutePath)
    } catch (error: unknown) {
      const e = error as { code?: string; message?: string }
      if (e.code === 'ENOENT') {
        return `Error: File not found: ${absolutePath}`
      }
      if (e.code === 'EACCES') {
        return `Error: Permission denied: ${absolutePath}`
      }
      return `Error: Cannot access file: ${e.message ?? String(error)}`
    }

    if (fileStat.isDirectory()) {
      return `Error: Path is a directory, not a file: ${absolutePath}`
    }

    if (fileStat.size === 0) {
      return `File is empty: ${absolutePath}`
    }

    const offset = Math.max(1, input.offset ?? 1)
    const limit = Math.min(MAX_TOTAL_LINES, input.limit ?? MAX_TOTAL_LINES)

    try {
      const content = await readFileWithFallback(absolutePath)
      const lines = content.split('\n')
      const selected = lines.slice(offset - 1, offset - 1 + limit)
      const result = selected
        .map((line, i) => `${offset + i}\t${truncateLine(line)}`)
        .join('\n')

      if (offset + limit - 1 < lines.length) {
        return result + `\n... [showing lines ${offset}-${offset + selected.length - 1} of ${lines.length} total lines]`
      }
      return result
    } catch (error: unknown) {
      const e = error as { message?: string }
      return `Error reading file: ${e.message ?? String(error)}`
    }
  }
}

async function readFileWithFallback(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch (error: unknown) {
    const e = error as { code?: string }
    if (e.code === 'ERR_BUFFER_OUT_OF_BOUNDS' || String(error).includes('encoding')) {
      const { execSync } = await import('child_process')
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
      let cmd: string
      if (process.platform === 'win32') {
        cmd = `Get-Content -Path '${filePath}' -Encoding UTF8 -Raw`
      } else {
        cmd = `cat '${filePath}'`
      }
      return execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, shell }) as string
    }
    throw error
  }
}
