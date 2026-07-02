# Computer Use WebSocket Protocol

> Control channel between the SGA backend and the browser-side JS extension.

## Endpoint

`ws://127.0.0.1:8000/api/v1/computer-use/ws`

## Connection lifecycle

1. JS extension loads in the browser (via ComfyUI WEB_DIRECTORY) and opens a WS connection to the endpoint above.
2. SGA backend accepts the connection (only one client at a time; replaces existing if a new one connects).
3. Connection stays open for the duration of the ComfyUI page session.
4. On disconnect, the orchestrator degrades to Playwright-only mode (canvas ops unavailable).

## Message format

All messages are JSON strings with the following envelope:

### Canvas op request (SGA → JS extension)

```json
{
  "id": "<uuid>",
  "op": "addNode|removeNode|connect|disconnect|setWidget|getCanvasState|runQueue",
  "args": { ... op-specific args ... }
}
```

### Canvas op response (JS extension → SGA)

```json
{
  "id": "<uuid>",
  "success": true|false,
  "data": { ... },
  "error": "<message if failed>"
}
```

## Operations

### addNode

Request args: `{ "nodeType": string, "x"?: number, "y"?: number }`
Response data: `{ "nodeId": string }`

### removeNode

Request args: `{ "nodeId": string }`
Response data: `{}`

### connect

Request args: `{ "fromNodeId": string, "fromSlot": number, "toNodeId": string, "toSlot": number }`
Response data: `{ "linkId": string }`

### disconnect

Request args: `{ "linkId": string }`
Response data: `{}`

### setWidget

Request args: `{ "nodeId": string, "widgetName": string, "value": any }`
Response data: `{}`

### getCanvasState

Request args: `{}`
Response data: `{ "nodes": [...], "links": [...] }` (LiteGraph serialized graph)

### runQueue

Request args: `{ "prompt"?: object }`
Response data: `{ "promptId": string }`

## Error codes

| Error | Meaning |
|-------|---------|
| `UNKNOWN_OP` | The requested op is not recognized |
| `NODE_NOT_FOUND` | The specified nodeId does not exist on the canvas |
| `NODE_TYPE_UNKNOWN` | The specified nodeType is not registered |
| `LINK_NOT_FOUND` | The specified linkId does not exist |
| `WIDGET_NOT_FOUND` | The specified widgetName does not exist on the node |
| `INVALID_ARGS` | The args are malformed or missing required fields |
| `INTERNAL_ERROR` | An unexpected error occurred in the extension |

## Timeout

The SGA backend waits up to 10 seconds for a response. If no response arrives, the promise rejects with a timeout error and the orchestrator logs the failure.
