import { createLogger } from '../../utils/logger.js'
import type { ComputerUseAction, ComputerUseResult } from '../types.js'

const logger = createLogger('computer-use:anthropic')

export interface AnthropicAdapterConfig {
  apiKey: string
  model: string
  baseUrl?: string
}

interface AnthropicRawAction {
  type: string
  coordinate?: [number, number]
  text?: string
  start_coordinate?: [number, number]
  scroll_direction?: 'up' | 'down' | 'left' | 'right'
  scroll_amount?: number
  duration?: number
}

/** Convert an Anthropic raw tool_use action into our normalized ComputerUseAction. */
export function normalizeAnthropicAction(raw: AnthropicRawAction): ComputerUseAction {
  switch (raw.type) {
    case 'screenshot':
      return { type: 'screenshot' }

    case 'left_click':
    case 'right_click':
    case 'middle_click': {
      if (!raw.coordinate || raw.coordinate.length !== 2) {
        throw new Error(`Action "${raw.type}" requires coordinate [x, y]`)
      }
      return {
        type: 'click',
        x: raw.coordinate[0],
        y: raw.coordinate[1],
        button: raw.type.replace('_click', '') as 'left' | 'right' | 'middle',
      }
    }

    case 'double_click':
    case 'triple_click': {
      if (!raw.coordinate || raw.coordinate.length !== 2) {
        throw new Error(`Action "${raw.type}" requires coordinate [x, y]`)
      }
      // Normalize multi-clicks to a single click for now; Playwright can handle
      // multi-click via the key action or a future click count field.
      return {
        type: 'click',
        x: raw.coordinate[0],
        y: raw.coordinate[1],
        button: 'left',
      }
    }

    case 'type': {
      if (!raw.text) {
        throw new Error('Action "type" requires text')
      }
      return { type: 'type', text: raw.text }
    }

    case 'key': {
      if (!raw.text) {
        throw new Error('Action "key" requires text (key combo)')
      }
      return { type: 'key', combo: raw.text }
    }

    case 'scroll': {
      const amount = raw.scroll_amount ?? 1
      const dy = raw.scroll_direction === 'down' ? amount * 100
        : raw.scroll_direction === 'up' ? -amount * 100
        : 0
      const dx = raw.scroll_direction === 'right' ? amount * 100
        : raw.scroll_direction === 'left' ? -amount * 100
        : 0
      return { type: 'scroll', dx, dy }
    }

    case 'left_click_drag': {
      if (!raw.start_coordinate || !raw.coordinate) {
        throw new Error('Action "left_click_drag" requires start_coordinate and coordinate')
      }
      return {
        type: 'drag',
        fromX: raw.start_coordinate[0],
        fromY: raw.start_coordinate[1],
        toX: raw.coordinate[0],
        toY: raw.coordinate[1],
      }
    }

    case 'wait': {
      const ms = (raw.duration ?? 2) * 1000
      return { type: 'wait', ms }
    }

    case 'cursor_position':
      // Not a real action; return a screenshot to let the model see current state.
      return { type: 'screenshot' }

    case 'mouse_move': {
      if (!raw.coordinate) {
        throw new Error('Action "mouse_move" requires coordinate')
      }
      // Mouse move without click is a no-op for our purposes; screenshot to confirm.
      return { type: 'screenshot' }
    }

    default:
      throw new Error(`Unknown Anthropic action type: ${raw.type}`)
  }
}

export class AnthropicComputerUseAdapter {
  readonly name = 'anthropic'
  private config: AnthropicAdapterConfig

  constructor(config: AnthropicAdapterConfig) {
    this.config = config
  }

  /** Build the Messages API request body for a screenshot + instructions. */
  buildRequestBody(screenshotBase64: string, instructions: string): Record<string, unknown> {
    return {
      model: this.config.model,
      max_tokens: 4096,
      tools: [
        {
          type: 'computer_20241022',
          name: 'computer',
          display_width_px: 1280,
          display_height_px: 720,
          display_number: 1,
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: screenshotBase64,
              },
            },
            {
              type: 'text',
              text: instructions,
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
    const baseUrl = this.config.baseUrl ?? 'https://api.anthropic.com'

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'computer-use-2024-10-22',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Anthropic API error ${response.status}: ${text}`)
    }

    const data = await response.json() as { content: unknown[] }

    // Find the tool_use block in the response content
    const toolUseBlock = data.content.find(
      (block) => typeof block === 'object' && block !== null && 'type' in block && (block as { type: string }).type === 'tool_use',
    )

    if (!toolUseBlock) {
      // Model didn't request an action; default to screenshot to continue the loop.
      logger.warn('No tool_use block in Anthropic response, defaulting to screenshot')
      return { type: 'screenshot' }
    }

    return normalizeAnthropicAction((toolUseBlock as { input: AnthropicRawAction }).input)
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
