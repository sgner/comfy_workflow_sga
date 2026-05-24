export interface ApprovalRequest {
  id: string
  type: 'approval_required'
  toolName: string
  toolInput: Record<string, unknown>
  message: string
  suggestions?: string[]
  sessionId: string
  isDestructive: boolean
  isReadOnly: boolean
}

export interface HumanInputRequest {
  id: string
  type: 'human_input_required'
  message: string
  context?: string
  options?: HumanInputOption[]
  sessionId: string
  allowFreeText: boolean
  placeholder?: string
}

export interface HumanInputOption {
  label: string
  value: string
  description?: string
  isDefault?: boolean
}

export interface UserApprovalResponse {
  actionId: string
  decision: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  reason?: string
  permissionUpdate?: PermissionUpdate
}

export interface PermissionUpdate {
  type: 'always_allow' | 'always_deny' | 'allow_pattern'
  toolName: string
  pattern?: string
  reason?: string
}

export interface UserInputResponse {
  actionId: string
  value: string
  optionValue?: string
}

export type PendingAction =
  | { type: 'approval'; request: ApprovalRequest; resolve: (response: unknown) => void; reject: (error: Error) => void }
  | { type: 'human_input'; request: HumanInputRequest; resolve: (response: unknown) => void; reject: (error: Error) => void }

export interface SuspendedContext {
  actionId: string
  sessionId: string
  messages: import('../core/types.js').Message[]
  toolCalls: Array<{
    id: string
    name: string
    input: Record<string, unknown>
  }>
  pendingToolCallIndex: number
  turnCount: number
  usage: import('../core/types.js').UsageMetrics
  model: string
  systemPromptContent: string
  agentType?: string
  providerName?: string
}

export function createApprovalRequest(params: {
  toolName: string
  toolInput: Record<string, unknown>
  message: string
  sessionId: string
  suggestions?: string[]
  isDestructive?: boolean
  isReadOnly?: boolean
}): ApprovalRequest {
  return {
    id: `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'approval_required',
    toolName: params.toolName,
    toolInput: params.toolInput,
    message: params.message,
    suggestions: params.suggestions,
    sessionId: params.sessionId,
    isDestructive: params.isDestructive ?? false,
    isReadOnly: params.isReadOnly ?? true,
  }
}

export function createHumanInputRequest(params: {
  message: string
  sessionId: string
  context?: string
  options?: HumanInputOption[]
  allowFreeText?: boolean
  placeholder?: string
}): HumanInputRequest {
  return {
    id: `input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'human_input_required',
    message: params.message,
    context: params.context,
    options: params.options,
    sessionId: params.sessionId,
    allowFreeText: params.allowFreeText ?? true,
    placeholder: params.placeholder,
  }
}
