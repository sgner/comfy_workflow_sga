import express from 'express'
import cors from 'cors'
import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'

// 必须在所有依赖 env 的代码之前执行:从 sga_template/.env(及 cwd/.env)加载 SGA_HOME 等环境变量
// 注意:历史代码把 dotenvConfig 放在 routes.ts 模块顶部,但 app.ts 在 routes.ts 之前就已经调用了
// getSgaHome()/migrateIfNeeded(),导致 process.env.SGA_HOME 还没被设置,回退到了 ~/.sga
try {
  dotenvConfig({ path: resolve(process.cwd(), '.env'), override: true })
  // 兜底: sga_template 内部自带的 .env(用于开发模式,跑 npx tsx 时 cwd 不是 sga_template)
  const sgaTemplateEnv = resolve(process.cwd(), 'sga_template', '.env')
  if (sgaTemplateEnv !== resolve(process.cwd(), '.env')) {
    dotenvConfig({ path: sgaTemplateEnv, override: false })
  }
} catch {
  // dotenv 可选,加载失败不影响主流程
}
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
  handleCreateAgent,
  handleCoordinate,
  handleGeneratePlan,
  handleListSnapshots,
  handleResumePlan,
  // Sprint 1+2: AgentBackend 相关
  handleListBackends,
  handleBackendsHealth,
  handleCodexBuildStatus,
  handleCodexStatus,
  handleSystemDiagnostics,
  handleGetSessionAgent,
  handleGetHandoffStatus,
  handleSwitchSessionAgent,
  handleSwitchSessionAgentStable,
  handleClearHandoff,
  handleListTasks,
  handleGetTask,
  handleKillTask,
  handleTaskNotifications,
  handleListTools,
  handleListConfiguredProviders,
  handleAddProvider,
  handleRemoveProvider,
  handleSetDefaultProvider,
  handleVerifyProviderAddress,
  handleVerifyProviderProtocol,
  handleFetchProviderModels,
  handleVerifyAndAddProvider,
  handleHealth,
  handleGetPermissionRules,
  handleUpdatePermissionMode,
  handleAddPermissionRule,
  handleRemovePermissionRule,
  handleCheckPermission,
  handleListHooks,
  handleAddHook,
  handleRemoveHook,
  handleTestHook,
  handleClassifyPermission,
  handleComfyUIChatStream,
  handleComfyUIChatHistory,
  handleComfyUIChatAbort,
  handleComfyUIWorkflowParse,
  handleComfyUIWorkflowAnalyze,
  handleComfyUIActionExecute,
  handleComfyUIActionUndo,
  handleComfyUIUserInput,
  handleComfyUIListConfigs,
  handleComfyUICreateConfig,
  handleComfyUIGetConfig,
  handleComfyUIUpdateConfig,
  handleComfyUIDeleteConfig,
  handleComfyUISetDefaultConfig,
  handleComfyUIGetGitHubToken,
  handleComfyUIUpdateGitHubToken,
  handleComfyUIDeleteGitHubToken,
  handleComfyUIFork,
  handleComfyUICoordinator,
  handleComfyUIAutoDream,
  handleComfyUICost,
  handleListFeatureGates,
  handleGetFeatureGate,
  handleOverrideFeatureGate,
  handleResetFeatureGate,
  handleResetAllFeatureGates,
  handleRegisterFeatureGate,
  handleGetTelemetryStatus,
  handleToggleTelemetry,
  handleFlushTelemetry,
  handleGetTelemetryEvents,
  handleClassifyBashCommand,
  handleClassifyError,
  handlePreviewSystemPrompt,
  handleGetConfig,
  handleGetConfigSection,
  handleGetCostTracker,
  handleSetBudget,
  handleListMemories,
  handleGetMemory,
  handleSearchMemories,
  handleDeleteMemory,
  handleExtractMemories,
  handleGetCircuitBreakerStatus,
  handleResetCircuitBreaker,
  handleGetContextBudget,
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
  app.post(`${base}/agents`, handleCreateAgent)
  app.post(`${base}/coordinate`, handleCoordinate)
  app.post(`${base}/coordinate/plan`, handleGeneratePlan)
  app.get(`${base}/coordinate/snapshots`, handleListSnapshots)
  app.post(`${base}/coordinate/resume`, handleResumePlan)

  // ===== Sprint 1+2: Agent Backend (SGA / Codex) =====
  app.get(`${base}/backends`, handleListBackends)
  app.get(`${base}/backends/health`, handleBackendsHealth)
  app.get(`${base}/codex/build-status`, handleCodexBuildStatus)
  app.get(`${base}/codex/status`, handleCodexStatus)
  app.get(`${base}/diagnostics`, handleSystemDiagnostics)
  app.get(`${base}/sessions/:sessionId/agent`, handleGetSessionAgent)
  app.post(`${base}/sessions/:sessionId/agent`, handleSwitchSessionAgentStable)
  app.get(`${base}/sessions/:sessionId/handoff/status`, handleGetHandoffStatus)
  app.delete(`${base}/sessions/:sessionId/handoff`, handleClearHandoff)

  app.get(`${base}/tasks`, handleListTasks)
  app.get(`${base}/tasks/:taskId`, handleGetTask)
  app.delete(`${base}/tasks/:taskId`, handleKillTask)
  app.get(`${base}/tasks/notifications`, handleTaskNotifications)
  app.get(`${base}/tools`, handleListTools)

  app.get(`${base}/permissions/rules`, handleGetPermissionRules)
  app.put(`${base}/permissions/mode`, handleUpdatePermissionMode)
  app.post(`${base}/permissions/rules`, handleAddPermissionRule)
  app.delete(`${base}/permissions/rules`, handleRemovePermissionRule)
  app.post(`${base}/permissions/check`, handleCheckPermission)

  app.get(`${base}/hooks`, handleListHooks)
  app.post(`${base}/hooks`, handleAddHook)
  app.delete(`${base}/hooks`, handleRemoveHook)
  app.post(`${base}/hooks/test`, handleTestHook)

  app.post(`${base}/permissions/classify`, handleClassifyPermission)

  app.get(`${base}/feature-gates`, handleListFeatureGates)
  app.get(`${base}/feature-gates/:name`, handleGetFeatureGate)
  app.post(`${base}/feature-gates/override`, handleOverrideFeatureGate)
  app.post(`${base}/feature-gates/reset`, handleResetFeatureGate)
  app.post(`${base}/feature-gates/reset-all`, handleResetAllFeatureGates)
  app.post(`${base}/feature-gates`, handleRegisterFeatureGate)

  app.get(`${base}/telemetry/status`, handleGetTelemetryStatus)
  app.post(`${base}/telemetry/toggle`, handleToggleTelemetry)
  app.post(`${base}/telemetry/flush`, handleFlushTelemetry)
  app.get(`${base}/telemetry/events`, handleGetTelemetryEvents)

  app.post(`${base}/classify/bash`, handleClassifyBashCommand)
  app.post(`${base}/classify/error`, handleClassifyError)

  app.post(`${base}/system-prompt/preview`, handlePreviewSystemPrompt)

  app.get(`${base}/config`, handleGetConfig)
  app.get(`${base}/config/:section`, handleGetConfigSection)

  app.get(`${base}/sessions/:sessionId/cost`, handleGetCostTracker)
  app.put(`${base}/sessions/:sessionId/budget`, handleSetBudget)

  app.get(`${base}/memories`, handleListMemories)
  app.get(`${base}/memories/:name`, handleGetMemory)
  app.post(`${base}/memories/search`, handleSearchMemories)
  app.delete(`${base}/memories/:scope`, handleDeleteMemory)
  app.post(`${base}/memories/extract`, handleExtractMemories)

  app.get(`${base}/circuit-breaker`, handleGetCircuitBreakerStatus)
  app.post(`${base}/circuit-breaker/reset`, handleResetCircuitBreaker)

  app.get(`${base}/context-budget`, handleGetContextBudget)

  app.get(`${base}/providers`, handleListConfiguredProviders)
  app.post(`${base}/providers`, handleAddProvider)
  app.delete(`${base}/providers/:name`, handleRemoveProvider)
  app.put(`${base}/providers/:name/default`, handleSetDefaultProvider)
  app.post(`${base}/providers/verify-address`, handleVerifyProviderAddress)
  app.post(`${base}/providers/verify-protocol`, handleVerifyProviderProtocol)
  app.post(`${base}/providers/fetch-models`, handleFetchProviderModels)
  app.post(`${base}/providers/verify-and-add`, handleVerifyAndAddProvider)

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

  app.post('/api/chat/stream', handleComfyUIChatStream)
  app.get('/api/chat/history/:sessionId', handleComfyUIChatHistory)
  app.post('/api/chat/abort/:sessionId', handleComfyUIChatAbort)

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

  app.post('/api/fork', handleComfyUIFork)
  app.post('/api/coordinator', handleComfyUICoordinator)
  app.post('/api/auto-dream', handleComfyUIAutoDream)
  app.get('/api/cost', handleComfyUICost)

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'comfyui-workflow-agent', version: '2.0.0' })
  })

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  return app
}

