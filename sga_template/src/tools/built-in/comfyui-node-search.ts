import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult } from '../base.js'
import { readdir, readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('comfyui-node-search')

function getComfyUIBaseDir(): string {
  return process.env.COMFYUI_BASE_DIR ?? process.cwd()
}

interface NodeInfo {
  name: string
  category: string
  description: string
  inputTypes: string[]
  outputTypes: string[]
  source: string
}

async function searchBuiltinNodes(baseDir: string, query: string): Promise<NodeInfo[]> {
  const results: NodeInfo[] = []
  const nodesDir = join(baseDir, 'comfy_extras')
  const nodesFile = join(baseDir, 'nodes.py')

  if (existsSync(nodesFile)) {
    try {
      const content = await readFile(nodesFile, 'utf-8')
      const nodeClassRegex = /class\s+(\w+)\s*\(.*?\):\s*\n\s*"""([\s\S]*?)"""/g
      let match
      while ((match = nodeClassRegex.exec(content)) !== null) {
        const name = match[1]
        const desc = match[2].trim()
        if (name.toLowerCase().includes(query) || desc.toLowerCase().includes(query)) {
          results.push({
            name,
            category: 'built-in',
            description: desc.split('\n')[0],
            inputTypes: [],
            outputTypes: [],
            source: nodesFile,
          })
        }
      }

      const nodeMappingRegex = /NODE_CLASS_MAPPINGS\s*=\s*\{([\s\S]*?)\}/
      const mappingMatch = content.match(nodeMappingRegex)
      if (mappingMatch) {
        const mappingContent = mappingMatch[1]
        const entryRegex = /"([^"]+)"\s*:\s*(\w+)/g
        let entryMatch
        while ((entryMatch = entryRegex.exec(mappingContent)) !== null) {
          const displayName = entryMatch[1]
          const className = entryMatch[2]
          if (displayName.toLowerCase().includes(query) || className.toLowerCase().includes(query)) {
            if (!results.find(r => r.name === className)) {
              results.push({
                name: className,
                category: 'built-in',
                description: `Display name: ${displayName}`,
                inputTypes: [],
                outputTypes: [],
                source: nodesFile,
              })
            }
          }
        }
      }
    } catch {
      // skip
    }
  }

  if (existsSync(nodesDir)) {
    try {
      const entries = await readdir(nodesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.py')) continue
        const filePath = join(nodesDir, entry.name)
        try {
          const content = await readFile(filePath, 'utf-8')
          const classRegex = /class\s+(\w+)\s*\(.*?\)/g
          let classMatch
          while ((classMatch = classRegex.exec(content)) !== null) {
            const name = classMatch[1]
            if (name.toLowerCase().includes(query)) {
              results.push({
                name,
                category: `comfy_extras/${entry.name.replace('.py', '')}`,
                description: '',
                inputTypes: [],
                outputTypes: [],
                source: filePath,
              })
            }
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }

  return results
}

async function searchCustomNodes(baseDir: string, query: string): Promise<NodeInfo[]> {
  const results: NodeInfo[] = []
  const customNodesDir = join(baseDir, 'custom_nodes')

  if (!existsSync(customNodesDir)) return results

  let entries
  try {
    entries = await readdir(customNodesDir, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const nodeDir = join(customNodesDir, entry.name)

    const initFile = join(nodeDir, '__init__.py')
    if (!existsSync(initFile)) continue

    try {
      const content = await readFile(initFile, 'utf-8')

      const nodeMappingRegex = /NODE_CLASS_MAPPINGS\s*=\s*\{([\s\S]*?)\}/
      const mappingMatch = content.match(nodeMappingRegex)
      if (mappingMatch) {
        const mappingContent = mappingMatch[1]
        const entryRegex = /["']([^"']+)["']\s*:\s*(\w+)/g
        let entryMatch
        while ((entryMatch = entryRegex.exec(mappingContent)) !== null) {
          const displayName = entryMatch[1]
          const className = entryMatch[2]
          if (displayName.toLowerCase().includes(query) || className.toLowerCase().includes(query)) {
            results.push({
              name: className,
              category: `custom_nodes/${entry.name}`,
              description: `Display name: ${displayName}`,
              inputTypes: [],
              outputTypes: [],
              source: initFile,
            })
          }
        }
      }

      const classRegex = /class\s+(\w+)(?:\s*\([^)]*\))?\s*:\s*\n\s*"""([\s\S]*?)"""/g
      let classMatch
      while ((classMatch = classRegex.exec(content)) !== null) {
        const name = classMatch[1]
        const desc = classMatch[2].trim()
        if (name.toLowerCase().includes(query) || desc.toLowerCase().includes(query)) {
          if (!results.find(r => r.name === name)) {
            results.push({
              name,
              category: `custom_nodes/${entry.name}`,
              description: desc.split('\n')[0],
              inputTypes: [],
              outputTypes: [],
              source: initFile,
            })
          }
        }
      }
    } catch {
      // skip
    }
  }

  return results
}

export class ComfyUINodeSearchTool extends BaseTool<
  { query: string; category?: string },
  string
> {
  name = 'ComfyUINodeSearch'
  description = 'Search for available ComfyUI node types by name or description. Searches both built-in nodes and custom_nodes. Returns node names, categories, and descriptions.'
  searchHint = 'comfyui node search type find custom'

  isReadOnly(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  isDestructive(): boolean {
    return false
  }

  requiresUserInteraction(): boolean {
    return false
  }

  isEnabled(): boolean {
    return !!process.env.COMFYUI_BASE_DIR
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const query = (input as { query?: string }).query
    if (!query || typeof query !== 'string') return { success: false, error: 'query is required' }
    return { success: true }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - node name or description keyword (e.g. "KSampler", "LoadImage", "VAE")',
        },
        category: {
          type: 'string',
          description: 'Filter by category: "built-in", "custom_nodes", or a specific custom node folder name',
        },
      },
      required: ['query'],
    }
  }

  async call(input: { query: string; category?: string }, _context: ToolUseContext): Promise<string> {
    const baseDir = getComfyUIBaseDir()
    const query = input.query.toLowerCase()
    const categoryFilter = input.category?.toLowerCase()

    const allNodes: NodeInfo[] = []

    if (!categoryFilter || categoryFilter === 'built-in') {
      const builtinNodes = await searchBuiltinNodes(baseDir, query)
      allNodes.push(...builtinNodes)
    }

    if (!categoryFilter || categoryFilter !== 'built-in') {
      const customNodes = await searchCustomNodes(baseDir, query)
      allNodes.push(...customNodes)
    }

    let filtered = allNodes
    if (categoryFilter && categoryFilter !== 'built-in') {
      filtered = filtered.filter(n => n.category.toLowerCase().includes(categoryFilter))
    }

    if (filtered.length === 0) {
      return `No ComfyUI nodes found matching "${input.query}". Try a broader search term or check if the node is installed.`
    }

    const lines: string[] = [`Found ${filtered.length} node(s) matching "${input.query}":`]

    for (const node of filtered) {
      lines.push(`\n- **${node.name}** [${node.category}]`)
      if (node.description) {
        lines.push(`  ${node.description}`)
      }
      lines.push(`  Source: ${node.source}`)
    }

    return lines.join('\n')
  }
}
