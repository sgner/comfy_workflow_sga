/**
 * ComfyUINodeInspect — Deep node inspection tool.
 *
 * Returns full node definition (inputs/outputs/widgets from /object_info)
 * PLUS the source code location and key method snippets (INPUT_TYPES,
 * RETURN_TYPES, FUNCTION, process/forward) by searching custom_nodes.
 *
 * Use this when ComfyUINodeSearch's metadata is insufficient and you need
 * to understand what a node actually does (e.g., which model folder it reads).
 */
import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'
import { readdir, readFile } from 'fs/promises'
import { join, resolve, basename, dirname } from 'path'
import { existsSync } from 'fs'
import { createLogger } from '../../utils/logger.js'
import { getNodeDef } from '../../comfyui/node-def-index.js'

const logger = createLogger('comfyui-node-inspect')

function getComfyUIBaseDir(): string {
  return process.env.COMFYUI_BASE_DIR ?? process.cwd()
}

interface SourceLocation {
  file: string
  line: number
  snippet: string
}

/**
 * Search for a class definition in a Python file and return its location
 * plus a snippet of the class body (up to maxLines).
 */
async function findClassInFile(
  filePath: string,
  className: string,
  maxLines = 40,
): Promise<SourceLocation | null> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }

  const lines = content.split('\n')
  // Match "class ClassName" or "class ClassName("
  const classPattern = new RegExp(`^class\\s+${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[(:]`)

  for (let i = 0; i < lines.length; i++) {
    if (classPattern.test(lines[i].trim())) {
      // Found the class definition; extract snippet
      const snippetLines: string[] = []
      const baseIndent = lines[i].match(/^\s*/)?.[0].length ?? 0
      for (let j = i; j < Math.min(i + maxLines, lines.length); j++) {
        snippetLines.push(lines[j])
        // Stop if we hit the next class/function at the same or lower indent
        if (j > i && lines[j].trim().startsWith('class ') || lines[j].trim().startsWith('def ')) {
          const currentIndent = lines[j].match(/^\s*/)?.[0].length ?? 0
          if (currentIndent <= baseIndent && lines[j].trim()) {
            snippetLines.pop()
            break
          }
        }
      }
      return {
        file: filePath,
        line: i + 1,
        snippet: snippetLines.join('\n'),
      }
    }
  }
  return null
}

/**
 * Search for NODE_CLASS_MAPPINGS entries that reference the given node name
 * to find which custom_node package defines it.
 */
async function findNodeClassMapping(
  customNodesDir: string,
  nodeDisplayName: string,
): Promise<{ file: string; line: number; mappingLine: string } | null> {
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(customNodesDir, { withFileTypes: true }) as unknown as import('fs').Dirent[]
  } catch {
    return null
  }

  for (const entry of entries) {
    const entryName = typeof entry === 'string' ? entry : entry.name
    const isDir = typeof entry === 'string' ? false : entry.isDirectory()
    if (!isDir || entryName.startsWith('.') || entryName.startsWith('__')) continue
    const initFile = join(customNodesDir, entryName, '__init__.py')
    if (!existsSync(initFile)) continue

    let content: string
    try {
      content = await readFile(initFile, 'utf-8')
    } catch {
      continue
    }

    const lines = content.split('\n')
    // Look for "NodeDisplayName": or 'NodeDisplayName':
    const mappingPattern = new RegExp(`["']${nodeDisplayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*:`)

    for (let i = 0; i < lines.length; i++) {
      if (mappingPattern.test(lines[i])) {
        return { file: initFile, line: i + 1, mappingLine: lines[i].trim() }
      }
    }
  }
  return null
}

/**
 * Find Python files in a custom_node directory that might contain the class definition.
 */
async function findPythonFiles(dir: string, maxDepth = 2, maxFiles = 50): Promise<string[]> {
  const results: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }]

  while (queue.length > 0 && results.length < maxFiles) {
    const { dir: currentDir, depth } = queue.shift()!
    let entries: import('fs').Dirent[]
    try {
      entries = await readdir(currentDir, { withFileTypes: true }) as unknown as import('fs').Dirent[]
    } catch {
      continue
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break
      const entryName = typeof entry === 'string' ? entry : entry.name
      const isDir = typeof entry === 'string' ? false : entry.isDirectory()
      if (entryName.startsWith('.') || entryName === '__pycache__') continue

      const fullPath = join(currentDir, entryName)
      if (isDir && depth < maxDepth) {
        queue.push({ dir: fullPath, depth: depth + 1 })
      } else if (!isDir && entryName.endsWith('.py')) {
        results.push(fullPath)
      }
    }
  }
  return results
}

/**
 * Extract the class name from a NODE_CLASS_MAPPINGS line like:
 *   "NodeDisplayName": ActualClassName,
 */
