/**
 * ComfyUI Computer Use Extension
 *
 * Bridges the LiteGraph canvas API over WebSocket to the SGA backend.
 * Loaded by ComfyUI via the WEB_DIRECTORY mechanism.
 *
 * This file is plain ES module JS (not built by Vite) — it runs in the browser
 * alongside the ComfyUI frontend. It connects to the SGA backend WS endpoint
 * and handles canvas op requests.
 */

(function () {
  'use strict'

  const WS_URL = 'ws://127.0.0.1:8000/api/v1/computer-use/ws'
  const RECONNECT_INTERVAL_MS = 3000
  const OP_TIMEOUT_MS = 10000

  let ws = null
  let connected = false
  let reconnectTimer = null

  // ── LiteGraph helpers ──

  function getApp() {
    return window.app
  }

  function getCanvas() {
    const app = getApp()
    return app ? app.canvas : null
  }

  function getGraph() {
    const canvas = getCanvas()
    return canvas ? canvas.graph : null
  }

  // ── Op handlers ──

  const opHandlers = {
    addNode: function (args) {
      const canvas = getCanvas()
      if (!canvas) throw new Error('Canvas not available')

      const node = LiteGraph.createNode(args.nodeType)
      if (!node) throw new Error('NODE_TYPE_UNKNOWN: ' + args.nodeType)

      if (typeof args.x === 'number' && typeof args.y === 'number') {
        node.pos = [args.x, args.y]
      }

      const graph = getGraph()
      if (!graph) throw new Error('Graph not available')
      graph.add(node)
      canvas.selectNode(node)
      graph.setDirtyCanvas(true, true)

      return { nodeId: node.id.toString() }
    },

    removeNode: function (args) {
      const graph = getGraph()
      if (!graph) throw new Error('Graph not available')

      const node = graph.getNodeById(parseInt(args.nodeId, 10))
      if (!node) throw new Error('NODE_NOT_FOUND: ' + args.nodeId)

      graph.remove(node)
      graph.setDirtyCanvas(true, true)
      return {}
    },

    connect: function (args) {
      const graph = getGraph()
      if (!graph) throw new Error('Graph not available')

      const fromNode = graph.getNodeById(parseInt(args.fromNodeId, 10))
      const toNode = graph.getNodeById(parseInt(args.toNodeId, 10))
      if (!fromNode) throw new Error('NODE_NOT_FOUND: ' + args.fromNodeId)
      if (!toNode) throw new Error('NODE_NOT_FOUND: ' + args.toNodeId)

      fromNode.connect(args.fromSlot, toNode, args.toSlot)
      graph.setDirtyCanvas(true, true)
      return { linkId: 'last' }
    },

    disconnect: function (args) {
      const graph = getGraph()
      if (!graph) throw new Error('Graph not available')

      // LiteGraph links are stored in graph.links as an array
      // Each link is [id, origin_id, origin_slot, target_id, target_slot, type]
      const link = graph.links ? graph.links[parseInt(args.linkId, 10)] : null
      if (!link) throw new Error('LINK_NOT_FOUND: ' + args.linkId)

      // Disconnect by finding the target node and disconnecting the input
      const targetNode = graph.getNodeById(link[3])
      if (targetNode) {
        targetNode.disconnectInput(link[4])
      }
      graph.setDirtyCanvas(true, true)
      return {}
    },

    setWidget: function (args) {
      const graph = getGraph()
      if (!graph) throw new Error('Graph not available')

      const node = graph.getNodeById(parseInt(args.nodeId, 10))
      if (!node) throw new Error('NODE_NOT_FOUND: ' + args.nodeId)

      const widget = node.widgets ? node.widgets.find(function (w) { return w.name === args.widgetName }) : null
      if (!widget) throw new Error('WIDGET_NOT_FOUND: ' + args.widgetName)

      widget.value = args.value
      if (typeof widget.callback === 'function') {
        widget.callback(args.value)
      }
      graph.setDirtyCanvas(true, true)
      return {}
    },

    getCanvasState: function () {
      const graph = getGraph()
      if (!graph) throw new Error('Graph not available')

      return {
        nodes: graph.nodes.map(function (n) {
          return {
            id: n.id.toString(),
            type: n.type,
            title: n.title,
            pos: n.pos,
            size: n.size,
            inputs: n.inputs ? n.inputs.map(function (i) { return { name: i.name, type: i.type, link: i.link } }) : [],
            outputs: n.outputs ? n.outputs.map(function (o) { return { name: o.name, type: o.type, links: o.links } }) : [],
            widgets: n.widgets ? n.widgets.map(function (w) { return { name: w.name, value: w.value, type: w.type } }) : [],
          }
        }),
        links: graph.links ? graph.links.map(function (link, idx) {
          if (!link) return null
          return { id: idx.toString(), origin_id: link[1], origin_slot: link[2], target_id: link[3], target_slot: link[4], type: link[5] }
        }).filter(Boolean) : [],
      }
    },

    runQueue: function (args) {
      const app = getApp()
      if (!app) throw new Error('App not available')

      // Use ComfyUI's queue prompt API
      if (app.queuePrompt) {
        app.queuePrompt(app.workflow_id || 0, args.prompt || app.workflow || {})
        return { promptId: 'queued' }
      }
      throw new Error('INTERNAL_ERROR: queuePrompt not available')
    },
  }

  // ── WS message handling ──

  function handleMessage(event) {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch (err) {
      console.error('[ComputerUse] Failed to parse WS message:', err)
      return
    }

    const handler = opHandlers[msg.op]
    if (!handler) {
      sendResponse(msg.id, false, undefined, 'UNKNOWN_OP: ' + msg.op)
      return
    }

    try {
      const data = handler(msg.args || {})
      sendResponse(msg.id, true, data)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      sendResponse(msg.id, false, undefined, errorMsg)
    }
  }

  function sendResponse(id, success, data, error) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const response = { id: id, success: success }
    if (success && data !== undefined) response.data = data
    if (!success && error) response.error = error
    ws.send(JSON.stringify(response))
  }

  // ── WS connection management ──

  function connect() {
    try {
      ws = new WebSocket(WS_URL)
    } catch (err) {
      console.warn('[ComputerUse] Failed to create WebSocket:', err)
      scheduleReconnect()
      return
    }

    ws.onopen = function () {
      console.log('[ComputerUse] WebSocket connected to SGA backend')
      connected = true
      if (reconnectTimer) {
        clearInterval(reconnectTimer)
        reconnectTimer = null
      }
    }

    ws.onmessage = handleMessage

    ws.onclose = function () {
      console.log('[ComputerUse] WebSocket disconnected')
      connected = false
      ws = null
      scheduleReconnect()
    }

    ws.onerror = function (err) {
      console.error('[ComputerUse] WebSocket error:', err)
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = setInterval(function () {
      if (!connected) {
        console.log('[ComputerUse] Attempting to reconnect...')
        connect()
      }
    }, RECONNECT_INTERVAL_MS)
  }

  // ── Extension registration ──

  // Wait for ComfyUI's app to be available, then register the extension
  function tryRegister() {
    if (window.app && window.app.registerExtension) {
      window.app.registerExtension({
        name: 'Comfy.WorkflowAgent.ComputerUse',
        setup: function () {
          console.log('[ComputerUse] Extension setup, connecting WS...')
          connect()
        },
      })
      return true
    }
    return false
  }

  if (!tryRegister()) {
    const retry = setInterval(function () {
      if (tryRegister()) {
        clearInterval(retry)
      }
    }, 500)
  }
})()
