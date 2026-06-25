import type { Request, Response } from 'express'
import {
  getAllMCPServers,
  getMCPServer,
  registerMCPServer,
  unregisterMCPServer,
  connectMCPServer,
  disconnectMCPServer,
  getAllMCPTools,
  persistMCPServers,
} from '../mcp/index.js'
import {
  getAllBundledSkills,
  getBundledSkill,
  discoverSkills,
  registerBundledSkill,
  saveSkillToDir,
  getUserSkillsDir,
} from '../skills/index.js'
import type { MCPServerConfig } from '../mcp/types.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('skills-mcp-routes')

function getParam(req: Request, name: string): string {
  const val = req.params[name]
  return Array.isArray(val) ? val[0] : val
}

export async function handleListMCPServers(_req: Request, res: Response): Promise<void> {
  try {
    const servers = getAllMCPServers().map(s => ({
      name: s.name,
      status: s.status,
      transport: s.config.transport || (s.config.command ? 'stdio' : 'sse'),
      command: s.config.command,
      url: s.config.url,
      toolCount: s.tools.length,
      error: s.error,
      connectedAt: s.connectedAt ? new Date(s.connectedAt).toISOString() : undefined,
    }))
    res.json(servers)
  } catch (error) {
    logger.error('Failed to list MCP servers', error)
    res.status(500).json({ error: 'Failed to list MCP servers' })
  }
}

export async function handleGetMCPServer(req: Request, res: Response): Promise<void> {
  try {
    const serverName = getParam(req, 'name')
    const server = getMCPServer(serverName)
    if (!server) {
      res.status(404).json({ error: 'MCP server not found' })
      return
    }
    res.json({
      name: server.name,
      status: server.status,
      transport: server.config.transport || (server.config.command ? 'stdio' : 'sse'),
      command: server.config.command,
      url: server.config.url,
      toolCount: server.tools.length,
      tools: server.tools.map(t => ({ name: t.name, description: t.description })),
      error: server.error,
      connectedAt: server.connectedAt ? new Date(server.connectedAt).toISOString() : undefined,
    })
  } catch (error) {
    logger.error('Failed to get MCP server', error)
    res.status(500).json({ error: 'Failed to get MCP server' })
  }
}

export async function handleAddMCPServer(req: Request, res: Response): Promise<void> {
  try {
    const { name, transport, command, url, args, env } = req.body
    if (!name) {
      res.status(400).json({ error: 'Server name is required' })
      return
    }

    // 校验 transport 字段, 防止前端传非法值 (configService 中 transport 字段是 string).
    const allowedTransport = ['stdio', 'sse', 'streamable-http'] as const
    type Allowed = typeof allowedTransport[number]
    const isAllowed = (t: unknown): t is Allowed =>
      typeof t === 'string' && (allowedTransport as readonly string[]).includes(t)
    if (transport !== undefined && transport !== null && !isAllowed(transport)) {
      res.status(400).json({
        error: `Invalid transport "${String(transport)}". Allowed: ${allowedTransport.join(', ')}`,
      })
      return
    }

    const config: MCPServerConfig = {
      name,
      transport: (transport || (command ? 'stdio' : 'sse')) as Allowed,
      command,
      url,
      args,
      env,
    }

    const server = registerMCPServer(config)

    // 新注册 server 后立即尝试连接, 这样用户不需要再点一次"连接"按钮.
    // 如果连接失败 (例如 command 不存在), 仍然返回 201, 但 status 标记为 error,
    // 用户可以稍后手动重试.
    let connectError: string | undefined
    try {
      await connectMCPServer(server.name)
    } catch (error) {
      connectError = error instanceof Error ? error.message : String(error)
      logger.warn(`MCP server "${server.name}" registered but auto-connect failed: ${connectError}`)
    }

    // 写盘到 <SGA_HOME>/mcp-servers.json, 重启不丢.
    try {
      await persistMCPServers()
    } catch (persistError) {
      logger.error('failed to persist MCP server', persistError)
    }

    res.status(201).json({
      name: server.name,
      status: server.status,
      transport: server.config.transport || (server.config.command ? 'stdio' : 'sse'),
      command: server.config.command,
      url: server.config.url,
      toolCount: server.tools.length,
      error: connectError ?? server.error,
    })
  } catch (error) {
    logger.error('Failed to add MCP server', error)
    res.status(500).json({ error: 'Failed to add MCP server' })
  }
}

export async function handleDeleteMCPServer(req: Request, res: Response): Promise<void> {
  try {
    const serverName = getParam(req, 'name')
    const success = unregisterMCPServer(serverName)
    if (!success) {
      res.status(404).json({ error: 'MCP server not found' })
      return
    }
    // 删除时同步更新 mcp-servers.json
    try {
      await persistMCPServers()
    } catch (persistError) {
      logger.error('failed to persist MCP servers after delete', persistError)
    }
    res.status(204).send()
  } catch (error) {
    logger.error('Failed to delete MCP server', error)
    res.status(500).json({ error: 'Failed to delete MCP server' })
  }
}

