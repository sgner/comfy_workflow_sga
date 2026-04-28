export type HookEventType =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Stop'
  | 'TaskCompleted'
  | 'SessionEnd'

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
}

export interface HookExecutionContext {
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  agentId?: string
  sessionId?: string
  cwd: string
}

export const HOOK_EVENT_ORDER: HookEventType[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'TaskCompleted',
  'SessionEnd',
]
