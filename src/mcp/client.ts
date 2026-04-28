import type { MCPServerConfig, MCPTool, MCPResource, MCPPrompt, MCPCallResult } from './types.js'

export interface MCPTransport {
  connect(): Promise<void>
  disconnect(): Promise<void>
  send(request: unknown): Promise<unknown>
  isConnected(): boolean
}

export class MCPClient {
  private serverName: string
  private config: MCPServerConfig
  private transport: MCPTransport | null = null
  private tools: MCPTool[] = []
  private resources: MCPResource[] = []
  private prompts: MCPPrompt[] = []
  private restartAttempts = 0

  constructor(serverName: string, config: MCPServerConfig) {
    this.serverName = serverName
    this.config = config
  }

  get name(): string {
    return this.serverName
  }

  get isConnected(): boolean {
    return this.transport?.isConnected() ?? false
  }

  getTools(): MCPTool[] {
    return this.tools
  }

  getResources(): MCPResource[] {
    return this.resources
  }

  getPrompts(): MCPPrompt[] {
    return this.prompts
  }

  async connect(): Promise<void> {
    this.transport = this.createTransport()
    await this.transport.connect()

    await this.initialize()
    await this.refreshCapabilities()
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.disconnect()
      this.transport = null
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPCallResult> {
    if (!this.transport) throw new Error(`MCP server "${this.serverName}" is not connected`)

    const response = await this.transport.send({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: args },
      id: Date.now(),
    })

    const result = response as { result?: MCPCallResult; error?: { message: string } }
    if (result.error) {
      throw new Error(`MCP tool call error: ${result.error.message}`)
    }

    return result.result ?? { content: [] }
  }

  async readResource(uri: string): Promise<unknown> {
    if (!this.transport) throw new Error(`MCP server "${this.serverName}" is not connected`)

    const response = await this.transport.send({
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri },
      id: Date.now(),
    })

    return response
  }

  async refreshCapabilities(): Promise<void> {
    if (!this.transport) return

    try {
      const toolsResponse = await this.transport.send({
        jsonrpc: '2.0',
        method: 'tools/list',
        id: Date.now(),
      })
      const toolsResult = toolsResponse as { result?: { tools: Array<Record<string, unknown>> } }
      this.tools = (toolsResult.result?.tools ?? []).map(t => ({
        name: t.name as string,
        description: (t.description as string) ?? '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
        serverName: this.serverName,
      }))
    } catch {
      this.tools = []
    }

    try {
      const resourcesResponse = await this.transport.send({
        jsonrpc: '2.0',
        method: 'resources/list',
        id: Date.now(),
      })
      const resourcesResult = resourcesResponse as { result?: { resources: Array<Record<string, unknown>> } }
      this.resources = (resourcesResult.result?.resources ?? []).map(r => ({
        name: r.name as string,
        uri: r.uri as string,
        description: r.description as string | undefined,
        mimeType: r.mimeType as string | undefined,
        serverName: this.serverName,
      }))
    } catch {
      this.resources = []
    }

    try {
      const promptsResponse = await this.transport.send({
        jsonrpc: '2.0',
        method: 'prompts/list',
        id: Date.now(),
      })
      const promptsResult = promptsResponse as { result?: { prompts: Array<Record<string, unknown>> } }
      this.prompts = (promptsResult.result?.prompts ?? []).map(p => ({
        name: p.name as string,
        description: p.description as string | undefined,
        serverName: this.serverName,
      }))
    } catch {
      this.prompts = []
    }
  }

  private async initialize(): Promise<void> {
    if (!this.transport) return

    await this.transport.send({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cc-contron', version: '1.0.0' },
      },
      id: Date.now(),
    })
  }

  private createTransport(): MCPTransport {
    switch (this.config.transport) {
      case 'stdio':
        return new StdioTransport(this.config)
      case 'sse':
      case 'streamable-http':
        return new HttpTransport(this.config)
      default:
        throw new Error(`Unsupported transport: ${this.config.transport}`)
    }
  }
}

class StdioTransport implements MCPTransport {
  private config: MCPServerConfig
  private childProcess: import('child_process').ChildProcess | null = null
  private messageId = 0
  private pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = new Map()

  constructor(config: MCPServerConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    const { spawn } = await import('child_process')
    this.childProcess = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...this.config.env },
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.childProcess.stdout?.on('data', (data: Buffer) => {
      this.handleMessage(data.toString())
    })
  }

  async disconnect(): Promise<void> {
    if (this.childProcess) {
      this.childProcess.kill()
      this.childProcess = null
    }
  }

  async send(request: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.messageId
      const req = { ...(request as object), id }
      this.pendingRequests.set(id, { resolve, reject })

      const message = JSON.stringify(req) + '\n'
      this.childProcess?.stdin?.write(message)
    })
  }

  isConnected(): boolean {
    return this.childProcess !== null && !this.childProcess.killed
  }

  private handleMessage(data: string): void {
    try {
      const response = JSON.parse(data)
      const id = response.id as number
      const pending = this.pendingRequests.get(id)
      if (pending) {
        this.pendingRequests.delete(id)
        if (response.error) {
          pending.reject(new Error(response.error.message ?? 'Unknown MCP error'))
        } else {
          pending.resolve(response)
        }
      }
    } catch {
      // Ignore non-JSON messages
    }
  }
}

class HttpTransport implements MCPTransport {
  private config: MCPServerConfig
  private connected = false

  constructor(config: MCPServerConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  async send(request: unknown): Promise<unknown> {
    const url = this.config.url ?? `http://localhost:3000`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.config.headers,
      },
      body: JSON.stringify(request),
    })

    return response.json()
  }

  isConnected(): boolean {
    return this.connected
  }
}
