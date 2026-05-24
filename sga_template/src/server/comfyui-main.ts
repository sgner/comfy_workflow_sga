import { config as dotenvConfig } from 'dotenv'
import { resolve, join } from 'path'
import express from 'express'
import cors from 'cors'
import { createLogger } from '../utils/logger.js'
import { initFileLogging, shutdownFileLogging } from '../utils/logger.js'
import { getSessionStore, setSessionStore, SessionStore } from './session-store.js'
import {
  handleComfyUIChatStream,
  handleComfyUIChatHistory,
  handleComfyUIWorkflowAnalyze,
  handleComfyUIWorkflowParse,
  handleComfyUIActionExecute,
  handleComfyUIActionUndo,
  handleComfyUIListConfigs,
  handleComfyUICreateConfig,
  handleComfyUIGetConfig,
  handleComfyUIUpdateConfig,
  handleComfyUIDeleteConfig,
  handleComfyUISetDefaultConfig,
  handleComfyUIGetGitHubToken,
  handleComfyUIUpdateGitHubToken,
  handleComfyUIDeleteGitHubToken,
  handleComfyUIUserInput,
} from './comfyui-routes.js'
import {
  handleListMCPServers,
  handleGetMCPServer,
  handleAddMCPServer,
  handleDeleteMCPServer,
  handleConnectMCPServer,
  handleDisconnectMCPServer,
  handleListMCPTools,
  handleListSkills,
  handleDiscoverSkills,
  handleGetSkill,
  handleAddSkill,
  handleDeleteSkill,
} from './skills-mcp-routes.js'
import { ComfyUIConfigStore } from './comfyui-config-store.js'

dotenvConfig({ path: resolve(process.cwd(), '.env'), override: true })

const logger = createLogger('comfyui-main')

export interface ComfyUIServerConfig {
  port?: number
  host?: string
  corsOrigin?: string | string[]
  apiKey?: string
}

