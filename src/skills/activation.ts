import type { SkillDefinition } from './types.js'

export interface ConditionalSkillState {
  unconditional: SkillDefinition[]
  conditional: Map<string, SkillDefinition[]>
}

export function separateConditionalSkills(skills: SkillDefinition[]): ConditionalSkillState {
  const unconditional: SkillDefinition[] = []
  const conditional = new Map<string, SkillDefinition[]>()

  for (const skill of skills) {
    if (skill.paths && skill.paths.length > 0) {
      for (const pattern of skill.paths) {
        const existing = conditional.get(pattern) ?? []
        existing.push(skill)
        conditional.set(pattern, existing)
      }
    } else {
      unconditional.push(skill)
    }
  }

  return { unconditional, conditional }
}

export function activateConditionalSkills(
  state: ConditionalSkillState,
  activeFilePath: string,
): SkillDefinition[] {
  const activated: SkillDefinition[] = []

  for (const [pattern, skills] of state.conditional) {
    if (matchGlob(activeFilePath, pattern)) {
      activated.push(...skills)
    }
  }

  return activated
}

function matchGlob(filePath: string, pattern: string): boolean {
  const regex = globToRegex(pattern)
  return regex.test(filePath)
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\*\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

export function formatSkillListForPrompt(skills: SkillDefinition[]): string {
  if (skills.length === 0) return 'No skills available.'

  return skills
    .map(s => {
      const parts = [`/${s.name}`]
      if (s.argumentHint) parts.push(s.argumentHint)
      parts.push(`— ${s.description}`)
      return parts.join(' ')
    })
    .join('\n')
}
