import { randomUUID } from 'node:crypto'
import { createLogger } from '../utils/logger.js'
import type { ComputerUseWSServer } from './ws-server.js'
import type { CanvasOpRequest, ComputerUseAction } from './types.js'

const logger = createLogger('computer-use:canvas-bridge')

export class CanvasBridge {
  private wsServer: ComputerUseWSServer

  constructor(wsServer: ComputerUseWSServer) {
    this.wsServer = wsServer
  }

  get isConnected(): boolean {
    return this.wsServer.isConnected
  }

  /** Execute a canvas action via the JS extension WS bridge. */
  async executeAction(action: ComputerUseAction): Promise<unknown> {
    const request = this.actionToRequest(action)
    return this.wsServer.sendCanvasOpAndWait(request)
  }

  private actionToRequest(action: ComputerUseAction): CanvasOpRequest {
    const id = randomUUID()

    switch (action.type) {
      case 'addNode':
        return { id, op: 'addNode', args: { nodeType: action.nodeType, x: action.x, y: action.y } }
      case 'removeNode':
        return { id, op: 'removeNode', args: { nodeId: action.nodeId } }
      case 'connect':
        return {
          id, op: 'connect',
          args: {
            fromNodeId: action.fromNodeId,
            fromSlot: action.fromSlot,
            toNodeId: action.toNodeId,
            toSlot: action.toSlot,
          },
        }
      case 'disconnect':
        return { id, op: 'disconnect', args: { linkId: action.linkId } }
      case 'setWidget':
        return {
          id, op: 'setWidget',
          args: { nodeId: action.nodeId, widgetName: action.widgetName, value: action.value },
        }
      case 'getCanvasState':
        return { id, op: 'getCanvasState', args: {} }
      case 'runQueue':
        return { id, op: 'runQueue', args: { prompt: action.prompt } }
      default:
        throw new Error(`Cannot convert action "${action.type}" to canvas op request`)
    }
  }
}