export async function createComfyUIApp(config: ComfyUIServerConfig = {}): Promise<express.Application> {
  const { initBundledSkills } = await import('../skills/index.js')
  const { loadMCPServersFromConfig } = await import('../mcp/index.js')
  const { loadProvidersFromEnv, loadProvidersFromConfig } = await import('../providers/provider-store.js')
  const { readFile } = await import('fs/promises')
  const { existsSync } = await import('fs')
  const { initMemoryManager } = await import('../memory/manager.js')
  const { getMemoryManager } = await import('../memory/manager.js')
  const { getSgaHome, migrateIfNeeded } = await import('../memory/paths.js')

  migrateIfNeeded()

  initBundledSkills()

  const sessionStore = new SessionStore(
    process.env.SESSION_DIR ?? join(process.cwd(), 'data', 'sessions')
  )
  setSessionStore(sessionStore)
  await sessionStore.init()

  await initMemoryManager({
    pathConfig: {
      projectRoot: process.cwd(),
    },
  })

  await loadProvidersFromEnv()

  const providersConfigPath = join(getSgaHome(), 'providers.json')
  if (existsSync(providersConfigPath)) {
    try {
      const content = await readFile(providersConfigPath, 'utf-8')
      const parsed = JSON.parse(content) as { providers: import('../providers/provider-store.js').StoredProviderConfig[]; defaultProvider?: string }
      if (parsed.providers && Array.isArray(parsed.providers)) {
        await loadProvidersFromConfig(parsed.providers, parsed.defaultProvider)
      }
    } catch {
      // ignore
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
      // ignore
    }
  }

  const mcpConfigPath = join(getSgaHome(), 'mcp-servers.json')
  if (existsSync(mcpConfigPath)) {
    try {
      const content = await readFile(mcpConfigPath, 'utf-8')
      const configs = JSON.parse(content) as Array<import('../mcp/index.js').MCPServerConfig>
      loadMCPServersFromConfig(configs)
    } catch {
      // ignore
    }
  }

  const { connectAllMCPServers } = await import('../mcp/index.js')
  try {
    const connectedServers = await connectAllMCPServers()
    if (connectedServers.length > 0) {
      const successCount = connectedServers.filter(s => s.status === 'connected').length
      logger.info(`MCP servers: ${successCount}/${connectedServers.length} connected`)
    }
  } catch {
    // MCP connection failures are non-fatal
  }

  const { getDefaultProvider } = await import('../providers/provider-store.js')
  const defaultProvider = getDefaultProvider()
  if (defaultProvider) {
    const memoryManager = getMemoryManager()
    if (memoryManager) {
      memoryManager.setProvider(defaultProvider, defaultProvider.config.defaultModel)
    }
  }

  const configStore = new ComfyUIConfigStore()
  const githubToken = configStore.getGitHubToken()
  if (githubToken) {
    process.env.GITHUB_TOKEN = githubToken
  }

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

  // ComfyUI Frontend Compatible Routes
  app.post('/api/chat/stream', handleComfyUIChatStream)
  app.get('/api/chat/history/:sessionId', handleComfyUIChatHistory)

  app.post('/api/workflow/parse', handleComfyUIWorkflowParse)
  app.post('/api/workflow/analyze', handleComfyUIWorkflowAnalyze)

  app.post('/api/actions/execute', handleComfyUIActionExecute)
  app.post('/api/actions/undo', handleComfyUIActionUndo)
  app.post('/api/user-input', handleComfyUIUserInput)

  app.get('/api/configs', handleComfyUIListConfigs)
  app.post('/api/configs', handleComfyUICreateConfig)
  app.get('/api/configs/:configId', handleComfyUIGetConfig)
  app.put('/api/configs/:configId', handleComfyUIUpdateConfig)
  app.delete('/api/configs/:configId', handleComfyUIDeleteConfig)
  app.post('/api/configs/set-default', handleComfyUISetDefaultConfig)

  app.get('/api/github-token', handleComfyUIGetGitHubToken)
  app.put('/api/github-token', handleComfyUIUpdateGitHubToken)
  app.delete('/api/github-token', handleComfyUIDeleteGitHubToken)

  // MCP Server Routes
  app.get('/api/mcp/servers', handleListMCPServers)
  app.get('/api/mcp/servers/:name', handleGetMCPServer)
  app.post('/api/mcp/servers', handleAddMCPServer)
  app.delete('/api/mcp/servers/:name', handleDeleteMCPServer)
  app.post('/api/mcp/servers/:name/connect', handleConnectMCPServer)
  app.post('/api/mcp/servers/:name/disconnect', handleDisconnectMCPServer)
  app.get('/api/mcp/tools', handleListMCPTools)

  // Skills Routes
  app.get('/api/skills', handleListSkills)
  app.get('/api/skills/discover', handleDiscoverSkills)
  app.get('/api/skills/:name', handleGetSkill)
  app.post('/api/skills', handleAddSkill)
  app.delete('/api/skills/:name', handleDeleteSkill)

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'comfyui-workflow-agent', version: '2.0.0' })
  })

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  return app
}

export async function startComfyUIServer(config: ComfyUIServerConfig = {}): Promise<void> {
  const logDir = process.env.LOG_DIR ?? resolve(process.cwd(), 'logs')
  const enableFileLog = process.env.LOG_ENABLE_FILE !== 'false'
  initFileLogging(logDir, enableFileLog)

  const port = config.port ?? parseInt(process.env.PORT ?? '8000', 10)
  const host = config.host ?? (process.env.HOST ?? '127.0.0.1')

  const app = await createComfyUIApp(config)

  app.listen(port, host, () => {
    console.log('=' .repeat(60))
    console.log('🚀 Starting ComfyUI Workflow Agent Backend Server')
    console.log('=' .repeat(60))
    console.log(`📡 Host: ${host}`)
    console.log(`🔌 Port: ${port}`)
    console.log(`📚 API: http://${host}:${port}/api/health`)
    console.log('=' .repeat(60))
    console.log(`✅ Backend server is running on http://${host}:${port}`)
    console.log(`⏰ Started at: ${new Date().toISOString()}`)
    console.log('=' .repeat(60))
  })

  const { getSessionStore: getStore } = await import('./session-store.js')
  async function gracefulShutdown(): Promise<void> {
    const store = getStore()
    await store.shutdown()
    shutdownFileLogging()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    gracefulShutdown().catch(() => process.exit(1))
  })

  process.on('SIGTERM', () => {
    gracefulShutdown().catch(() => process.exit(1))
  })
}

startComfyUIServer().catch((err: unknown) => {
  console.error('Failed to start ComfyUI server:', err)
  process.exit(1)
})
