import { describe, expect, it, vi } from 'vitest'
import { ActionExecutor } from './action-executor.js'
import type { ComputerUseAction, ComputerUseResult } from './types.js'

describe('ActionExecutor', () => {
  const executor = new ActionExecutor()

  it('executes screenshot action via Playwright page', async () => {
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png-bytes')),
    } as any

    const result = await executor.executeVisualAction(
      { type: 'screenshot', variant: 'full' },
      mockPage,
    )

    expect(result.success).toBe(true)
    expect(result.screenshot).toBe('cG5nLWJ5dGVz')  // base64 of 'png-bytes'
    expect(result.action.type).toBe('screenshot')
  })

  it('returns error for unimplemented visual action (click)', async () => {
    const mockPage = {} as any

    const result = await executor.executeVisualAction(
      { type: 'click', x: 100, y: 200 },
      mockPage,
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not implemented/i)
  })

  it('returns error for canvas action when bridge not set', async () => {
    const result = await executor.executeCanvasAction(
      { type: 'addNode', nodeType: 'KSampler' },
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not connected|bridge/i)
  })

  it('delegates to canvas bridge when bridge is set and connected', async () => {
    const executorWithBridge = new ActionExecutor()
    const mockBridge = {
      isConnected: true,
      executeAction: vi.fn().mockResolvedValue({ nodeId: '42' }),
    } as any
    executorWithBridge.setCanvasBridge(mockBridge)

    const result = await executorWithBridge.executeCanvasAction(
      { type: 'addNode', nodeType: 'KSampler' },
    )

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ nodeId: '42' })
    expect(mockBridge.executeAction).toHaveBeenCalledOnce()
  })
})
