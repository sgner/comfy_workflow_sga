import type { MCPServerConfig, MCPTool, MCPResource, MCPPrompt, MCPCallResult, MCPConnectionState } from './types.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('mcp-client')

const DEFAULT_REQUEST_TIMEOUT_MS = 30000
const JSON_RPC_VERSION = '2.0'
const MCP_PROTOCOL_VERSION = '2024-11-05'
const CLIENT_INFO = { name: 'sga-template', version: '1.0.0' }

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
  private sessionId: string | null = null
  private protocolVersion: string = MCP_PROTOCOL_VERSION
  private _connectionState: MCPConnectionState = 'disconnected'
  private _lastAuthError: string | null = null
  private _reconnectAttempts = 0
  private _maxReconnectAttempts: number
  private _toolsCache: MCPTool[] | null = null
  private _toolsCacheTime = 0
  private _toolsCacheTtlMs = 60_000

  constructor(serverName: string, config: MCPServerConfig) {
    this.serverName = serverName
    this.config = config
    this._maxReconnectAttempts = config.maxRestartAttempts ?? 3
  }

  get name(): string {
    return this.serverName
  }

  get isConnected(): boolean {
    return this.transport?.isConnected() ?? false
  }

  get connectionState(): MCPConnectionState {
    return this._connectionState
  }

  get lastAuthError(): string | null {
    return this._lastAuthError
  }

  getTools(): MCPTool[] {
    const now = Date.now()
    if (this._toolsCache && now - this._toolsCacheTime < this._toolsCacheTtlMs) {
      return this._toolsCache
    }
    this._toolsCache = this.tools
    this._toolsCacheTime = now
    return this.tools
  }

  getResources(): MCPResource[] {
    return this.resources
  }

  getPrompts(): MCPPrompt[] {
    return this.prompts
  }

  async connect(): Promise<void> {
    this._connectionState = 'connecting'
    try {
      this.transport = this.createTransport()
      await this.transport.connect()

      await this.initialize()
      await this.refreshCapabilities()

      this._connectionState = 'connected'
      this._reconnectAttempts = 0
      this._lastAuthError = null
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (isAuthError(msg)) {
        this._connectionState = 'needs-auth'
        this._lastAuthError = msg
        logger.warn(`[MCP:${this.serverName}] Connection requires auth: ${redactUrl(msg)}`)
      } else {
        this._connectionState = 'error'
        logger.error(`[MCP:${this.serverName}] Connection failed: ${redactUrl(msg)}`)
      }
      throw error
    }
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.disconnect()
      this.transport = null
      this.sessionId = null
    }
    this._connectionState = 'disconnected'
    this._toolsCache = null
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPCallResult> {
    if (!this.transport) throw new Error(`MCP server "${this.serverName}" is not connected`)

    try {
      const response = await this.transport.send({
        jsonrpc: JSON_RPC_VERSION,
        method: 'tools/call',
        params: { name, arguments: args },
        id: generateId(),
      })

      const result = response as { result?: MCPCallResult; error?: { message: string; code?: number } }
      if (result.error) {
        const errorCode = result.error.code
        const errorMsg = result.error.message

        if (errorCode === 401 || isAuthError(errorMsg)) {
          this._connectionState = 'needs-auth'
          this._lastAuthError = errorMsg
          this._toolsCache = null
          throw new Error(`MCP auth required for "${this.serverName}": ${errorMsg}`)
        }

        if (errorCode === 404 && isSessionExpiredError(errorMsg)) {
          this._connectionState = 'session-expired'
          this._toolsCache = null
          throw new Error(`MCP session expired for "${this.serverName}": ${errorMsg}`)
        }

        throw new Error(`MCP tool call error (${errorCode}): ${errorMsg}`)
      }

      return result.result ?? { content: [] }
    } catch (error) {
      if (error instanceof Error && isAuthError(error.message)) {
        this._connectionState = 'needs-auth'
        this._lastAuthError = error.message
      }
      throw error
    }
  }

  async tryRecover(): Promise<boolean> {
    if (this._connectionState === 'needs-auth') {
      logger.info(`[MCP:${this.serverName}] Cannot auto-recover from needs-auth state — user must provide credentials`)
      return false
    }

    if (this._connectionState === 'session-expired' && this._reconnectAttempts < this._maxReconnectAttempts) {
      this._reconnectAttempts++
      logger.info(`[MCP:${this.serverName}] Attempting recovery reconnect (${this._reconnectAttempts}/${this._maxReconnectAttempts})`)

      try {
        await this.disconnect()
        this._toolsCache = null
        await this.connect()
      } catch {
        logger.warn(`[MCP:${this.serverName}] Recovery reconnect failed`)
        return false
      }

      return this._connectionState as string === 'connected'
    }

    return false
  }

  async readResource(uri: string): Promise<unknown> {
    if (!this.transport) throw new Error(`MCP server "${this.serverName}" is not connected`)

    const response = await this.transport.send({
      jsonrpc: JSON_RPC_VERSION,
      method: 'resources/read',
      params: { uri },
      id: generateId(),
    })

    return response
  }

  async refreshCapabilities(): Promise<void> {
    if (!this.transport) return

    try {
      const toolsResponse = await this.transport.send({
        jsonrpc: JSON_RPC_VERSION,
        method: 'tools/list',
        id: generateId(),
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
        jsonrpc: JSON_RPC_VERSION,
        method: 'resources/list',
        id: generateId(),
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
        jsonrpc: JSON_RPC_VERSION,
        method: 'prompts/list',
        id: generateId(),
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

    const response = await this.transport.send({
      jsonrpc: JSON_RPC_VERSION,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      id: generateId(),
    })

    const initResult = response as {
      result?: {
        protocolVersion?: string
        capabilities?: Record<string, unknown>
        serverInfo?: { name: string; version: string }
      }
    }

    if (initResult.result?.protocolVersion) {
      this.protocolVersion = initResult.result.protocolVersion
    }

    await this.transport.send({
      jsonrpc: JSON_RPC_VERSION,
      method: 'notifications/initialized',
    }).catch(() => {})
  }

  private createTransport(): MCPTransport {
    switch (this.config.transport) {
      case 'stdio':
        return new StdioTransport(this.config)
      case 'sse':
        return new SSETransport(this.config)
      case 'streamable-http':
        return new StreamableHTTPTransport(this.config)
      default:
        throw new Error(`Unsupported transport: ${this.config.transport}`)
    }
  }
}

function generateId(): number {
  return Date.now() + Math.floor(Math.random() * 1000)
}

function isAuthError(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('unauthorized') ||
    lower.includes('authentication') ||
    lower.includes('invalid token') ||
    lower.includes('token expired') ||
    lower.includes('access denied') ||
    lower.includes('forbidden') ||
    lower.includes('401') ||
    lower.includes('needs-auth')
}

function isSessionExpiredError(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('session') && (lower.includes('expired') || lower.includes('invalid') || lower.includes('not found'))
}

function redactUrl(message: string): string {
  return message.replace(/https?:\/\/[^\s]+/g, (url) => {
    try {
      const parsed = new URL(url)
      return `${parsed.protocol}//${parsed.host}`
    } catch {
      return '[redacted-url]'
    }
  })
}

class StdioTransport implements MCPTransport {
  private config: MCPServerConfig
  private childProcess: import('child_process').ChildProcess | null = null
  private messageId = 0
  private pendingRequests: Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = new Map()
  private buffer = ''
  private timeoutMs: number

  constructor(config: MCPServerConfig) {
    this.config = config
    this.timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  }

  async connect(): Promise<void> {
    const { spawn } = await import('child_process')
    this.childProcess = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...this.config.env },
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.childProcess.stdout?.on('data', (data: Buffer) => {
      this.handleData(data.toString())
    })

    this.childProcess.stderr?.on('data', (data: Buffer) => {
      logger.debug(`[Stdio:${this.config.name}] stderr: ${data.toString().trim()}`)
    })

    this.childProcess.on('error', (err: Error) => {
      logger.error(`[Stdio:${this.config.name}] process error: ${err.message}`)
      this.rejectAllPending(err)
    })

    this.childProcess.on('exit', (code: number | null) => {
      logger.info(`[Stdio:${this.config.name}] process exited with code ${code}`)
      this.rejectAllPending(new Error(`MCP server process exited with code ${code}`))
    })
  }

  async disconnect(): Promise<void> {
    this.rejectAllPending(new Error('Connection closed'))
    if (this.childProcess) {
      this.childProcess.kill()
      this.childProcess = null
    }
    this.buffer = ''
  }

  async send(request: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.childProcess || this.childProcess.killed) {
        reject(new Error('MCP server process is not running'))
        return
      }

      const id = ++this.messageId
      const req = { ...(request as object), id }
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)

      this.pendingRequests.set(id, { resolve, reject, timer })

      const message = JSON.stringify(req) + '\n'
      this.childProcess.stdin?.write(message)
    })
  }

  isConnected(): boolean {
    return this.childProcess !== null && !this.childProcess.killed
  }

  private handleData(data: string): void {
    this.buffer += data

    let newlineIdx: number
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.substring(0, newlineIdx).trim()
      this.buffer = this.buffer.substring(newlineIdx + 1)

      if (!line) continue

      try {
        const response = JSON.parse(line)
        const id = response.id as number | undefined
        if (id !== undefined) {
          const pending = this.pendingRequests.get(id)
          if (pending) {
            clearTimeout(pending.timer)
            this.pendingRequests.delete(id)
            if (response.error) {
              pending.reject(new Error(response.error.message ?? 'Unknown MCP error'))
            } else {
              pending.resolve(response)
            }
          }
        }
      } catch {
        logger.warn(`[Stdio:${this.config.name}] Failed to parse message: ${line.substring(0, 100)}`)
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }
}

