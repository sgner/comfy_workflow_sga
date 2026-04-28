import type { Request, Response } from 'express'
import { registerBundledSkill, getAllBundledSkills, getBundledSkill, bundledSkillToDefinition, saveSkillToDir, getUserSkillsDir, getProjectSkillsDir, type BundledSkillConfig } from '../skills/bundled-registry.js'
import { discoverSkills, type SkillDiscoveryConfig } from '../skills/discovery.js'
import type { SkillDefinition } from '../skills/types.js'
import { registerMCPServer, unregisterMCPServer, getMCPServer, getAllMCPServers, getAllMCPTools, connectMCPServer, disconnectMCPServer, type MCPServerConfig } from '../mcp/index.js'
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'

function getParam(req: Request, name: string): string {
  const val = req.params[name]
  return Array.isArray(val) ? val[0] ?? '' : val ?? ''
}

export function handleListSkills(_req: Request, res: Response): void {
  const bundled = getAllBundledSkills().map(s => bundledSkillToDefinition(s))
  res.json({
    skills: bundled.map(s => ({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      userInvocable: s.userInvocable,
      source: s.source,
      argumentHint: s.argumentHint,
    })),
    total: bundled.length,
  })
}

export async function handleDiscoverSkills(_req: Request, res: Response): Promise<void> {
  try {
    const config: SkillDiscoveryConfig = {
      userDir: getUserSkillsDir(),
      projectDirs: [getProjectSkillsDir()],
    }
    const skills = await discoverSkills(config)
    res.json({
      skills: skills.map(s => ({
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse,
        userInvocable: s.userInvocable,
        source: s.source,
        loadedFrom: s.loadedFrom,
        argumentHint: s.argumentHint,
      })),
      total: skills.length,
    })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
}

export function handleGetSkill(req: Request, res: Response): void {
  const name = getParam(req, 'name')
  const skill = getBundledSkill(name)
  if (!skill) {
    res.status(404).json({ error: `Skill "${name}" not found` })
    return
  }
  const def = bundledSkillToDefinition(skill)
  res.json({ skill: def })
}

export async function handleAddSkill(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    name?: string
    description?: string
    whenToUse?: string
    prompt?: string
    allowedTools?: string[]
    userInvocable?: boolean
    disableModelInvocation?: boolean
    context?: 'inline' | 'fork'
    argumentHint?: string
    saveTo?: 'user' | 'project' | 'memory'
  }

  if (!body.name || !body.description || !body.prompt) {
    res.status(400).json({ error: 'name, description, and prompt are required' })
    return
  }

  const config: BundledSkillConfig = {
    name: body.name,
    description: body.description,
    whenToUse: body.whenToUse,
    prompt: body.prompt,
    allowedTools: body.allowedTools,
    userInvocable: body.userInvocable ?? true,
    disableModelInvocation: body.disableModelInvocation ?? false,
    context: body.context,
    argumentHint: body.argumentHint,
  }

  registerBundledSkill(config)

  const saveTo = body.saveTo ?? 'memory'
  let savedPath: string | undefined

  if (saveTo === 'user') {
    const userDir = getUserSkillsDir()
    savedPath = await saveSkillToDir(config, userDir)
  } else if (saveTo === 'project') {
    const projectDir = getProjectSkillsDir()
    savedPath = await saveSkillToDir(config, projectDir)
  }

  res.status(201).json({
    success: true,
    skill: {
      name: config.name,
      description: config.description,
      savedTo: savedPath ?? 'memory only (not persisted to disk)',
    },
  })
}

export async function handleDeleteSkill(req: Request, res: Response): Promise<void> {
  const name = getParam(req, 'name')
  const source = req.query.source as string | undefined

  if (source === 'user' || source === 'project') {
    const baseDir = source === 'user' ? getUserSkillsDir() : getProjectSkillsDir()
    const skillDir = join(baseDir, name)
    if (existsSync(skillDir)) {
      await rm(skillDir, { recursive: true, force: true })
      res.json({ success: true, message: `Skill "${name}" deleted from ${source} directory` })
      return
    }
    res.status(404).json({ error: `Skill directory not found: ${skillDir}` })
    return
  }

  res.status(400).json({ error: 'Specify source query parameter: "user" or "project"' })
}

