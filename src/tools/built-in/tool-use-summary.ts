import type { LLMProvider, ProviderRequestOptions, ProviderContentBlock } from '../../providers/types.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('tool-use-summary')

export interface ToolUseInfo {
  name: string
  input: unknown
  output: unknown
}

export interface ToolUseSummaryConfig {
  enabled: boolean
  model: string
  maxInputLength: number
  maxOutputLength: number
  maxSummaryLength: number
}

export const DEFAULT_TOOL_USE_SUMMARY_CONFIG: ToolUseSummaryConfig = {
  enabled: true,
  model: 'haiku',
  maxInputLength: 300,
  maxOutputLength: 300,
  maxSummaryLength: 60,
}

const TOOL_SUMMARY_SYSTEM_PROMPT = `Write a short summary label describing what these tool calls accomplished. It appears as a single-line row in a mobile app and truncates around 30 characters, so think git-commit-subject, not sentence.

Keep the verb in past tense and the most distinctive noun. Drop articles, connectors, and long location context first.

Examples:
- Searched in auth/
- Fixed NPE in UserService
- Created signup endpoint
- Read config.json
- Ran failing tests`

export async function generateToolUseSummary(
  tools: ToolUseInfo[],
  provider: LLMProvider,
  config: ToolUseSummaryConfig = DEFAULT_TOOL_USE_SUMMARY_CONFIG,
  lastAssistantText?: string,
): Promise<string | null> {
  if (!config.enabled || tools.length === 0) {
    return null
  }

  try {
    const toolSummaries = tools
      .map(tool => {
        const inputStr = truncateJson(tool.input, config.maxInputLength)
        const outputStr = truncateJson(tool.output, config.maxOutputLength)
        return `Tool: ${tool.name}\nInput: ${inputStr}\nOutput: ${outputStr}`
      })
      .join('\n\n')

    const contextPrefix = lastAssistantText
      ? `User's intent (from assistant's last message): ${lastAssistantText.slice(0, 200)}\n\n`
      : ''

    const resolvedModel = provider.resolveModel(config.model)

    const requestOptions: ProviderRequestOptions = {
      model: resolvedModel,
      messages: [{
        role: 'user',
        content: `${contextPrefix}Tools completed:\n\n${toolSummaries}\n\nLabel:`,
      }],
      maxTokens: 100,
      temperature: 0.3,
      stream: false,
      systemPrompt: TOOL_SUMMARY_SYSTEM_PROMPT,
    }

    const response = await provider.createMessage(requestOptions)

    const summary = response.content
      .filter((block: ProviderContentBlock) => block.type === 'text' && block.text)
      .map((block: ProviderContentBlock) => block.text!)
      .join('')
      .trim()

    if (!summary) return null

    return summary.length > config.maxSummaryLength
      ? summary.slice(0, config.maxSummaryLength - 3) + '...'
      : summary
  } catch (error) {
    logger.debug(`Tool use summary generation failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function truncateJson(value: unknown, maxLength: number): string {
  try {
    const str = JSON.stringify(value)
    if (str.length <= maxLength) return str
    return str.slice(0, maxLength - 3) + '...'
  } catch {
    return '[unable to serialize]'
  }
}