class SSETransport implements MCPTransport {
  private config: MCPServerConfig
  private connected = false
  private messageEndpoint: string | null = null
  private eventSource: { close(): void } | null = null
  private pendingNotifications: Array<{ method: string; params?: unknown }> = []
  private timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS

  constructor(config: MCPServerConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    const baseUrl = this.config.url ?? 'http://localhost:3000'
    const sseUrl = baseUrl.endsWith('/sse') ? baseUrl : `${baseUrl}/sse`

    logger.info(`[SSE:${this.config.name}] Connecting to ${sseUrl}`)

    this.messageEndpoint = await this.discoverEndpoint(sseUrl)
    this.connected = true

    this.startEventStream(sseUrl)
  }

  async disconnect(): Promise<void> {
    this.connected = false
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
    this.messageEndpoint = null
    this.pendingNotifications = []
  }

  async send(request: unknown): Promise<unknown> {
    if (!this.connected || !this.messageEndpoint) {
      throw new Error(`MCP SSE server "${this.config.name}" is not connected`)
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch(this.messageEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`SSE POST failed: ${response.status} ${response.statusText}`)
      }

      const contentType = response.headers.get('content-type') ?? ''

      if (contentType.includes('text/event-stream')) {
        return this.readSSEResponse(response)
      }

      if (contentType.includes('application/json')) {
        return response.json()
      }

      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        return { result: text }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  private async discoverEndpoint(sseUrl: string): Promise<string> {
    const timer = setTimeout(() => {
      throw new Error(`SSE endpoint discovery timed out for ${sseUrl}`)
    }, this.timeoutMs)

    try {
      const EventSourceClass = await getEventSourceClass()
      if (EventSourceClass) {
        return new Promise((resolve, reject) => {
          const es = new EventSourceClass(sseUrl, {
            headers: this.config.headers,
          } as ConstructorParameters<typeof EventSource>[1])

          const timeout = setTimeout(() => {
            es.close()
            reject(new Error(`SSE endpoint discovery timed out for ${sseUrl}`))
          }, this.timeoutMs)

          es.addEventListener('endpoint', (event: Event) => {
            clearTimeout(timeout)
            const me = event as MessageEvent
            const endpointPath = me.data as string
            const baseUrl = this.config.url ?? 'http://localhost:3000'
            const endpoint = endpointPath.startsWith('http')
              ? endpointPath
              : `${baseUrl.replace(/\/$/, '')}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`

            logger.info(`[SSE:${this.config.name}] Discovered message endpoint: ${endpoint}`)
            es.close()
            resolve(endpoint)
          })

          es.onerror = () => {
            clearTimeout(timeout)
            es.close()
            reject(new Error(`Failed to connect to SSE endpoint: ${sseUrl}`))
          }
        })
      }
    } catch {
      // EventSource not available
    }

    clearTimeout(timer)
    return this.fallbackDiscoverEndpoint(sseUrl)
  }

  private async fallbackDiscoverEndpoint(sseUrl: string): Promise<string> {
    logger.info(`[SSE:${this.config.name}] EventSource not available, using fallback discovery`)

    const baseUrl = this.config.url ?? 'http://localhost:3000'

    const response = await fetch(sseUrl, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        ...this.config.headers,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok) {
      throw new Error(`SSE GET failed: ${response.status} ${response.statusText}`)
    }

    const text = await response.text()
    const endpointMatch = text.match(/data:\s*(\/[^\s\n]+)/)
    if (endpointMatch) {
      const endpointPath = endpointMatch[1]
      return endpointPath.startsWith('http')
        ? endpointPath
        : `${baseUrl.replace(/\/$/, '')}${endpointPath}`
    }

    logger.warn(`[SSE:${this.config.name}] Could not discover endpoint, using ${baseUrl} as message endpoint`)
    return baseUrl
  }

  private startEventStream(sseUrl: string): void {
    getEventSourceClass().then(EventSourceClass => {
      if (!EventSourceClass) {
        logger.info(`[SSE:${this.config.name}] EventSource not available, skipping persistent event stream`)
        return
      }

      const es = new EventSourceClass(sseUrl, {
        headers: this.config.headers,
      } as ConstructorParameters<typeof EventSource>[1])

      es.addEventListener('message', (event: Event) => {
        try {
          const me = event as MessageEvent
          const data = JSON.parse(me.data as string)
          this.pendingNotifications.push(data)
        } catch {
          logger.warn(`[SSE:${this.config.name}] Failed to parse SSE message`)
        }
      })

      es.onerror = () => {
        logger.warn(`[SSE:${this.config.name}] SSE event stream error`)
      }

      this.eventSource = es
    }).catch(() => {
      logger.info(`[SSE:${this.config.name}] EventSource not available, skipping persistent event stream`)
    })
  }

  private async readSSEResponse(response: Response): Promise<unknown> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body for SSE stream')

    const decoder = new TextDecoder()
    let buffer = ''
    let lastEventId: string | null = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('id:')) {
          lastEventId = line.substring(3).trim()
        } else if (line.startsWith('data:')) {
          const data = line.substring(5).trim()
          if (!data) continue

          try {
            const parsed = JSON.parse(data)
            if (parsed.id !== undefined) {
              return parsed
            }
          } catch {
            // skip non-JSON data lines
          }
        }
      }
    }

    if (buffer.trim()) {
      const dataMatch = buffer.match(/data:\s*(.+)/)
      if (dataMatch) {
        try {
          return JSON.parse(dataMatch[1])
        } catch {
          // ignore
        }
      }
    }

    throw new Error('SSE stream ended without a JSON-RPC response')
  }
}

