/**
 * Backend Registry — 全局单例, 管理所有可用的 AgentBackend
 *
 * 启动时注册 SgaBackend. 未来 Sprint 3 注册 CodexBackend.
 * 切换 agent 时, 通过 getBackend(type) 拿到实例, 调 start/stop.
 */

import type { AgentBackend, AgentType, BackendHealth } from './backend.js'
import { SgaBackend, getSgaBackend } from './sga-backend.js'
import { CodexBackend, getCodexBackend } from './codex-backend.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('backend-registry')

class BackendRegistry {
  private instances: Map<AgentType, AgentBackend> = new Map()
  private active: AgentType = 'sga'
  private initialized = false

  /** 懒初始化. 不主动 spawn, 仅注册实例. */
  init(): void {
    if (this.initialized) return
    this.instances.set('sga', getSgaBackend())
    this.instances.set('codex', getCodexBackend())
    this.initialized = true
    logger.info('BackendRegistry initialized (sga, codex)')
  }

  /** 拿指定 backend. 调前应确保已 start. */
  get(type: AgentType): AgentBackend {
    this.init()
    const b = this.instances.get(type)
    if (!b) throw new Error(`Unknown backend: ${type}`)
    return b
  }

  /** 拿当前 active backend. */
  getActive(): AgentBackend {
    return this.get(this.active)
  }

  /** 设置 active (不实际 start/stop, 由调用方负责) */
  setActive(type: AgentType): void {
    this.active = type
  }

  getActiveType(): AgentType {
    return this.active
  }

  /** 列出所有可用 backend (含 health check) */
  async listAll(): Promise<Array<{ type: AgentType; displayName: string; health: boolean; healthDetails?: string; version?: string }>> {
    this.init()
    const out: Array<{ type: AgentType; displayName: string; health: boolean; healthDetails?: string; version?: string }> = []
    for (const [type, b] of this.instances) {
      try {
        const h: BackendHealth = await b.healthCheck()
        out.push({
          type,
          displayName: b.displayName,
          health: h.ok,
          healthDetails: h.details,
          version: h.version,
        })
      } catch (err) {
        out.push({
          type,
          displayName: b.displayName,
          health: false,
          healthDetails: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return out
  }
}

let _registry: BackendRegistry | null = null
export function getBackendRegistry(): BackendRegistry {
  if (!_registry) _registry = new BackendRegistry()
  return _registry
}

export { SgaBackend } from './sga-backend.js'
export { CodexBackend } from './codex-backend.js'
