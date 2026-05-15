export interface SystemPrompt {
  role: 'system'
  content: string
}

export interface SystemPromptSection {
  name: string
  scope: 'global' | 'ephemeral'
  content: string | (() => Promise<string>)
}

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '---DYNAMIC_BOUNDARY---'

export function buildSystemPrompt(sections: SystemPromptSection[]): SystemPrompt {
  const staticParts: string[] = []
  const dynamicParts: string[] = []

  for (const section of sections) {
    const target = section.scope === 'global' ? staticParts : dynamicParts
    if (typeof section.content === 'string') {
      target.push(section.content)
    }
  }

  const parts = [...staticParts]
  if (dynamicParts.length > 0) {
    parts.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...dynamicParts)
  }

  return {
    role: 'system',
    content: parts.join('\n\n'),
  }
}

export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<SystemPromptSection[]> {
  const resolved: SystemPromptSection[] = []
  for (const section of sections) {
    if (typeof section.content === 'function') {
      const content = await section.content()
      resolved.push({ ...section, content })
    } else {
      resolved.push(section)
    }
  }
  return resolved
}

export function systemPromptSection(
  name: string,
  content: string | (() => Promise<string>),
  scope: 'global' | 'ephemeral' = 'global',
): SystemPromptSection {
  return { name, scope, content }
}

export function uncachedSystemPromptSection(
  name: string,
  content: string | (() => Promise<string>),
  reason: string,
): SystemPromptSection {
  return { name, scope: 'ephemeral', content }
}

export interface SystemPromptPriority {
  override?: string
  coordinator?: string
  agent?: string
  custom?: string
  default?: string
  append?: string
  thinkingEffort?: string
}

export function buildEffectiveSystemPrompt(priority: SystemPromptPriority): SystemPrompt {
  const content =
    priority.override ??
    priority.coordinator ??
    priority.agent ??
    priority.custom ??
    priority.default ??
    ''

  const parts = [content]
  if (priority.append) parts.push(priority.append)
  if (priority.thinkingEffort) parts.push(priority.thinkingEffort)

  return {
    role: 'system',
    content: parts.join('\n\n'),
  }
}
