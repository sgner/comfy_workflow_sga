import { BaseTool, type ToolInputSchema, type ToolUseContext, type ValidationResult, type PermissionResult } from '../base.js'

export interface QuestionOption {
  label: string
  description?: string
}

export class AskUserQuestionTool extends BaseTool<{
  question: string
  header: string
  options: QuestionOption[]
  multiSelect?: boolean
}, string> {
  name = 'AskUserQuestion'
  description = 'Ask the user a question to clarify requirements, get decisions, or gather information. Use when the task is ambiguous or requires user input.'
  searchHint = 'ask question user input clarify confirm decision'

  isReadOnly(): boolean {
    return true
  }

  isConcurrencySafe(): boolean {
    return true
  }

  requiresUserInteraction(): boolean {
    return true
  }

  validateInput(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object') return { success: false, error: 'Input must be an object' }
    const question = (input as { question?: string }).question
    if (!question || typeof question !== 'string') return { success: false, error: 'question is required and must be a string' }
    const options = (input as { options?: unknown[] }).options
    if (options && !Array.isArray(options)) return { success: false, error: 'options must be an array' }
    return { success: true }
  }

  async checkPermissions(_input: unknown, context: ToolUseContext): Promise<PermissionResult> {
    if (context.permissionChecker && !this.requiresUserInteraction()) {
      const ruleResult = context.permissionChecker.check(this.name)
      if (ruleResult.behavior === 'deny') {
        return { behavior: 'deny', message: ruleResult.reason ?? 'Denied by rule', decisionReason: 'rule_deny' }
      }
      if (ruleResult.behavior === 'allow') {
        return { behavior: 'allow', decisionReason: ruleResult.reason }
      }
    }

    return {
      behavior: 'ask',
      message: 'This operation requires user input',
      suggestions: [],
    }
  }

  protected getInputSchema(): ToolInputSchema {
    return {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
        header: { type: 'string', description: 'Very short label displayed as a chip/tag (max 12 chars)' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Display text for this option (1-5 words)' },
              description: { type: 'string', description: 'Explanation of what this option means' },
            },
            required: ['label'],
          },
          description: 'Available choices for the user (2-4 options)',
        },
        multiSelect: { type: 'boolean', description: 'Allow multiple selections' },
      },
      required: ['question'],
    }
  }

  async call(input: { question: string; header?: string; options?: QuestionOption[]; multiSelect?: boolean }, context: ToolUseContext): Promise<string> {
    const appState = context.getAppState()
    const requestHumanInput = appState.requestHumanInput as
      | ((event: { type: string; message: string; options?: QuestionOption[]; multiSelect?: boolean }) => Promise<string>)
      | undefined

    if (requestHumanInput) {
      const response = await requestHumanInput({
        type: 'human_input_required',
        message: input.question,
        options: input.options,
        multiSelect: input.multiSelect,
      })
      return response
    }

    if (input.options && input.options.length > 0) {
      const optionsText = input.options.map((o, i) =>
        `  ${i + 1}. ${o.label}${o.description ? ` - ${o.description}` : ''}`
      ).join('\n')
      return `Question: ${input.question}\n\nOptions:\n${optionsText}\n\n[No interactive handler available - user must respond via the /sessions/:id/input API endpoint]`
    }

    return `Question: ${input.question}\n\n[No interactive handler available - user must respond via the /sessions/:id/input API endpoint]`
  }
}
