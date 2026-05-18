import { join, sep } from 'path'
import { existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import type { MemoryScope } from './types.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('agent-memory')

export type AgentMemoryScope = 'user' | 'project' | 'local'

export interface AgentMemoryEntry {
  path: string
  content: string
  scope: AgentMemoryScope
  agentType: string
  mtimeMs: number
}

export interface AgentMemoryConfig {
  memoryBaseDir: string
  projectDir: string
  localDir: string
  maxMemoryFilesPerAgent: number
  maxMemoryFileSize: number
}

const DEFAULT_LOCAL_DIR_NAME = '.sga-agent-memory-local'

export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
  config: AgentMemoryConfig,
): string {
  const dirName = sanitizeAgentTypeForPath(agentType)
  switch (scope) {
    case 'project':
      return join(config.projectDir, '.sga', 'agent-memory', dirName) + sep
    case 'local':
      return join(config.localDir || join(config.projectDir, DEFAULT_LOCAL_DIR_NAME), dirName) + sep
    case 'user':
      return join(config.memoryBaseDir, 'agent-memory', dirName) + sep
  }
}

function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase()
}

export function loadAgentMemory(
  agentType: string,
  scope: AgentMemoryScope,
  config: AgentMemoryConfig,
): AgentMemoryEntry[] {
  const dir = getAgentMemoryDir(agentType, scope, config)
  const entries: AgentMemoryEntry[] = []

  if (!existsSync(dir)) return entries

  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.json'))
    for (const file of files) {
      const filePath = join(dir, file)
      try {
        const content = readFileSync(filePath, 'utf-8')
        const stat = existsSync(filePath) ? { mtimeMs: Date.now() } : { mtimeMs: 0 }
        entries.push({
          path: filePath,
          content,
          scope,
          agentType,
          mtimeMs: stat.mtimeMs,
        })
      } catch (e) {
        logger.warn(`Failed to read agent memory file ${filePath}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    logger.warn(`Failed to read agent memory dir ${dir}: ${e instanceof Error ? e.message : String(e)}`)
  }

  return entries.slice(0, config.maxMemoryFilesPerAgent)
}

export function loadAllAgentMemories(
  agentType: string,
  config: AgentMemoryConfig,
): AgentMemoryEntry[] {
  const entries: AgentMemoryEntry[] = []

  for (const scope of ['user', 'project', 'local'] as AgentMemoryScope[]) {
    const scopeEntries = loadAgentMemory(agentType, scope, config)
    entries.push(...scopeEntries)
  }

  return entries
}

export function buildAgentMemoryPrompt(
  agentType: string,
  config: AgentMemoryConfig,
): string {
  const entries = loadAllAgentMemories(agentType, config)

  if (entries.length === 0) {
    return ''
  }

  const parts: string[] = [`## Agent Memory (${agentType})\n`]

  for (const entry of entries) {
    const scopeLabel = entry.scope === 'user' ? 'Global' : entry.scope === 'project' ? 'Project' : 'Local'
    parts.push(`### [${scopeLabel}] ${entry.path}`)
    const content = entry.content.length > 2000
      ? entry.content.slice(0, 2000) + '\n... (truncated)'
      : entry.content
    parts.push(content)
    parts.push('')
  }

  return parts.join('\n')
}

export function saveAgentMemory(
  agentType: string,
  scope: AgentMemoryScope,
  filename: string,
  content: string,
  config: AgentMemoryConfig,
): string {
  const dir = getAgentMemoryDir(agentType, scope, config)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  if (content.length > config.maxMemoryFileSize) {
    content = content.slice(0, config.maxMemoryFileSize) + '\n... (truncated)'
  }

  const filePath = join(dir, filename)
  writeFileSync(filePath, content, 'utf-8')

  logger.info(`Saved agent memory: ${filePath} (scope=${scope}, agent=${agentType})`)
  return filePath
}

export function deleteAgentMemory(
  agentType: string,
  scope: AgentMemoryScope,
  filename: string,
  config: AgentMemoryConfig,
): boolean {
  const dir = getAgentMemoryDir(agentType, scope, config)
  const filePath = join(dir, filename)

  if (!existsSync(filePath)) return false

  try {
    const { unlinkSync } = require('fs')
    unlinkSync(filePath)
    logger.info(`Deleted agent memory: ${filePath}`)
    return true
  } catch {
    return false
  }
}

export function agentMemoryScopeToMemoryScope(scope: AgentMemoryScope): MemoryScope {
  switch (scope) {
    case 'user': return 'global'
    case 'project': return 'project'
    case 'local': return 'session'
  }
}
