import express from 'express'
import cors from 'cors'
import {
  handleListSessions,
  handleCreateSession,
  handleGetSession,
  handleDeleteSession,
  handleSendMessage,
  handleUserInput,
  handleGetMessages,
  handleGetUsage,
  handleListAgents,
  handleListTools,
  handleListConfiguredProviders,
  handleAddProvider,
  handleRemoveProvider,
  handleSetDefaultProvider,
  handleHealth,
} from './routes.js'
import {
  handleListSkills,
  handleDiscoverSkills,
  handleGetSkill,
  handleAddSkill,
  handleDeleteSkill,
  handleListMCPServers,
  handleGetMCPServer,
  handleAddMCPServer,
  handleDeleteMCPServer,
  handleConnectMCPServer,
  handleDisconnectMCPServer,
  handleListMCPTools,
} from './skills-mcp-routes.js'

export interface ServerConfig {
  port?: number
  host?: string
  corsOrigin?: string | string[]
  apiKey?: string
  basePath?: string
}

export function createApp(config: ServerConfig = {}): express.Application {
  const app = express()

  app.use(cors({
    origin: config.corsOrigin ?? '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  }))

  app.use(express.json({ limit: '10mb' }))

  if (config.apiKey) {
    app.use((req, _res, next) => {
      if (req.method === 'OPTIONS') {
        next()
        return
      }
      const authHeader = req.headers.authorization
      const apiKeyHeader = req.headers['x-api-key']
      const queryKey = req.query.apiKey

      const providedKey = authHeader?.replace('Bearer ', '') ?? apiKeyHeader ?? queryKey
      if (providedKey !== config.apiKey) {
        _res.status(401).json({ error: 'Unauthorized: Invalid API key' })
        return
      }
      next()
    })
  }

  const base = config.basePath ?? '/api/v1'

  app.get(`${base}/health`, handleHealth)

  app.get(`${base}/sessions`, handleListSessions)
  app.post(`${base}/sessions`, handleCreateSession)
  app.get(`${base}/sessions/:sessionId`, handleGetSession)
  app.delete(`${base}/sessions/:sessionId`, handleDeleteSession)

  app.post(`${base}/sessions/:sessionId/messages`, handleSendMessage)
  app.post(`${base}/sessions/:sessionId/input`, handleUserInput)
  app.get(`${base}/sessions/:sessionId/messages`, handleGetMessages)
  app.get(`${base}/sessions/:sessionId/usage`, handleGetUsage)

  app.get(`${base}/agents`, handleListAgents)
  app.get(`${base}/tools`, handleListTools)

  app.get(`${base}/providers`, handleListConfiguredProviders)
  app.post(`${base}/providers`, handleAddProvider)
  app.delete(`${base}/providers/:name`, handleRemoveProvider)
  app.put(`${base}/providers/:name/default`, handleSetDefaultProvider)

  app.get(`${base}/skills`, handleListSkills)
  app.get(`${base}/skills/discover`, handleDiscoverSkills)
  app.get(`${base}/skills/:name`, handleGetSkill)
  app.post(`${base}/skills`, handleAddSkill)
  app.delete(`${base}/skills/:name`, handleDeleteSkill)

  app.get(`${base}/mcp/servers`, handleListMCPServers)
  app.get(`${base}/mcp/servers/:name`, handleGetMCPServer)
  app.post(`${base}/mcp/servers`, handleAddMCPServer)
  app.delete(`${base}/mcp/servers/:name`, handleDeleteMCPServer)
  app.post(`${base}/mcp/servers/:name/connect`, handleConnectMCPServer)
  app.post(`${base}/mcp/servers/:name/disconnect`, handleDisconnectMCPServer)
  app.get(`${base}/mcp/tools`, handleListMCPTools)

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  return app
}

export async function startServer(config: ServerConfig = {}): Promise<void> {
  const { initBundledSkills } = await import('../skills/index.js')
  const { loadMCPServersFromConfig } = await import('../mcp/index.js')
  const { loadProvidersFromEnv, loadProvidersFromConfig } = await import('../providers/provider-store.js')
  const { readFile } = await import('fs/promises')
  const { join } = await import('path')
  const { homedir } = await import('os')
  const { existsSync } = await import('fs')

  initBundledSkills()

  await loadProvidersFromEnv()

  const providersConfigPath = join(homedir(), '.sga-template', 'providers.json')
  if (existsSync(providersConfigPath)) {
    try {
      const content = await readFile(providersConfigPath, 'utf-8')
      const parsed = JSON.parse(content) as { providers: import('../providers/provider-store.js').StoredProviderConfig[]; defaultProvider?: string }
      if (parsed.providers && Array.isArray(parsed.providers)) {
        await loadProvidersFromConfig(parsed.providers, parsed.defaultProvider)
      }
    } catch {
      // ignore invalid config
    }
  }

  const localProvidersPath = join(process.cwd(), 'sga-providers.json')
  if (existsSync(localProvidersPath)) {
    try {
      const content = await readFile(localProvidersPath, 'utf-8')
      const parsed = JSON.parse(content) as { providers: import('../providers/provider-store.js').StoredProviderConfig[]; defaultProvider?: string }
      if (parsed.providers && Array.isArray(parsed.providers)) {
        await loadProvidersFromConfig(parsed.providers, parsed.defaultProvider)
      }
    } catch {
      // ignore invalid config
    }
  }

  const mcpConfigPath = join(homedir(), '.sga-template', 'mcp-servers.json')
  if (existsSync(mcpConfigPath)) {
    try {
      const content = await readFile(mcpConfigPath, 'utf-8')
      const configs = JSON.parse(content) as Array<import('../mcp/index.js').MCPServerConfig>
      loadMCPServersFromConfig(configs)
    } catch {
      // ignore invalid config
    }
  }

  const port = config.port ?? 3000
  const host = config.host ?? '0.0.0.0'
  const app = createApp(config)

  app.listen(port, host, () => {
    console.log(`[sga-template] Server running at http://${host}:${port}`)
    console.log(`[sga-template] API base path: ${config.basePath ?? '/api/v1'}`)
    console.log(`[sga-template] Health check: http://${host}:${port}${config.basePath ?? '/api/v1'}/health`)
  })
}
