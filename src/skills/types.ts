export interface SkillDefinition {
  name: string
  description: string
  whenToUse?: string
  userInvocable: boolean
  disableModelInvocation: boolean
  context: 'inline' | 'fork'
  agent?: string
  model?: string
  effort?: string
  allowedTools?: string[]
  paths?: string[]
  hooks?: SkillHooks
  argumentHint?: string
  version?: string
  shell?: 'bash' | 'powershell'
  source: SkillSource
  loadedFrom: string
  getPromptForCommand: (args: string, context: SkillExecutionContext) => Promise<string>
}

export interface SkillHooks {
  PreToolUse?: SkillHookEntry[]
  PostToolUse?: SkillHookEntry[]
}

export interface SkillHookEntry {
  matcher: string
  hooks: Array<{
    command: string
    once?: boolean
  }>
}

export type SkillSource = 'bundled' | 'managed' | 'user' | 'project' | 'plugin' | 'mcp'

export interface SkillExecutionContext {
  sessionId?: string
  skillDir?: string
  arguments?: string[]
  cwd: string
}

export interface SkillFrontmatter {
  name?: string
  description?: string
  when_to_use?: string
  'user-invocable'?: boolean
  'disable-model-invocation'?: boolean
  context?: 'inline' | 'fork'
  agent?: string
  model?: string
  effort?: string
  'allowed-tools'?: string | string[]
  paths?: string | string[]
  hooks?: SkillHooks
  'argument-hint'?: string
  version?: string
  shell?: 'bash' | 'powershell'
}

export const SKILL_PRIORITY: SkillSource[] = [
  'bundled',
  'managed',
  'user',
  'project',
  'plugin',
  'mcp',
]
