import { readdir, stat, readFile } from 'fs/promises'
import { join, basename } from 'path'
import { existsSync } from 'fs'
import type { AgentDefinition, AgentFrontmatter } from './definition.js'
import { BaseAgentDefinition } from './definition.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('agent-loader')

export type AgentSource = 'built-in' | 'project' | 'user' | 'api'

export interface CustomAgentDefinition extends AgentDefinition {
  source: AgentSource
  filePath?: string
  isUserInvocable: boolean
  contextMode: 'inline' | 'fork'
  mcpServers?: Record<string, unknown>
}

export interface AgentDefinitionsResult {
  activeAgents: AgentDefinition[]
  customAgents: CustomAgentDefinition[]
}

class CustomAgent extends BaseAgentDefinition {
  source: AgentSource
  filePath?: string
  isUserInvocable: boolean
  contextMode: 'inline' | 'fork'
  mcpServers?: Record<string, unknown>

  constructor(params: {
    name: string
    description: string
    subagentType: string
    systemPrompt: string
    allowedTools?: string[]
    disallowedTools?: string[]
    model?: string
    effort?: string
    permissionMode?: string
    background?: boolean
    proactive?: boolean
    source: AgentSource
    filePath?: string
    isUserInvocable?: boolean
    contextMode?: 'inline' | 'fork'
    mcpServers?: Record<string, unknown>
  }) {
    super({
      name: params.name,
      description: params.description,
      subagentType: params.subagentType,
      systemPrompt: params.systemPrompt,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      model: params.model as 'inherit' | undefined,
      permissionMode: params.permissionMode as 'default' | undefined,
      background: params.background,
      proactive: params.proactive,
    })
    this.source = params.source
    this.filePath = params.filePath
    this.isUserInvocable = params.isUserInvocable ?? true
    this.contextMode = params.contextMode ?? 'fork'
    this.mcpServers = params.mcpServers
  }

  isBuiltIn(): boolean {
    return false
  }
}

export function isCustomAgent(agent: AgentDefinition): agent is CustomAgentDefinition {
  return 'source' in agent && (agent as CustomAgentDefinition).source !== 'built-in'
}

function parseYamlFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}

  const yaml = match[1]
  const result: Record<string, unknown> = {}

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()

    if (value === 'true') {
      result[key] = true
    } else if (value === 'false') {
      result[key] = false
    } else if (/^\d+$/.test(value)) {
      result[key] = parseInt(value, 10)
    } else if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
      result[key] = value.slice(1, -1)
    } else if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value.slice(1, -1).split(',').map(s => s.trim())
    } else {
      result[key] = value
    }
  }

  return result
}

function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n*/)
  if (match) {
    return content.slice(match[0].length).trim()
  }
  return content.trim()
}

function parseToolsField(tools: unknown): string[] | undefined {
  if (!tools) return undefined
  if (typeof tools === 'string') {
    if (tools === '*') return ['*']
    return tools.split(',').map(s => s.trim()).filter(Boolean)
  }
  if (Array.isArray(tools)) {
    return tools.map(String)
  }
  return undefined
}

function parseAgentFromMarkdown(
  filePath: string,
  content: string,
  source: AgentSource,
): CustomAgentDefinition | null {
  const frontmatter = parseYamlFrontmatter(content)
  const body = extractBody(content)

  const name = frontmatter['name'] as string | undefined
  const description = frontmatter['description'] as string | undefined

  if (!name || typeof name !== 'string') return null
  if (!description || typeof description !== 'string') return null

  const tools = parseToolsField(frontmatter['tools'])
  const disallowedTools = parseToolsField(frontmatter['disallowed-tools'] ?? frontmatter['disallowedTools'])
  const model = frontmatter['model'] as string | undefined
  const effort = frontmatter['effort'] as string | undefined
  const permissionMode = frontmatter['mode'] as string | undefined
  const background = frontmatter['background'] as boolean | undefined
  const proactive = frontmatter['proactive'] as boolean | undefined
  const isUserInvocable = frontmatter['user-invocable'] as boolean | undefined
  const contextMode = (frontmatter['context'] as 'inline' | 'fork') ?? 'fork'
  const mcpServers = frontmatter['mcp-servers'] ?? frontmatter['mcpServers'] as Record<string, unknown> | undefined

  return new CustomAgent({
    name,
    description,
    subagentType: name,
    systemPrompt: body,
    allowedTools: tools,
    disallowedTools,
    model: model === 'inherit' ? undefined : model,
    effort,
    permissionMode,
    background,
    proactive,
    source,
    filePath,
    isUserInvocable,
    contextMode,
    mcpServers: mcpServers as Record<string, unknown> | undefined,
  })
}

