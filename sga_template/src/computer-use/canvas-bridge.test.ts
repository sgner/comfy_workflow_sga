import { describe, expect, it, vi } from 'vitest'
import { CanvasBridge } from './canvas-bridge.js'

describe('CanvasBridge', () => {
  it('converts addNode action to correct op request', () => {
    const mockWsServer = {
      isConnected: true,
      sendCanvasOpAndWait: vi.fn().mockResolvedValue({ nodeId: '42' }),
    } as any

    const bridge = new CanvasBridge(mockWsServer)
    bridge.executeAction({ type: 'addNode', nodeType: 'KSampler', x: 100, y: 200 })

    expect(mockWsServer.sendCanvasOpAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'addNode',
        args: { nodeType: 'KSampler', x: 100, y: 200 },
      }),
    )
  })

  it('returns data from WS server', async () => {
    const mockWsServer = {
      isConnected: true,
      sendCanvasOpAndWait: vi.fn().mockResolvedValue({ nodes: [] }),
    } as any

    const bridge = new CanvasBridge(mockWsServer)
    const result = await bridge.executeAction({ type: 'getCanvasState' })

    expect(result).toEqual({ nodes: [] })
  })

  it('throws when WS server not connected', async () => {
    const mockWsServer = {
      isConnected: false,
      sendCanvasOpAndWait: vi.fn().mockRejectedValue(new Error('JS extension not connected')),
    } as any

    const bridge = new CanvasBridge(mockWsServer)

    await expect(bridge.executeAction({ type: 'getCanvasState' }))
      .rejects.toThrow()
  })
})
