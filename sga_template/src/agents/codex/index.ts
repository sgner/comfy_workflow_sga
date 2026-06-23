/**
 * Codex 子模块入口
 *
 * 包含 binary 路径探测 / 子进程管理 / JSON-RPC 桥接 / 事件映射
 * 落地见 docs/codex-agent-integration.md Sprint 2.
 */

export {
  detectCodexBinary,
  formatCodexBinary,
  resolveProjectRoot,
  type CodexBinaryInfo,
  type CodexProjectRoot,
} from './detect.js'
export { spawnCodexAppServer, type CodexProcessHandle, type SpawnCodexOptions } from './process.js'
export {
  attachJsonRpcClient,
  type JsonRpcClient,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type RequestId,
} from './jsonrpc.js'
export {
  createEventBridge,
  bindBridgeToClient,
  type BridgeHandle,
  type BridgeOptions,
} from './event-bridge.js'
export {
  startCodexProviderProxy,
  type CodexProxyConfig,
  type CodexProxyHandle,
} from './provider-proxy.js'
export {
  writeCodexConfig,
  type CodexConfigOptions,
  type CodexConfigHandle,
} from './config.js'
