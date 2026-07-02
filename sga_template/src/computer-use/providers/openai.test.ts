import { describe, expect, it } from 'vitest'
import { OpenAIComputerUseAdapter, normalizeOpenAIAction } from './openai.js'

describe('normalizeOpenAIAction', () => {
  it('converts click to click', () => {
    const result = normalizeOpenAIAction({ type: 'click', x: 50, y: 75 })
    expect(result).toEqual({ type: 'click', x: 50, y: 75, button: 'left' })
  })

  it('converts type to type', () => {
    const result = normalizeOpenAIAction({ type: 'type', text: 'hello world' })
    expect(result).toEqual({ type: 'type', text: 'hello world' })
  })

  it('converts keypress to key', () => {
    const result = normalizeOpenAIAction({ type: 'keypress', keys: 'Enter' })
    expect(result).toEqual({ type: 'key', combo: 'Enter' })
  })

  it('converts scroll to scroll', () => {
    const result = normalizeOpenAIAction({ type: 'scroll', x: 0, y: 100 })
    expect(result.type).toBe('scroll')
    expect((result as { dy: number }).dy).toBe(100)
  })

  it('converts drag to drag', () => {
    const result = normalizeOpenAIAction({
      type: 'drag',
      path: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
    })
    expect(result).toEqual({ type: 'drag', fromX: 10, fromY: 20, toX: 30, toY: 40 })
  })

  it('converts wait to wait', () => {
    const result = normalizeOpenAIAction({ type: 'wait', duration: 2000 })
    expect(result).toEqual({ type: 'wait', ms: 2000 })
  })

  it('throws on unknown action type', () => {
    expect(() => normalizeOpenAIAction({ type: 'unknown' })).toThrow(/unknown.*action/i)
  })
})

describe('OpenAIComputerUseAdapter', () => {
  it('builds the correct request body', () => {
    const adapter = new OpenAIComputerUseAdapter({
      apiKey: 'sk-test',
      model: 'computer-use-preview',
    })

    const body = adapter.buildRequestBody('base64png==', 'What do you see?')

    expect(body.model).toBe('computer-use-preview')
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'computer_use_preview' }),
      ]),
    )
    expect(body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'message' }),
      ]),
    )
  })
})

describe('OpenAIComputerUseAdapter.interpretActionResult', () => {
  const adapter = new OpenAIComputerUseAdapter({
    apiKey: 'sk-test',
    model: 'computer-use-preview',
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
})