class StreamableHTTPTransport implements MCPTransport {
  private config: MCPServerConfig
  private connected = false
  private sessionId: string | null = null
  private protocolVersion: string = MCP_PROTOCOL_VERSION
  private timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  private sseStream: { close(): void } | null = null

  constructor(config: MCPServerConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    const url = this.getEndpointUrl()
    logger.info(`[StreamableHTTP:${this.config.name}] Connecting to ${url}`)

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'MCP-Protocol-Version': this.protocolVersion,
          ...this.getSessionHeaders(),
          ...this.config.headers,
        },
        signal: AbortSignal.timeout(5000),
      })

      if (response.status === 405) {
        logger.info(`[StreamableHTTP:${this.config.name}] Server does not support standalone SSE stream (405), using POST-only mode`)
      } else if (response.ok && (response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        this.startServerStream(response)
      }
    } catch {
      logger.info(`[StreamableHTTP:${this.config.name}] GET endpoint not available, using POST-only mode`)
    }

    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false

    if (this.sseStream) {
      this.sseStream.close()
      this.sseStream = null
    }

    if (this.sessionId) {
      try {
        await fetch(this.getEndpointUrl(), {
          method: 'DELETE',
          headers: {
            'MCP-Protocol-Version': this.protocolVersion,
            ...this.getSessionHeaders(),
            ...this.config.headers,
          },
          signal: AbortSignal.timeout(3000),
        })
      } catch {
        // ignore
      }
      this.sessionId = null
    }
  }

  async send(request: unknown): Promise<unknown> {
    if (!this.connected) {
      throw new Error(`MCP StreamableHTTP server "${this.config.name}" is not connected`)
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.protocolVersion,
      ...this.getSessionHeaders(),
      ...this.config.headers,
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch(this.getEndpointUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      })

      if (response.status === 404 && this.sessionId) {
        logger.info(`[StreamableHTTP:${this.config.name}] Session expired (404), clearing session ID`)
        this.sessionId = null
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`StreamableHTTP POST failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`)
      }

      const newSessionId = response.headers.get('MCP-Session-Id')
      if (newSessionId) {
        this.sessionId = newSessionId
        logger.info(`[StreamableHTTP:${this.config.name}] Session ID: ${newSessionId}`)
      }

      const contentType = response.headers.get('content-type') ?? ''

      if (contentType.includes('text/event-stream')) {
        return this.readSSEStream(response)
      }

      if (contentType.includes('application/json')) {
        return response.json()
      }

      if (response.status === 202) {
        return { result: null }
      }

      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        return { result: text }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  private getEndpointUrl(): string {
    return this.config.url ?? 'http://localhost:3000/mcp'
  }

  private getSessionHeaders(): Record<string, string> {
    if (!this.sessionId) return {}
    return { 'MCP-Session-Id': this.sessionId }
  }

  private startServerStream(response: Response): void {
    const reader = response.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''

    const processStream = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line.startsWith('data:')) {
              const data = line.substring(5).trim()
              if (!data) continue
              try {
                const parsed = JSON.parse(data)
                logger.debug(`[StreamableHTTP:${this.config.name}] Server notification: ${parsed.method ?? 'response'}`)
              } catch {
                // skip
              }
            }
          }
        }
      } catch {
        // stream ended
      }
    }

    processStream()

    this.sseStream = {
      close: () => {
        reader.cancel().catch(() => {})
      },
    }
  }

  private async readSSEStream(response: Response): Promise<unknown> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body for SSE stream')

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('data:')) {
          const data = line.substring(5).trim()
          if (!data) continue

          try {
            const parsed = JSON.parse(data)
            if (parsed.id !== undefined) {
              return parsed
            }
            if (parsed.method) {
              logger.debug(`[StreamableHTTP:${this.config.name}] Server notification during stream: ${parsed.method}`)
            }
          } catch {
            // skip non-JSON data
          }
        }
      }
    }

    if (buffer.trim()) {
      const dataMatch = buffer.match(/data:\s*(.+)/)
      if (dataMatch) {
        try {
          return JSON.parse(dataMatch[1])
        } catch {
          // ignore
        }
      }
    }

    throw new Error('StreamableHTTP SSE stream ended without a JSON-RPC response')
  }
}

let _eventSourceClass: (typeof EventSource) | null | undefined = undefined

async function getEventSourceClass(): Promise<(typeof EventSource) | null> {
  if (_eventSourceClass !== undefined) return _eventSourceClass

  try {
    if (typeof globalThis.EventSource === 'function') {
      _eventSourceClass = globalThis.EventSource
      return _eventSourceClass
    }
  } catch {
    // not available
  }

  try {
    const mod = await import('eventsource')
    _eventSourceClass = mod.EventSource as typeof EventSource
    return _eventSourceClass
  } catch {
    _eventSourceClass = null
    return null
  }
}
