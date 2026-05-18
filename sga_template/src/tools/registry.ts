import type { Tool, ToolDefinition, ToolUseContext } from './base.js'

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map()
  private deferredTools: Map<string, Tool> = new Map()

  register(tool: Tool): void {
    if (tool.shouldDefer && !tool.alwaysLoad) {
      this.deferredTools.set(tool.name, tool)
    } else {
      this.tools.set(tool.name, tool)
    }
    for (const alias of tool.aliases ?? []) {
      this.tools.set(alias, tool)
    }
  }

  unregister(name: string): void {
    this.tools.delete(name)
    this.deferredTools.delete(name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name) ?? this.deferredTools.get(name)
  }

  getAll(): Tool[] {
    return [...new Set([...this.tools.values(), ...this.deferredTools.values()])]
  }

  getActiveTools(): Tool[] {
    return [...this.tools.values()].filter(t => t.isEnabled())
  }

  getDeferredTools(): Tool[] {
    return [...this.deferredTools.values()].filter(t => t.isEnabled())
  }

  getDefinitions(): ToolDefinition[] {
    return this.getActiveTools().map(t => t.getDefinition())
  }

  search(query: string): Tool[] {
    const lower = query.toLowerCase()
    return this.getAll().filter(t =>
      t.name.toLowerCase().includes(lower) ||
      t.description.toLowerCase().includes(lower) ||
      t.searchHint?.toLowerCase().includes(lower)
    )
  }

  loadDeferred(name: string): Tool | undefined {
    const tool = this.deferredTools.get(name)
    if (tool) {
      this.tools.set(name, tool)
      this.deferredTools.delete(name)
    }
    return tool
  }

  clear(): void {
    this.tools.clear()
    this.deferredTools.clear()
  }

  get size(): number {
    return this.tools.size + this.deferredTools.size
  }
}

export function assembleToolPool(
  baseTools: Tool[],
  mcpTools: Tool[] = [],
  globallyDisallowed: string[] = [],
): Tool[] {
  const allTools = [...baseTools, ...mcpTools]
  const seen = new Set<string>()
  const deduped: Tool[] = []

  for (const tool of allTools) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    if (!globallyDisallowed.includes(tool.name)) {
      deduped.push(tool)
    }
  }

  return deduped
}