export async function startServer(config: ServerConfig = {}): Promise<void> {
  const { initBundledSkills } = await import('../skills/index.js')
  const { loadMCPServersFromConfig } = await import('../mcp/index.js')
  const { loadProvidersFromEnv, loadProvidersFromConfig } = await import('../providers/provider-store.js')
  const { getSessionStore, setSessionStore, SessionStore } = await import('./session-store.js')
  const { readFile } = await import('fs/promises')
  const { join } = await import('path')
  const { homedir } = await import('os')
  const { existsSync } = await import('fs')
  const { migrateIfNeeded } = await import('../memory/paths.js')

  // 检查并执行数据迁移（当 SGA_HOME 被显式配置时）
  migrateIfNeeded()

  initBundledSkills()

  const sessionStore = new SessionStore(
    process.env.SESSION_DIR ?? join(process.cwd(), 'data', 'sessions')
  )
  setSessionStore(sessionStore)
  await sessionStore.init()

  const { initMemoryManager } = await import('../memory/manager.js')
  const { getMemoryManager } = await import('../memory/manager.js')
  const { getSgaHome } = await import('../memory/paths.js')
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

  const mcpConfigPath = join(getSgaHome(), 'mcp-servers.json')
  if (existsSync(mcpConfigPath)) {
    try {
      const content = await readFile(mcpConfigPath, 'utf-8')
      const configs = JSON.parse(content) as Array<import('../mcp/index.js').MCPServerConfig>
      loadMCPServersFromConfig(configs)
    } catch {
      // ignore invalid config
    }
  }

  try {
    const { registerMCPServer } = await import('../mcp/index.js')
    const comfyuiMcpConfig: import('../mcp/index.js').MCPServerConfig = {
      name: 'comfyui',
      command: 'npx',
      args: ['tsx', join(process.cwd(), 'src', 'comfyui', 'mcp-server', 'index.ts')],
      transport: 'stdio',
      restartOnFailure: true,
      maxRestartAttempts: 3,
      disabled: false,
      alwaysAllow: ['comfyui_list_models', 'comfyui_get_queue', 'comfyui_get_history', 'comfyui_get_system_stats', 'comfyui_list_nodes'],
    }
    registerMCPServer(comfyuiMcpConfig)
  } catch {
    // ComfyUI MCP server registration is optional
  }

  const { connectAllMCPServers } = await import('../mcp/index.js')
  try {
    const connectedServers = await connectAllMCPServers()
    if (connectedServers.length > 0) {
      const successCount = connectedServers.filter(s => s.status === 'connected').length
      console.log(`[sga-template] MCP servers: ${successCount}/${connectedServers.length} connected`)
    }
  } catch {
    // MCP connection failures are non-fatal
  }

  try {
    const { initTelemetry } = await import('../telemetry/index.js')
    const { FeatureGateManager } = await import('../feature-gate/index.js')
    const gate = FeatureGateManager.getInstance()
    gate.override('telemetry', true)
    initTelemetry({ enabled: true })
  } catch {
    // telemetry initialization is optional
  }

  try {
    const { ensureComfyUITeam } = await import('../comfyui/team-config.js')
    await ensureComfyUITeam(process.cwd())
  } catch {
    // ComfyUI team initialization is optional
  }

  const { getDefaultProvider } = await import('../providers/provider-store.js')
  const defaultProvider = getDefaultProvider()
  if (defaultProvider) {
    const memoryManager = getMemoryManager()
    if (memoryManager) {
      memoryManager.setProvider(defaultProvider, defaultProvider.config.defaultModel)
    }
  }

  const { getComfyUIConfigStore } = await import('./routes.js')
  const configStore = getComfyUIConfigStore()
  const githubToken = configStore.getGitHubToken()
  if (githubToken) {
    process.env.GITHUB_TOKEN = githubToken
  }

  const port = config.port ?? 3000
  const host = config.host ?? '0.0.0.0'
  const app = createApp(config)

  app.listen(port, host, () => {
    console.log(`[sga-template] Server running at http://${host}:${port}`)
    console.log(`[sga-template] API base path: ${config.basePath ?? '/api/v1'}`)
    console.log(`[sga-template] Health check: http://${host}:${port}${config.basePath ?? '/api/v1'}/health`)

    // Sprint 1+2: 启动 BackendRegistry, 默认 SGA backend 启动
    ;(async () => {
      try {
        const { getBackendRegistry, getSgaBackend } = await import('../agents/index.js')
        const registry = getBackendRegistry()
        registry.init()
        // 预热 SGA backend (Codex 暂不启动, 等 Sprint 3)
        try {
          await getSgaBackend().start({ cwd: process.cwd() })
          console.log('[sga-template] AgentBackend (SGA) started')
        } catch (err) {
          console.warn(`[sga-template] SGA backend warmup failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      } catch (err) {
        console.error(`[sga-template] BackendRegistry init failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  })
}
