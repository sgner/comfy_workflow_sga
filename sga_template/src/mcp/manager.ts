import { EventEmitter } from 'events'
import { MCPClient } from './client.js'
import type { MCPServerConfig } from './types.js'
import type { MCPTool, MCPResource } from './types.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('mcp-manager')

export interface MCPServerState {
  name: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  config: MCPServerConfig
  client: MCPClient | null
  tools: MCPTool[]
  resources: MCPResource[]
  error?: string
  connectedAt?: number
}

const mcpServers: Map<string, MCPServerState> = new Map()
const mcpEmitter = new EventEmitter()

export function registerMCPServer(config: MCPServerConfig): MCPServerState {
  const existing = mcpServers.get(config.name)
  if (existing) {
    return existing
  }

  const state: MCPServerState = {
    name: config.name,
    status: 'disconnected',
    config,
    client: null,
    tools: [],
    resources: [],
  }

  mcpServers.set(config.name, state)
  mcpEmitter.emit('server:registered', state)

  return state
}

export function unregisterMCPServer(name: string): boolean {
  const server = mcpServers.get(name)
  if (!server) return false

  if (server.status === 'connected') {
    disconnectMCPServer(name)
  }

  mcpServers.delete(name)
  mcpEmitter.emit('server:unregistered', { name })
  return true
}

export function getMCPServer(name: string): MCPServerState | undefined {
  return mcpServers.get(name)
}

export function getAllMCPServers(): MCPServerState[] {
  return Array.from(mcpServers.values())
}

export function getConnectedMCPServers(): MCPServerState[] {
  return Array.from(mcpServers.values()).filter(s => s.status === 'connected')
}

export function getAllMCPTools(): MCPTool[] {
  return Array.from(mcpServers.values()).flatMap(s => s.tools)
}

export function getAllMCPResources(): MCPResource[] {
  return Array.from(mcpServers.values()).flatMap(s => s.resources)
}

export function getConnectedMCPClients(): MCPClient[] {
  return Array.from(mcpServers.values())
    .filter(s => s.client && s.status === 'connected')
    .map(s => s.client!)
}

export async function connectMCPServer(name: string): Promise<MCPServerState> {
  const server = mcpServers.get(name)
  if (!server) throw new Error(`MCP server "${name}" not found`)
  if (server.status === 'connected') return server

  server.status = 'connecting'
  mcpEmitter.emit('server:connecting', server)

  try {
    const client = new MCPClient(name, server.config)
    await client.connect()

    server.client = client
    server.tools = client.getTools()
    server.resources = client.getResources()
    server.status = 'connected'
    server.connectedAt = Date.now()
    server.error = undefined

    logger.info(`MCP server "${name}" connected, tools=${server.tools.length}, resources=${server.resources.length}`)
    mcpEmitter.emit('server:connected', server)
    return server
  } catch (error) {
    server.status = 'error'
    server.error = error instanceof Error ? error.message : String(error)
    server.client = null
    logger.error(`MCP server "${name}" connection failed: ${server.error}`)
    mcpEmitter.emit('server:error', { server, error: server.error })
    throw error
  }
}

export async function disconnectMCPServer(name: string): Promise<void> {
  const server = mcpServers.get(name)
  if (!server) return

  if (server.client) {
    try {
      await server.client.disconnect()
    } catch (error) {
      logger.warn(`Error disconnecting MCP server "${name}": ${error instanceof Error ? error.message : String(error)}`)
    }
    server.client = null
  }

  server.status = 'disconnected'
  server.tools = []
  server.resources = []
  mcpEmitter.emit('server:disconnected', server)
}

export async function connectAllMCPServers(): Promise<MCPServerState[]> {
  const results: MCPServerState[] = []
  for (const [name, server] of mcpServers) {
    if (server.config.disabled) continue
    try {
      const connected = await connectMCPServer(name)
      results.push(connected)
    } catch {
      results.push(server)
    }
  }
  return results
}

export async function disconnectAllMCPServers(): Promise<void> {
  for (const [name] of mcpServers) {
    await disconnectMCPServer(name)
  }
}

export async function refreshMCPServer(name: string): Promise<MCPServerState> {
  const server = mcpServers.get(name)
  if (!server) throw new Error(`MCP server "${name}" not found`)
  if (!server.client || server.status !== 'connected') {
    throw new Error(`MCP server "${name}" is not connected`)
  }

  try {
    await server.client.refreshCapabilities()
    server.tools = server.client.getTools()
    server.resources = server.client.getResources()
    return server
  } catch (error) {
    server.error = error instanceof Error ? error.message : String(error)
    throw error
  }
}

export function onMCPEvent(event: string, listener: (...args: unknown[]) => void): void {
  mcpEmitter.on(event, listener)
}

export function loadMCPServersFromConfig(configs: MCPServerConfig[]): MCPServerState[] {
  const states: MCPServerState[] = []
  for (const config of configs) {
    states.push(registerMCPServer(config))
  }
  return states
}
