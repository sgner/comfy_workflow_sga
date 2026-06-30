import { describe, expect, it, vi } from 'vitest'
import { AnthropicComputerUseAdapter, normalizeAnthropicAction } from './anthropic.js'

describe('normalizeAnthropicAction', () => {
  it('converts left_click to click', () => {
    const result = normalizeAnthropicAction({ type: 'left_click', coordinate: [100, 200] })
    expect(result).toEqual({ type: 'click', x: 100, y: 200, button: 'left' })
  })

  it('converts type to type', () => {
    const result = normalizeAnthropicAction({ type: 'type', text: 'hello' })
    expect(result).toEqual({ type: 'type', text: 'hello' })
  })

  it('converts screenshot to screenshot', () => {
    const result = normalizeAnthropicAction({ type: 'screenshot' })
    expect(result).toEqual({ type: 'screenshot' })
  })

  it('converts scroll to scroll', () => {
    const result = normalizeAnthropicAction({ type: 'scroll', scroll_direction: 'down', scroll_amount: 3 })
    expect(result.type).toBe('scroll')
    expect((result as { dy: number }).dy).toBeGreaterThan(0)
  })

  it('converts key to key', () => {
    const result = normalizeAnthropicAction({ type: 'key', text: 'Return' })
    expect(result).toEqual({ type: 'key', combo: 'Return' })
  })

  it('converts left_click_drag to drag', () => {
    const result = normalizeAnthropicAction({
      type: 'left_click_drag',
      start_coordinate: [10, 20],
      coordinate: [30, 40],
    })
    expect(result).toEqual({ type: 'drag', fromX: 10, fromY: 20, toX: 30, toY: 40 })
  })

  it('throws on unknown action type', () => {
    expect(() => normalizeAnthropicAction({ type: 'unknown_action' })).toThrow(/unknown.*action/i)
  })
})

describe('AnthropicComputerUseAdapter', () => {
  it('builds the correct request body with computer tool and screenshot', () => {
    const adapter = new AnthropicComputerUseAdapter({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-20250514',
    })

    const body = adapter.buildRequestBody('base64png==', 'What do you see?')

    expect(body.model).toBe('claude-sonnet-4-20250514')
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'computer_20241022' }),
      ]),
    )
    expect((body as any).messages[0].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image' }),
        expect.objectContaining({ type: 'text' }),
      ]),
    )
  })
})

describe('AnthropicComputerUseAdapter.interpretActionResult', () => {
  const adapter = new AnthropicComputerUseAdapter({
    apiKey: 'sk-test',
    model: 'claude-3-5-sonnet-20241022',
  })

  it('returns screenshot feedback for successful screenshot', () => {
    const result = {
      success: true,
      screenshot: 'abc123',
      action: { type: 'screenshot' },
    } as any
    const feedback = adapter.interpretActionResult(result)
    expect(feedback).toMatch(/screenshot.*captured/i)
  })

  it('returns data feedback for successful canvas action', () => {
    const result = {
      success: true,
      data: { nodeId: '42' },
      action: { type: 'addNode', nodeType: 'KSampler' },
    } as any
    const feedback = adapter.interpretActionResult(result)
    expect(feedback).toContain('Action succeeded')
    expect(feedback).toContain('nodeId')
  })

  it('returns error feedback for failed action', () => {
    const result = {
      success: false,
      error: 'Node not found',
      action: { type: 'removeNode', nodeId: '99' },
    } as any
    const feedback = adapter.interpretActionResult(result)
    expect(feedback).toContain('Action failed')
    expect(feedback).toContain('Node not found')
  })

  it('returns generic success for action without screenshot or data', () => {
    const result = {
      success: true,
      action: { type: 'click', x: 10, y: 20 },
    } as any
    const feedback = adapter.interpretActionResult(result)
    expect(feedback).toBe('Action succeeded')
  })
})
