import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'
import { readdir, stat, readFile } from 'fs/promises'
import { join, resolve } from 'path'

interface GrepMatch {
  file: string
  line: number
  text: string
}

async function walkDir(dir: string, results: string[], maxFiles: number): Promise<void> {
  if (results.length >= maxFiles) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (results.length >= maxFiles) return
    const fullPath = join(dir, entry.name)
    if (entry.name.startsWith('.') && entry.name !== '.claude' && entry.name !== '.env') continue
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' ||
          entry.name === '.vs' || entry.name === 'bin' || entry.name === 'obj' ||
          entry.name === '__pycache__' || entry.name === '.next' || entry.name === '.nuxt') continue
      await walkDir(fullPath, results, maxFiles)
    } else if (entry.isFile()) {
      results.push(fullPath)
    }
  }
}

function matchesGlob(fileName: string, globPattern: string): boolean {
  const regexStr = globPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${regexStr}$`).test(fileName)
}

export class GrepTool extends BaseTool<{ pattern: string; path?: string; glob?: string; output_mode?: string }, string> {
  name = 'Grep'
  description = 'Search file contents using regex patterns. Supports output modes: content (with line numbers), files_with_matches, count.'
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
    try {
      new RegExp(pattern)
    } catch {
      return { success: false, error: `Invalid regex pattern: ${pattern}` }
    }
    return { success: true }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regex pattern to search for' },
        path: { type: 'string', description: 'Directory to search in' },
        glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts", "*.{js,jsx}")' },
        output_mode: { type: 'string', description: 'Output mode: content (default), files_with_matches, count' },
      },
      required: ['pattern'],
    }
  }

  async call(input: { pattern: string; path?: string; glob?: string; output_mode?: string }, _context: ToolUseContext): Promise<string> {
    const searchPath = input.path ? resolve(input.path) : (process.env.COMFYUI_BASE_DIR ?? process.cwd())
    const outputMode = input.output_mode ?? 'content'
    const regex = new RegExp(input.pattern)

    const allFiles: string[] = []
    await walkDir(searchPath, allFiles, 500)

    let filesToSearch = allFiles
    if (input.glob) {
      filesToSearch = allFiles.filter(f => matchesGlob(f.replace(/\\/g, '/').split('/').pop() ?? '', input.glob!))
    }

    const matches: GrepMatch[] = []
    const fileMatchSet = new Set<string>()
    const fileCounts: Map<string, number> = new Map()

    for (const file of filesToSearch) {
      if (matches.length >= 500 && outputMode === 'content') break

      let content: string
      try {
        content = await readFile(file, 'utf-8')
        // Strip UTF-8 BOM (U+FEFF) if present
        if (content.charCodeAt(0) === 0xFEFF) {
          content = content.slice(1)
        }
      } catch {
        continue
      }

      const lines = content.split('\n')
      let fileHasMatch = false
      let fileCount = 0

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          fileHasMatch = true
          fileCount++
          if (outputMode === 'content' && matches.length < 500) {
            matches.push({
              file: file.replace(/\\/g, '/'),
              line: i + 1,
              text: lines[i].trim(),
            })
          }
        }
      }

      if (fileHasMatch) {
        fileMatchSet.add(file.replace(/\\/g, '/'))
        fileCounts.set(file.replace(/\\/g, '/'), fileCount)
      }
    }

    if (fileMatchSet.size === 0) {
      return 'No matches found'
    }

    switch (outputMode) {
      case 'files_with_matches':
        return Array.from(fileMatchSet).sort().join('\n')
      case 'count':
        return Array.from(fileCounts.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([file, count]) => `${file}:${count}`)
          .join('\n')
      case 'content':
      default:
        return matches
          .map(m => `${m.file}:${m.line}:${m.text}`)
          .join('\n')
    }
  }
}