export function handleListMCPServers(_req: Request, res: Response): void {
  const servers = getAllMCPServers().map(s => ({
    name: s.name,
    status: s.status,
    transport: s.config.transport,
    command: s.config.command,
    url: s.config.url,
    toolCount: s.tools.length,
    error: s.error,
    connectedAt: s.connectedAt,
  }))
  res.json({ servers, total: servers.length })
}

export function handleGetMCPServer(req: Request, res: Response): void {
  const name = getParam(req, 'name')
  const server = getMCPServer(name)
  if (!server) {
    res.status(404).json({ error: `MCP server "${name}" not found` })
    return
  }
  res.json({
    server: {
      name: server.name,
      status: server.status,
      config: {
        command: server.config.command,
        args: server.config.args,
        transport: server.config.transport,
        url: server.config.url,
        disabled: server.config.disabled,
        alwaysAllow: server.config.alwaysAllow,
      },
      tools: server.tools,
      resources: server.resources,
      error: server.error,
      connectedAt: server.connectedAt,
    },
  })
}

export async function handleAddMCPServer(req: Request, res: Response): Promise<void> {
  const body = req.body as MCPServerConfig & { autoConnect?: boolean; saveToConfig?: boolean }

  if (!body.name || !body.command) {
    res.status(400).json({ error: 'name and command are required' })
    return
  }

  if (!['stdio', 'sse', 'streamable-http'].includes(body.transport)) {
    res.status(400).json({ error: 'transport must be one of: stdio, sse, streamable-http' })
    return
  }

  const state = registerMCPServer(body)

  if (body.autoConnect) {
    try {
      await connectMCPServer(body.name)
    } catch (error) {
      res.status(201).json({
        success: true,
        server: {
          name: state.name,
          status: state.status,
          error: state.error,
        },
        warning: `Server registered but connection failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
  }

  if (body.saveToConfig) {
    await saveMCPServerConfig(body)
  }

  res.status(201).json({
    success: true,
    server: {
      name: state.name,
      status: state.status,
      transport: state.config.transport,
      toolCount: state.tools.length,
    },
  })
}

export async function handleDeleteMCPServer(req: Request, res: Response): Promise<void> {
  const name = getParam(req, 'name')
  const success = unregisterMCPServer(name)
  if (!success) {
    res.status(404).json({ error: `MCP server "${name}" not found` })
    return
  }
  res.json({ success: true, message: `MCP server "${name}" removed` })
}

export async function handleConnectMCPServer(req: Request, res: Response): Promise<void> {
  const name = getParam(req, 'name')
  try {
    const server = await connectMCPServer(name)
    res.json({
      success: true,
      server: {
        name: server.name,
        status: server.status,
        toolCount: server.tools.length,
        tools: server.tools.map(t => t.name),
      },
    })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
}

export async function handleDisconnectMCPServer(req: Request, res: Response): Promise<void> {
  const name = getParam(req, 'name')
  await disconnectMCPServer(name)
  res.json({ success: true, message: `MCP server "${name}" disconnected` })
}

export function handleListMCPTools(_req: Request, res: Response): void {
  const tools = getAllMCPTools()
  res.json({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      serverName: t.serverName,
      inputSchema: t.inputSchema,
    })),
    total: tools.length,
  })
}

async function saveMCPServerConfig(config: MCPServerConfig): Promise<void> {
  const configDir = join(homedir(), '.cc-contron')
  await mkdir(configDir, { recursive: true })
  const configPath = join(configDir, 'mcp-servers.json')

  let existing: MCPServerConfig[] = []
  if (existsSync(configPath)) {
    try {
      const content = await readFile(configPath, 'utf-8')
      existing = JSON.parse(content) as MCPServerConfig[]
    } catch {
      existing = []
    }
  }

  const idx = existing.findIndex(s => s.name === config.name)
  if (idx >= 0) {
    existing[idx] = config
  } else {
    existing.push(config)
  }

  await writeFile(configPath, JSON.stringify(existing, null, 2), 'utf-8')
}
