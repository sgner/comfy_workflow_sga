import type { SkillDefinition, SkillSource, SkillExecutionContext } from './types.js'
import { readdir, stat, readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { getSgaHome } from '../memory/paths.js'

export interface BundledSkillConfig {
  name: string
  description: string
  whenToUse?: string
  userInvocable?: boolean
  disableModelInvocation?: boolean
  context?: 'inline' | 'fork'
  allowedTools?: string[]
  argumentHint?: string
  prompt: string
  files?: Record<string, string>
}

const bundledSkillRegistry: Map<string, BundledSkillConfig> = new Map()

export function registerBundledSkill(config: BundledSkillConfig): void {
  bundledSkillRegistry.set(config.name, config)
}

export function getBundledSkill(name: string): BundledSkillConfig | undefined {
  return bundledSkillRegistry.get(name)
}

export function getAllBundledSkills(): BundledSkillConfig[] {
  return Array.from(bundledSkillRegistry.values())
}

export function clearBundledSkills(): void {
  bundledSkillRegistry.clear()
}

export function bundledSkillToDefinition(config: BundledSkillConfig, source: SkillSource = 'bundled'): SkillDefinition {
  return {
    name: config.name,
    description: config.description,
    whenToUse: config.whenToUse,
    userInvocable: config.userInvocable ?? true,
    disableModelInvocation: config.disableModelInvocation ?? false,
    context: config.context ?? 'inline',
    allowedTools: config.allowedTools,
    argumentHint: config.argumentHint,
    source,
    loadedFrom: 'bundled',
    getPromptForCommand: async (args: string, ctx: SkillExecutionContext) => {
      let content = config.prompt
      if (args) {
        content = content.replace(/\$ARGUMENTS/g, args)
      }
      if (ctx.skillDir) {
        content = content.replace(/\$\{SKILL_DIR\}/g, ctx.skillDir)
      }
      if (ctx.sessionId) {
        content = content.replace(/\$\{SESSION_ID\}/g, ctx.sessionId)
      }
      return content
    },
  }
}

export async function saveSkillToDir(
  skill: BundledSkillConfig,
  targetDir: string,
): Promise<string> {
  const skillDir = join(targetDir, skill.name)
  await mkdir(skillDir, { recursive: true })

  let frontmatter = `---\nname: ${skill.name}\ndescription: ${skill.description}\n`
  if (skill.whenToUse) frontmatter += `when_to_use: ${skill.whenToUse}\n`
  if (skill.userInvocable !== undefined) frontmatter += `user-invocable: ${skill.userInvocable}\n`
  if (skill.disableModelInvocation !== undefined) frontmatter += `disable-model-invocation: ${skill.disableModelInvocation}\n`
  if (skill.context) frontmatter += `context: ${skill.context}\n`
  if (skill.allowedTools && skill.allowedTools.length > 0) frontmatter += `allowed-tools: ${skill.allowedTools.join(',')}\n`
  if (skill.argumentHint) frontmatter += `argument-hint: "${skill.argumentHint}"\n`
  frontmatter += `---\n\n`

  const skillContent = frontmatter + skill.prompt
  const skillFilePath = join(skillDir, 'SKILL.md')
  await writeFile(skillFilePath, skillContent, 'utf-8')

  if (skill.files) {
    for (const [relPath, content] of Object.entries(skill.files)) {
      const filePath = join(skillDir, relPath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, content, 'utf-8')
    }
  }

  return skillDir
}

export function getUserSkillsDir(): string {
  return join(getSgaHome(), 'skills')
}

export function getProjectSkillsDir(): string {
  return join(process.cwd(), '.sga', 'skills')
}