export async function handleConnectMCPServer(req: Request, res: Response): Promise<void> {
  try {
    const serverName = getParam(req, 'name')
    const server = await connectMCPServer(serverName)
    res.json({
      name: server.name,
      status: server.status,
      toolCount: server.tools.length,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('Failed to connect MCP server', error)
    res.status(500).json({ error: message })
  }
}

export async function handleDisconnectMCPServer(req: Request, res: Response): Promise<void> {
  try {
    const serverName = getParam(req, 'name')
    await disconnectMCPServer(serverName)
    res.json({ success: true })
  } catch (error) {
    logger.error('Failed to disconnect MCP server', error)
    res.status(500).json({ error: 'Failed to disconnect MCP server' })
  }
}

export async function handleListMCPTools(_req: Request, res: Response): Promise<void> {
  try {
    const tools = getAllMCPTools().map(t => ({
      name: t.name,
      description: t.description,
      serverName: t.serverName,
    }))
    res.json(tools)
  } catch (error) {
    logger.error('Failed to list MCP tools', error)
    res.status(500).json({ error: 'Failed to list MCP tools' })
  }
}

export async function handleListSkills(_req: Request, res: Response): Promise<void> {
  try {
    const bundled = getAllBundledSkills().map(s => ({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      userInvocable: s.userInvocable ?? true,
      source: 'bundled' as const,
      argumentHint: s.argumentHint,
    }))

    const discovered = await discoverSkills()
    const discoveredSkills = discovered.map(s => ({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      userInvocable: s.userInvocable,
      source: s.source,
      argumentHint: s.argumentHint,
    }))

    const seen = new Set<string>()
    const all = [...bundled, ...discoveredSkills].filter(s => {
      if (seen.has(s.name)) return false
      seen.add(s.name)
      return true
    })

    res.json(all)
  } catch (error) {
    logger.error('Failed to list skills', error)
    res.status(500).json({ error: 'Failed to list skills' })
  }
}

export async function handleDiscoverSkills(_req: Request, res: Response): Promise<void> {
  try {
    const discovered = await discoverSkills()
    res.json(discovered.map(s => ({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      userInvocable: s.userInvocable,
      source: s.source,
      argumentHint: s.argumentHint,
    })))
  } catch (error) {
    logger.error('Failed to discover skills', error)
    res.status(500).json({ error: 'Failed to discover skills' })
  }
}

export async function handleGetSkill(req: Request, res: Response): Promise<void> {
  try {
    const skillName = getParam(req, 'name')
    const bundled = getBundledSkill(skillName)
    if (bundled) {
      res.json({
        name: bundled.name,
        description: bundled.description,
        whenToUse: bundled.whenToUse,
        userInvocable: bundled.userInvocable ?? true,
        source: 'bundled',
        argumentHint: bundled.argumentHint,
      })
      return
    }

    const discovered = await discoverSkills()
    const skill = discovered.find(s => s.name === skillName)
    if (skill) {
      res.json({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        userInvocable: skill.userInvocable,
        source: skill.source,
        argumentHint: skill.argumentHint,
      })
      return
    }

    res.status(404).json({ error: 'Skill not found' })
  } catch (error) {
    logger.error('Failed to get skill', error)
    res.status(500).json({ error: 'Failed to get skill' })
  }
}

export async function handleAddSkill(req: Request, res: Response): Promise<void> {
  try {
    const { name, description, whenToUse, userInvocable, source } = req.body
    if (!name || !description) {
      res.status(400).json({ error: 'Name and description are required' })
      return
    }

    const config = {
      name,
      description,
      whenToUse,
      userInvocable: userInvocable ?? true,
      prompt: `User invoked skill: ${name}. ${description}`,
    }

    registerBundledSkill(config)

    try {
      const userDir = getUserSkillsDir()
      await saveSkillToDir(config, userDir)
    } catch (saveError) {
      logger.warn('Could not persist skill to disk', saveError)
    }

    res.status(201).json({
      name,
      description,
      whenToUse,
      userInvocable: userInvocable ?? true,
      source: source || 'user',
    })
  } catch (error) {
    logger.error('Failed to add skill', error)
    res.status(500).json({ error: 'Failed to add skill' })
  }
}

export async function handleDeleteSkill(req: Request, res: Response): Promise<void> {
  try {
    const skillName = getParam(req, 'name')
    const userDir = getUserSkillsDir()
    const { unlink } = await import('fs/promises')
    const { join } = await import('path')

    const skillPath = join(userDir, `${skillName}.md`)

    try {
      await unlink(skillPath)
    } catch {
      try {
        await unlink(join(userDir, skillName, 'SKILL.md'))
      } catch {
        res.status(404).json({ error: 'Skill file not found' })
        return
      }
    }

    res.status(204).send()
  } catch (error) {
    logger.error('Failed to delete skill', error)
    res.status(500).json({ error: 'Failed to delete skill' })
  }
}
