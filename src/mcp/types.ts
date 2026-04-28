export interface MCPServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  url?: string
  headers?: Record<string, string>
  restartOnFailure?: boolean
  maxRestartAttempts?: number
}

export interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  serverName: string
}

export interface MCPResource {
  name: string
  uri: string
  description?: string
  mimeType?: string
  serverName: string
}

export interface MCPPrompt {
  name: string
  description?: string
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>
  serverName: string
}

export interface MCPCallResult {
  content: Array<{
    type: 'text' | 'image' | 'resource'
    text?: string
    data?: string
    mimeType?: string
    resource?: { uri: string; mimeType?: string; text?: string }
  }>
  isError?: boolean
}