function parseAgentFromJson(
  name: string,
  definition: Record<string, unknown>,
  source: AgentSource,
): CustomAgentDefinition | null {
  const description = definition['description'] as string | undefined
  const prompt = definition['prompt'] ?? definition['systemPrompt'] as string | undefined

  if (!description || !prompt) return null

  const tools = parseToolsField(definition['tools'])
  const disallowedTools = parseToolsField(definition['disallowed-tools'] ?? definition['disallowedTools'])
  const model = definition['model'] as string | undefined
  const effort = definition['effort'] as string | undefined
  const permissionMode = definition['mode'] as string | undefined
  const background = definition['background'] as boolean | undefined
  const proactive = definition['proactive'] as boolean | undefined
  const contextMode = (definition['context'] as 'inline' | 'fork') ?? 'fork'
  const mcpServers = definition['mcp-servers'] ?? definition['mcpServers'] as Record<string, unknown> | undefined

  return new CustomAgent({
    name,
    description,
    subagentType: name,
    systemPrompt: prompt as string,
    allowedTools: tools,
    disallowedTools,
    model: model === 'inherit' ? undefined : model,
    effort,
    permissionMode,
    background,
    proactive,
    source,
    isUserInvocable: true,
    contextMode,
    mcpServers: mcpServers as Record<string, unknown> | undefined,
  })
}

async function loadAgentsFromDirectory(dir: string, source: AgentSource): Promise<CustomAgentDefinition[]> {
  if (!existsSync(dir)) return []

  const agents: CustomAgentDefinition[] = []

  try {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        const subAgents = await loadAgentsFromDirectory(fullPath, source)
        agents.push(...subAgents)
        continue
      }

      if (entry.name.endsWith('.md')) {
        try {
          const content = await readFile(fullPath, 'utf-8')
          const agent = parseAgentFromMarkdown(fullPath, content, source)
          if (agent) {
            agents.push(agent)
            logger.info(`Loaded agent from ${fullPath}: ${agent.name}`)
          }
        } catch (error) {
          logger.warn(`Failed to load agent from ${fullPath}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      if (entry.name.endsWith('.json')) {
        try {
          const content = await readFile(fullPath, 'utf-8')
          const json = JSON.parse(content)

          if (typeof json === 'object' && json !== null) {
            if (json['name'] && json['description']) {
              const agent = parseAgentFromJson(json['name'], json as Record<string, unknown>, source)
              if (agent) {
                agents.push(agent)
                logger.info(`Loaded agent from ${fullPath}: ${agent.name}`)
              }
            } else {
              for (const [name, definition] of Object.entries(json)) {
                if (typeof definition === 'object' && definition !== null) {
                  const agent = parseAgentFromJson(name, definition as Record<string, unknown>, source)
                  if (agent) {
                    agents.push(agent)
                    logger.info(`Loaded agent from ${fullPath}: ${agent.name}`)
                  }
                }
              }
            }
          }
        } catch (error) {
          logger.warn(`Failed to load agent from ${fullPath}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  } catch (error) {
    logger.warn(`Failed to read agents directory ${dir}: ${error instanceof Error ? error.message : String(error)}`)
  }

  return agents
}

export async function loadCustomAgents(baseDir?: string): Promise<CustomAgentDefinition[]> {
  const agents: CustomAgentDefinition[] = []
  const cwd = baseDir ?? process.cwd()

  const projectAgentsDir = join(cwd, '.sga', 'agents')
  const projectAgents = await loadAgentsFromDirectory(projectAgentsDir, 'project')
  agents.push(...projectAgents)

  const userHome = process.env.HOME ?? process.env.USERPROFILE ?? ''
  if (userHome) {
    const userAgentsDir = join(userHome, '.sga', 'agents')
    const userAgents = await loadAgentsFromDirectory(userAgentsDir, 'user')
    agents.push(...userAgents)
  }

  logger.info(`Loaded ${agents.length} custom agent(s)`)
  return agents
}

export function createAgentFromConfig(config: {
  name: string
  description: string
  prompt: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  background?: boolean
  source?: AgentSource
}): CustomAgentDefinition {
  return new CustomAgent({
    name: config.name,
    description: config.description,
    subagentType: config.name,
    systemPrompt: config.prompt,
    allowedTools: config.tools,
    disallowedTools: config.disallowedTools,
    model: config.model,
    source: config.source ?? 'api',
    isUserInvocable: true,
    contextMode: 'fork',
  })
}

export function agentDefinitionToJSON(agent: AgentDefinition): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: agent.name,
    description: agent.description,
    subagentType: agent.subagentType,
    isBuiltIn: agent.isBuiltIn(),
    isBackground: agent.isBackground(),
    isProactive: agent.isProactive(),
  }

  if (isCustomAgent(agent)) {
    base.source = agent.source
    base.isUserInvocable = agent.isUserInvocable
    base.contextMode = agent.contextMode
    if (agent.mcpServers) base.mcpServers = agent.mcpServers
  }

  return base
}
