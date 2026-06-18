import type { Tool, ToolDefinition, ToolInputSchema, ValidationResult, ToolUseContext, PermissionResult } from '../tools/base.js'
import type { MCPTool } from './types.js'
import type { MCPClient } from './client.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('mcp-adapter')

export class MCPToolAdapter implements Tool {
  name: string
  aliases?: string[]
  description: string
  searchHint?: string
  maxResultSizeChars?: number
  shouldDefer?: boolean
  alwaysLoad?: boolean

  private mcpTool: MCPTool
  private client: MCPClient

  constructor(mcpTool: MCPTool, client: MCPClient) {
    this.mcpTool = mcpTool
    this.client = client
    this.name = `mcp__${mcpTool.serverName}__${mcpTool.name}`
    this.description = `[MCP:${mcpTool.serverName}] ${mcpTool.description}`
    this.searchHint = `mcp ${mcpTool.serverName} ${mcpTool.name}`
  }

  isEnabled(): boolean {
    return this.client.isConnected
  }

  isConcurrencySafe(_input: Record<string, unknown>): boolean {
    return true
  }

  isReadOnly(_input: Record<string, unknown>): boolean {
    return true
  }

  isDestructive(_input: Record<string, unknown>): boolean {
    return false
  }

  requiresUserInteraction(): boolean {
    return false
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') {
      return { success: true }
    }
    return { success: true }
  }

  async checkPermissions(_input: Record<string, unknown>, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: 'allow' }
  }

  async call(input: Record<string, unknown>, _context: ToolUseContext): Promise<string> {
    try {
      const result = await this.client.callTool(this.mcpTool.name, input)
      const textParts = result.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text!)
      if (textParts.length > 0) {
        return textParts.join('\n')
      }
      return JSON.stringify(result.content)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error(`MCP tool ${this.name} call failed: ${msg}`)
      throw new Error(`MCP tool "${this.mcpTool.name}" on server "${this.mcpTool.serverName}" failed: ${msg}`)
    }
  }

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.normalizeInputSchema(this.mcpTool.inputSchema),
    }
  }

  private normalizeInputSchema(schema: Record<string, unknown>): ToolInputSchema {
    if (schema && schema.type === 'object' && schema.properties) {
      return schema as unknown as ToolInputSchema
    }
    return {
      type: 'object',
      properties: (schema?.properties as Record<string, unknown>) ?? {},
      required: (schema?.required as string[]) ?? [],
    }
  }
}

export function createMCPToolAdapters(client: MCPClient): MCPToolAdapter[] {
  return client.getTools().map(tool => new MCPToolAdapter(tool, client))
}

export function createAllMCPToolAdapters(clients: MCPClient[]): MCPToolAdapter[] {
  return clients.flatMap(client => createMCPToolAdapters(client))
}
