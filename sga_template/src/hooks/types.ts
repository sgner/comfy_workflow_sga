export type HookEventType =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Stop'
  | 'TaskCompleted'
  | 'SessionEnd'
  | 'Cancel'

export interface HookDefinition {
  event: HookEventType
  matcher?: string
  command: string
  once?: boolean
  timeout?: number
}

export interface HookResult {
  exitCode: number
  stdout: string
  stderr: string
  proceed: boolean
  modifiedData?: unknown
  additionalContext?: string
  mcpOutput?: Record<string, unknown>
}

export interface HookExecutionContext {
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  toolError?: string
  agentId?: string
  sessionId?: string
  cwd: string
  cancelled?: boolean
}

export const HOOK_EVENT_ORDER: HookEventType[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Cancel',
  'Stop',
  'TaskCompleted',
  'SessionEnd',
]
