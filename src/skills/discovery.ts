import { readdir, stat, readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { getSgaHome } from '../memory/paths.js'
import type { SkillDefinition, SkillFrontmatter, SkillSource } from './types.js'

export interface SkillDiscoveryConfig {
  managedDir?: string
  userDir?: string
  projectDirs?: string[]
  additionalDirs?: string[]
}

export async function discoverSkills(config: SkillDiscoveryConfig = {}): Promise<SkillDefinition[]> {
  const allSkills: SkillDefinition[] = []
  const seenPaths = new Set<string>()

  const dirs: Array<{ path: string; source: SkillSource }> = []

  if (config.managedDir) dirs.push({ path: config.managedDir, source: 'managed' })
  dirs.push({ path: config.userDir ?? getUserSkillsDir(), source: 'user' })
  const claudeUserSkillsDir = join(homedir(), '.claude', 'skills')
  if (claudeUserSkillsDir !== getUserSkillsDir() && existsSync(claudeUserSkillsDir)) {
    dirs.push({ path: claudeUserSkillsDir, source: 'user' })
  }
  for (const dir of config.projectDirs ?? getProjectSkillsDirs()) {
    dirs.push({ path: dir, source: 'project' })
  }
  for (const dir of config.additionalDirs ?? []) {
    dirs.push({ path: dir, source: 'project' })
  }

  for (const { path, source } of dirs) {
    if (!existsSync(path)) continue
    const skills = await loadSkillsFromDir(path, source)
    for (const skill of skills) {
      const realPath = skill.loadedFrom
      if (seenPaths.has(realPath)) continue
      seenPaths.add(realPath)
      allSkills.push(skill)
    }
  }

  return allSkills
}

async function loadSkillsFromDir(dir: string, source: SkillSource): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return skills
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillDir = join(dir, entry.name)
    const skillFile = findSkillFile(skillDir)
    if (!skillFile) continue

    try {
      const content = await readFile(skillFile, 'utf-8')
      const frontmatter = parseSkillFrontmatter(content)
      const markdownContent = extractMarkdownContent(content)
      const description = frontmatter.description ?? extractFirstHeading(markdownContent) ?? entry.name

      const skill: SkillDefinition = {
        name: frontmatter.name ?? entry.name,
        description,
        whenToUse: frontmatter.when_to_use,
        userInvocable: frontmatter['user-invocable'] ?? true,
        disableModelInvocation: frontmatter['disable-model-invocation'] ?? false,
        context: frontmatter.context ?? 'inline',
        agent: frontmatter.agent,
        model: frontmatter.model,
        effort: frontmatter.effort,
        allowedTools: parseToolList(frontmatter['allowed-tools']),
        paths: parsePathList(frontmatter.paths),
        hooks: frontmatter.hooks,
        argumentHint: frontmatter['argument-hint'],
        version: frontmatter.version,
        shell: frontmatter.shell,
        source,
        loadedFrom: skillFile,
        getPromptForCommand: async (args, ctx) => {
          let finalContent = markdownContent
          if (args) {
            finalContent = finalContent.replace(/\$ARGUMENTS/g, args)
          }
          if (ctx.skillDir) {
            finalContent = finalContent.replace(/\$\{SGA_SKILL_DIR\}/g, ctx.skillDir)
          }
          if (ctx.sessionId) {
            finalContent = finalContent.replace(/\$\{SGA_SESSION_ID\}/g, ctx.sessionId)
          }
          return finalContent
        },
      }
      skills.push(skill)
    } catch {
      continue
    }
  }

  return skills
}

function findSkillFile(dir: string): string | null {
  for (const name of ['SKILL.md', 'skill.md', 'Skill.md']) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  return null
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}

  const yaml = match[1]
  const result: SkillFrontmatter = {}

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim() as keyof SkillFrontmatter
    const value = line.slice(colonIdx + 1).trim()
    if (key in result || value === undefined) continue
    ;(result as Record<string, unknown>)[key] = parseYamlValue(value)
  }

  return result
}

function parseYamlValue(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '') return null
  if (/^\d+$/.test(value)) return parseInt(value, 10)
  if (/^\d+\.\d+$/.test(value)) return parseFloat(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map(s => s.trim())
  }
  return value
}

function extractMarkdownContent(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/)
  return match ? match[1].trim() : content
}

function extractFirstHeading(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : null
}

function parseToolList(tools: string | string[] | undefined): string[] | undefined {
  if (!tools) return undefined
  if (Array.isArray(tools)) return tools
  return tools.split(',').map(t => t.trim()).filter(Boolean)
}

function parsePathList(paths: string | string[] | undefined): string[] | undefined {
  if (!paths) return undefined
  if (Array.isArray(paths)) return paths
  return paths.split(',').map(p => p.trim()).filter(Boolean)
}

function getUserSkillsDir(): string {
  return join(getSgaHome(), 'skills')
}

function getProjectSkillsDirs(): string[] {
  const dirs: string[] = []
  const seen = new Set<string>()
  let current = process.cwd()
  const home = homedir()
  while (current !== home && current !== '/') {
    for (const dirName of ['.sga', '.claude'] as const) {
      const skillsDir = join(current, dirName, 'skills')
      if (existsSync(skillsDir) && !seen.has(skillsDir)) {
        seen.add(skillsDir)
        dirs.push(skillsDir)
      }
    }
    const parent = join(current, '..')
    if (parent === current) break
    current = parent
  }
  return dirs
}