function extractClassName(mappingLine: string): string | null {
  // Match "..." : ClassName  or  '...' : ClassName
  const match = mappingLine.match(/["']\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/)
  if (match) return match[1]
  // Also try: "ClassName": ActualClass
  const match2 = mappingLine.match(/:\s*([A-Za-z_][A-Za-z0-9_]*)/)
  if (match2) return match2[1]
  return null
}

export class ComfyUINodeInspectTool extends BaseTool {
  name = 'ComfyUINodeInspect'
  description = 'Inspect a ComfyUI node in depth: returns full input/output/widget definitions from /object_info, plus the source code file and key method snippets (INPUT_TYPES, RETURN_TYPES, FUNCTION, process/forward) from custom_nodes. Use this when you need to understand what a node actually does (e.g., which model folder it reads, what data types it expects).'
  searchHint = 'comfyui node inspect source code definition inputs outputs widgets custom_nodes python'

  isEnabled(): boolean {
    return !!process.env.COMFYUI_BASE_DIR
  }

  isReadOnly(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        node_name: {
          type: 'string',
          description: 'The node display name (e.g., "CheckpointLoaderSimple") or class name to inspect.',
        },
      },
      required: ['node_name'],
    }
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const obj = input as Record<string, unknown>
    if (!obj.node_name || typeof obj.node_name !== 'string') {
      return { success: false, error: 'node_name is required and must be a string' }
    }
    return { success: true }
  }

  async call(input: { node_name: string }, _context: ToolUseContext): Promise<string> {
    const nodeName = input.node_name
    const baseDir = getComfyUIBaseDir()
    const customNodesDir = join(baseDir, 'custom_nodes')

    const lines: string[] = []
    lines.push(`# Node Inspection: ${nodeName}`)
    lines.push('')

    // Phase 1: Get full node definition from /object_info (via NodeDefIndex)
    let nodeDef: import('../../comfyui/node-def-index.js').NodeDef | null = null
    try {
      nodeDef = await getNodeDef(nodeName)
    } catch (err) {
      logger.warn(`Failed to get NodeDef for "${nodeName}":`, err instanceof Error ? err.message : String(err))
    }

    if (nodeDef) {
      lines.push('## Node Definition (from /object_info)')
      lines.push(`- **Name**: ${nodeDef.name}`)
      lines.push(`- **Category**: ${nodeDef.category}`)
      if (nodeDef.description) lines.push(`- **Description**: ${nodeDef.description}`)
      if (nodeDef.deprecated) lines.push(`- **Deprecated**: yes`)
      if (nodeDef.experimental) lines.push(`- **Experimental**: yes`)

      if (nodeDef.inputs.length > 0) {
        lines.push('')
        lines.push('### Inputs')
        for (const inp of nodeDef.inputs) {
          const req = inp.required ? 'required' : 'optional'
          lines.push(`  - **${inp.name}** (${inp.type}) [${req}]`)
        }
      }

      if (nodeDef.outputs.length > 0) {
        lines.push('')
        lines.push('### Outputs')
        for (const out of nodeDef.outputs) {
          lines.push(`  - **${out.name}** (${out.type})`)
        }
      }

      if (nodeDef.widgets.length > 0) {
        lines.push('')
        lines.push('### Widgets')
        for (const w of nodeDef.widgets) {
          let widgetLine = `  - **${w.name}** (${w.type})`
          if (w.options && w.options.length > 0) {
            widgetLine += ` options: ${w.options.slice(0, 10).join(', ')}${w.options.length > 10 ? '...' : ''}`
          }
          if (w.defaultValue !== undefined) widgetLine += ` default: ${w.defaultValue}`
          if (w.min !== undefined) widgetLine += ` min: ${w.min}`
          if (w.max !== undefined) widgetLine += ` max: ${w.max}`
          lines.push(widgetLine)
        }
      }
    } else {
      lines.push('## Node Definition')
      lines.push(`(Not found in /object_info. This may be a built-in node or the name is incorrect.)`)
    }

    // Phase 2: Find source code in custom_nodes
    lines.push('')
    lines.push('## Source Code Location')

    // Try to find NODE_CLASS_MAPPINGS entry
    const mapping = await findNodeClassMapping(customNodesDir, nodeName)
    let className: string | null = null
    let customNodeDir: string | null = null

    if (mapping) {
      lines.push(`- **NODE_CLASS_MAPPINGS entry**: ${mapping.file}:${mapping.line}`)
      lines.push(`  \`${mapping.mappingLine}\``)
      className = extractClassName(mapping.mappingLine)
      customNodeDir = dirname(mapping.file)
      if (className) {
        lines.push(`  → Class name: \`${className}\``)
      }
    } else {
      // If no mapping found, assume the node name IS the class name
      className = nodeName
      lines.push(`- No NODE_CLASS_MAPPINGS entry found. Searching by class name \`${nodeName}\`.`)
    }

    // Search for class definition in Python files
    if (className) {
      let searchDirs: string[] = []
      if (customNodeDir) {
        searchDirs = [customNodeDir]
      } else {
        // Search all custom_nodes subdirectories
        try {
          const entries = await readdir(customNodesDir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('__')) {
              searchDirs.push(join(customNodesDir, entry.name))
            }
          }
        } catch { /* ignore */ }
      }

      let foundSource: SourceLocation | null = null
      for (const searchDir of searchDirs) {
        const pyFiles = await findPythonFiles(searchDir)
        for (const pyFile of pyFiles) {
          foundSource = await findClassInFile(pyFile, className)
          if (foundSource) break
        }
        if (foundSource) break
      }

      if (foundSource) {
        lines.push(`- **Class definition**: ${foundSource.file}:${foundSource.line}`)
        lines.push('')
        lines.push('### Source snippet')
        lines.push('```python')
        lines.push(foundSource.snippet)
        lines.push('```')
        lines.push('')
        lines.push(`To read more of this file, use the Read tool with path: \`${foundSource.file}\``)
      } else {
        lines.push(`- Class \`${className}\` not found in any .py file under custom_nodes.`)
        lines.push(`  Try using Grep to search: \`Grep(pattern="class ${className}", path="${customNodesDir}", glob="*.py")\``)
      }
    }

    return lines.join('\n')
  }

  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.getInputSchema(),
    }
  }
}
