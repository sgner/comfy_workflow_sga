import { createLogger } from '../../utils/logger.js'
import type { ComputerUseAction, ComputerUseAdapter, ComputerUseResult } from '../types.js'

const logger = createLogger('computer-use:openai')

export interface OpenAIAdapterConfig {
  apiKey: string
  model: string
  baseUrl?: string
}

interface OpenAIRawAction {
  type: string
  x?: number
  y?: number
  text?: string
  keys?: string
  path?: Array<{ x: number; y: number }>
  duration?: number
  button?: string
}

/** Convert an OpenAI CUA raw action into our normalized ComputerUseAction. */
export function normalizeOpenAIAction(raw: OpenAIRawAction): ComputerUseAction {
  switch (raw.type) {
    case 'screenshot':
      return { type: 'screenshot' }

    case 'click': {
      if (raw.x === undefined || raw.y === undefined) {
        throw new Error('Action "click" requires x and y')
      }
      return {
        type: 'click',
        x: raw.x,
        y: raw.y,
        button: (raw.button as 'left' | 'right' | 'middle') ?? 'left',
      }
    }

    case 'type': {
      if (!raw.text) {
        throw new Error('Action "type" requires text')
      }
      return { type: 'type', text: raw.text }
    }

    case 'keypress': {
      if (!raw.keys) {
        throw new Error('Action "keypress" requires keys')
      }
      return { type: 'key', combo: raw.keys }
    }

    case 'scroll': {
      return {
        type: 'scroll',
        dx: raw.x ?? 0,
        dy: raw.y ?? 0,
      }
    }

    case 'drag': {
      if (!raw.path || raw.path.length < 2) {
        throw new Error('Action "drag" requires a path with at least 2 points')
      }
      const start = raw.path[0]
      const end = raw.path[raw.path.length - 1]
      return {
        type: 'drag',
        fromX: start.x,
        fromY: start.y,
        toX: end.x,
        toY: end.y,
      }
    }

    case 'move': {
      // Mouse move without click — return screenshot to confirm position
      return { type: 'screenshot' }
    }

    case 'wait': {
      return { type: 'wait', ms: raw.duration ?? 1000 }
    }

    default:
      throw new Error(`Unknown OpenAI action type: ${raw.type}`)
  }
}

export class OpenAIComputerUseAdapter {
  readonly name = 'openai'
  private config: OpenAIAdapterConfig

  constructor(config: OpenAIAdapterConfig) {
    this.config = config
  }

  /** Build the Responses API request body for a screenshot + instructions. */
  buildRequestBody(screenshotBase64: string, instructions: string): Record<string, unknown> {
    return {
      model: this.config.model,
      tools: [
        {
          type: 'computer_use_preview',
          display_width: 1280,
          display_height: 720,
        },
      ],
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: instructions,
            },
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${screenshotBase64}`,
            },
          ],
        },
      ],
    }
  }

  /** Send screenshot + instructions, parse the model's action response. */
  async sendScreenshotAndGetCurrentAction(
    screenshotBase64: string,
    instructions: string,
  ): Promise<ComputerUseAction> {
    const body = this.buildRequestBody(screenshotBase64, instructions)
    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com'

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OpenAI API error ${response.status}: ${text}`)
    }

    const data = await response.json() as { output?: unknown[] }

    // Find the computer_call output item
    const computerCall = data.output?.find(
      (item) => typeof item === 'object' && item !== null && 'type' in item
        && (item as { type: string }).type === 'computer_call',
    )

    if (!computerCall) {
      logger.warn('No computer_call in OpenAI response, defaulting to screenshot')
      return { type: 'screenshot' }
    }

    return normalizeOpenAIAction((computerCall as { action: OpenAIRawAction }).action)
  }

  interpretActionResult(result: ComputerUseResult): string {
    if (result.success) {
      if (result.screenshot) {
        return `Screenshot captured (${result.screenshot.length} bytes base64)`
      }
      if (result.data !== undefined) {
        return `Action succeeded. Response: ${JSON.stringify(result.data).slice(0, 500)}`
      }
      return 'Action succeeded'
    }
    return `Action failed: ${result.error ?? 'unknown error'}`
  }
}
