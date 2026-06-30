import type { Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { createLogger } from '../utils/logger.js'
import type { CanvasOpRequest, CanvasOpResponse } from './types.js'

const logger = createLogger('computer-use:ws-server')

export class ComputerUseWSServer {
  private wss: WebSocketServer | null = null
  private client: WebSocket | null = null
  private connectHandlers: Array<() => void> = []
  private disconnectHandlers: Array<() => void> = []
  private canvasOpResponseHandlers: Array<(response: CanvasOpResponse) => void> = []
  private pendingRequests: Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }> = new Map()

  attach(httpServer: HttpServer, path: string): void {
    this.wss = new WebSocketServer({ server: httpServer, path })

    this.wss.on('connection', (ws: WebSocket) => {
      logger.info('JS extension WS client connected')

      // Only allow one client at a time (the dedicated browser or the user's browser)
      if (this.client) {
        logger.warn('Replacing existing JS extension client')
        this.client.close()
      }
      this.client = ws
      this.connectHandlers.forEach(h => h())

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString())

          // Check if this is a canvas op response
          if (msg.id !== undefined && (msg.success !== undefined || msg.error !== undefined)) {
            const response = msg as CanvasOpResponse
            this.canvasOpResponseHandlers.forEach(h => h(response))

            // Resolve pending promise if any
            const pending = this.pendingRequests.get(response.id)
            if (pending) {
              clearTimeout(pending.timeout)
              this.pendingRequests.delete(response.id)
              if (response.success) {
                pending.resolve(response.data)
              } else {
                pending.reject(new Error(response.error ?? 'Canvas op failed'))
              }
            }
          }
        } catch (err) {
          logger.warn('Failed to parse WS message', err)
        }
      })

      ws.on('close', () => {
        logger.info('JS extension WS client disconnected')
        if (this.client === ws) {
          this.client = null
          this.disconnectHandlers.forEach(h => h())
        }
      })

      ws.on('error', (err: Error) => {
        logger.error('JS extension WS client error', err)
      })
    })
  }

  onConnect(handler: () => void): void {
    this.connectHandlers.push(handler)
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler)
  }

  onCanvasOpResponse(handler: (response: CanvasOpResponse) => void): void {
    this.canvasOpResponseHandlers.push(handler)
  }

  get isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN
  }

  /** Send a canvas op request to the JS extension. */
  sendCanvasOp(request: CanvasOpRequest): void {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw new Error('JS extension not connected')
    }
    this.client.send(JSON.stringify(request))
  }

  /** Send a canvas op request and await the response (promise-based). */
  async sendCanvasOpAndWait(request: CanvasOpRequest, timeoutMs = 10000): Promise<unknown> {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw new Error('JS extension not connected')
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id)
        reject(new Error(`Canvas op "${request.op}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingRequests.set(request.id, { resolve, reject, timeout })
      this.client!.send(JSON.stringify(request))
    })
  }

  close(): void {
    if (this.client) {
      this.client.close()
      this.client = null
    }
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('WS server closing'))
      this.pendingRequests.delete(id)
    }
  }
}
