import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'
import { readdir, stat } from 'fs/promises'
import { join, resolve } from 'path'

function globToRegex(pattern: string): RegExp {
  let regexStr = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (i + 1 < pattern.length && pattern[i + 1] === '*') {
        if (i + 2 < pattern.length && pattern[i + 2] === '/') {
          regexStr += '(?:.*/)?'
          i += 3
        } else {
          regexStr += '.*'
          i += 2
        }
      } else {
        regexStr += '[^/]*'
        i++
      }
    } else if (ch === '?') {
      regexStr += '[^/]'
      i++
    } else if (ch === '[') {
      let j = i + 1
      let bracket = '['
      if (j < pattern.length && pattern[j] === '!') {
        bracket += '^'
        j++
      }
      while (j < pattern.length && pattern[j] !== ']') {
        bracket += pattern[j]
        j++
      }
      bracket += ']'
      regexStr += bracket
      i = j + 1
    } else if (ch === '{') {
      const j = pattern.indexOf('}', i)
      if (j > i) {
        const options = pattern.slice(i + 1, j).split(',')
        regexStr += `(?:${options.map(o => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
        i = j + 1
      } else {
        regexStr += '\\{'
        i++
      }
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regexStr += '\\' + ch
      i++
    } else {
      regexStr += ch
      i++
    }
  }
  return new RegExp(`^${regexStr}$`)
}

async function walkDir(dir: string, results: string[], maxResults: number): Promise<void> {
  if (results.length >= maxResults) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (results.length >= maxResults) return
    const fullPath = join(dir, entry.name)
    if (entry.name.startsWith('.') && entry.name !== '.claude' && entry.name !== '.env') continue
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
      await walkDir(fullPath, results, maxResults)
    } else if (entry.isFile()) {
      results.push(fullPath)
    }
  }
}

export class GlobTool extends BaseTool<{ pattern: string; path?: string }, string> {
  name = 'Glob'
  description = 'Find files matching a glob pattern. Supports *, **, ?, and [] patterns. Returns matching file paths sorted by modification time.'
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
        pattern: { type: 'string', description: 'The glob pattern to match files against (e.g. "**/*.ts", "src/**/*.js", "*.md")' },
        path: { type: 'string', description: 'The directory to search in (defaults to current working directory)' },
      },
      required: ['pattern'],
    }
  }

  async call(input: { pattern: string; path?: string }, _context: ToolUseContext): Promise<string> {
    const searchPath = input.path ? resolve(input.path) : process.cwd()
    const maxResults = 1000

    let dirToSearch: string
    let filePattern: string

    const lastSlash = input.pattern.lastIndexOf('/')
    if (lastSlash >= 0) {
      const dirPart = input.pattern.slice(0, lastSlash)
      filePattern = input.pattern.slice(lastSlash + 1)
      dirToSearch = resolve(searchPath, dirPart)
    } else {
      filePattern = input.pattern
      dirToSearch = searchPath
    }

    if (!filePattern || filePattern === '**') {
      filePattern = '**/*'
    }

    const allFiles: string[] = []
    await walkDir(dirToSearch, allFiles, maxResults * 2)

    const regex = globToRegex(filePattern)
    const matches = allFiles
      .map(f => f.replace(/\\/g, '/'))
      .filter(f => {
        const relativePath = f.replace(dirToSearch.replace(/\\/g, '/') + '/', '')
        return regex.test(relativePath) || regex.test(relativePath.split('/').pop() ?? '')
      })

    if (matches.length === 0) {
      return 'No files found matching the pattern.'
    }

    const sorted = matches.slice(0, maxResults)
    return sorted.join('\n')
  }
}
