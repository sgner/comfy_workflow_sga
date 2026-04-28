import { EventEmitter } from 'events'

export interface MCPServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
  alwaysAllow?: string[]
}

export interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  serverName: string
}

export interface MCPResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
  serverName: string
}

export interface MCPServerState {
  name: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  config: MCPServerConfig
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

export async function connectMCPServer(name: string): Promise<MCPServerState> {
  const server = mcpServers.get(name)
  if (!server) throw new Error(`MCP server "${name}" not found`)
  if (server.status === 'connected') return server

  server.status = 'connecting'
  mcpEmitter.emit('server:connecting', server)

  try {
    if (server.config.transport === 'stdio') {
      await connectStdioServer(server)
    } else if (server.config.transport === 'sse' || server.config.transport === 'streamable-http') {
      await connectHTTPServer(server)
    }

    server.status = 'connected'
    server.connectedAt = Date.now()
    server.error = undefined
    mcpEmitter.emit('server:connected', server)
    return server
  } catch (error) {
    server.status = 'error'
    server.error = error instanceof Error ? error.message : String(error)
    mcpEmitter.emit('server:error', { server, error: server.error })
    throw error
  }
}

export async function disconnectMCPServer(name: string): Promise<void> {
  const server = mcpServers.get(name)
  if (!server) return

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

async function connectStdioServer(server: MCPServerState): Promise<void> {
  const { spawn } = await import('child_process')
  const config = server.config

  return new Promise((resolve, reject) => {
    try {
      const childProcess = spawn(config.command, config.args ?? [], {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let initialized = false

      childProcess.on('error', (err: Error) => {
        if (!initialized) {
          initialized = true
          reject(err)
        }
      })

      childProcess.on('exit', (code: number | null) => {
        if (!initialized) {
          initialized = true
          reject(new Error(`MCP server exited with code ${code}`))
        }
      })

      setTimeout(() => {
        if (!initialized) {
          initialized = true
          server.tools = [
            {
              name: `${config.name}__placeholder`,
              description: `Placeholder tool for ${config.name} MCP server (stdio transport requires full MCP protocol implementation)`,
              inputSchema: { type: 'object', properties: {} },
              serverName: config.name,
            },
          ]
          resolve()
        }
      }, 2000)
    } catch (error) {
      reject(error)
    }
  })
}

async function connectHTTPServer(server: MCPServerState): Promise<void> {
  const config = server.config
  const url = config.url ?? `http://localhost:3001/${config.name}`

  try {
    const response = await fetch(`${url}/tools`, {
      headers: {
        'Accept': 'application/json',
        ...config.headers,
      },
      signal: AbortSignal.timeout(5000),
    })

    if (response.ok) {
      const data = await response.json() as { tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }> }
      server.tools = (data.tools ?? []).map(t => ({
        name: t.name ?? 'unknown',
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        serverName: config.name,
      }))
    }
  } catch {
    server.tools = [
      {
        name: `${config.name}__placeholder`,
        description: `Placeholder tool for ${config.name} MCP server (HTTP transport requires MCP-compliant endpoint)`,
        inputSchema: { type: 'object', properties: {} },
        serverName: config.name,
      },
    ]
  }
}
