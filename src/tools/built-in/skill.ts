import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult, type PermissionResult } from '../base.js'
import { discoverSkills, type SkillDiscoveryConfig } from '../../skills/discovery.js'
import type { SkillDefinition } from '../../skills/types.js'

export class SkillTool extends BaseTool<{ skill_name: string; arguments?: string }, string> {
  name = 'Skill'
  description = 'Invoke a skill by name. Skills are reusable workflows defined in SKILL.md files that provide structured prompts for common tasks.'
  searchHint = 'skill invoke workflow command run'

  isReadOnly(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const skillName = (input as { skill_name?: string }).skill_name
    if (!skillName || typeof skillName !== 'string') return { success: false, error: 'skill_name is required and must be a string' }
    return { success: true }
  }

  async checkPermissions(_input: unknown, _context: ToolUseContext): Promise<PermissionResult> {
    return { behavior: 'allow' }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: 'Name of the skill to invoke' },
        arguments: { type: 'string', description: 'Arguments to pass to the skill' },
      },
      required: ['skill_name'],
    }
  }

  async call(input: { skill_name: string; arguments?: string }, context: ToolUseContext): Promise<string> {
    const appState = context.getAppState()
    const discoveryConfig = appState.skillDiscoveryConfig as SkillDiscoveryConfig | undefined
    const skills = await discoverSkills(discoveryConfig)

    const skill = skills.find(s =>
      s.name === input.skill_name ||
      s.name.toLowerCase() === input.skill_name.toLowerCase()
    )

    if (!skill) {
      const available = skills.map(s => s.name).join(', ')
      return `Skill "${input.skill_name}" not found. Available skills: ${available || 'none'}`
    }

    const prompt = await skill.getPromptForCommand(input.arguments ?? '', {
      cwd: process.cwd(),
      skillDir: skill.loadedFrom,
      sessionId: (appState.sessionId as string) ?? undefined,
    })

    return prompt
  }
}
