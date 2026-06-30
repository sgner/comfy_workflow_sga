import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { WebSocket as WSClient, WebSocketServer } from 'ws'
import { ComputerUseWSServer } from './ws-server.js'

describe('ComputerUseWSServer', () => {
  let httpServer: http.Server
  let wsServer: ComputerUseWSServer
  let port: number

  beforeEach(async () => {
    httpServer = http.createServer()
    wsServer = new ComputerUseWSServer()
    wsServer.attach(httpServer, '/api/v1/computer-use/ws')
    await new Promise<void>(resolve => {
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address()
        if (addr && typeof addr === 'object') {
          port = addr.port
        }
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
  })

  it('accepts a WS client connection and emits connect event', async () => {
    let connected = false
    wsServer.onConnect(() => { connected = true })

    const client = new WSClient(`ws://127.0.0.1:${port}/api/v1/computer-use/ws`)
    await new Promise<void>(resolve => client.on('open', () => resolve()))

    expect(connected).toBe(true)
    client.close()
  })

  it('receives canvas op responses from the client and routes them', async () => {
    let receivedResponse: any = null
    wsServer.onCanvasOpResponse((resp) => { receivedResponse = resp })

    const client = new WSClient(`ws://127.0.0.1:${port}/api/v1/computer-use/ws`)
    await new Promise<void>(resolve => client.on('open', () => resolve()))

    client.send(JSON.stringify({ id: 'test-1', success: true, data: { nodes: 3 } }))

    await new Promise<void>(resolve => setTimeout(resolve, 100))

    expect(receivedResponse).toEqual({ id: 'test-1', success: true, data: { nodes: 3 } })
    client.close()
  })

  it('sends canvas op requests to the connected client', async () => {
    const client = new WSClient(`ws://127.0.0.1:${port}/api/v1/computer-use/ws`)
    await new Promise<void>(resolve => client.on('open', () => resolve()))

    let receivedMessage: any = null
    client.on('message', (data) => {
      receivedMessage = JSON.parse(data.toString())
    })

    wsServer.sendCanvasOp({ id: 'op-1', op: 'getCanvasState', args: {} })

    await new Promise<void>(resolve => setTimeout(resolve, 100))

    expect(receivedMessage).toEqual({ id: 'op-1', op: 'getCanvasState', args: {} })
    client.close()
  })
})
