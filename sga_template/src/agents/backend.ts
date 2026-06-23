/**
 * AgentBackend 抽象接口
 *
 * 把"agent 如何处理消息"这件事抽象成统一接口, 隐藏底层是 SGA(进程内)还是 Codex(子进程 JSON-RPC) 的差异.
 *
 * 设计要点:
 * - sendMessage 返回 AsyncIterable<AgentStreamEvent>, 与前端 SSE 协议兼容
 * - healthCheck 用于 UI 显示 backend 状态
 * - exportHandoff / importHandoff 是"切换 agent 时的记忆交接"机制
 *   详见 docs/codex-agent-integration.md §3.4
 */

import type { Message, AgentStreamEvent } from '../core/types.js'
import type { LLMProvider } from '../providers/types.js'
import type { Tool, ToolUseContext } from '../tools/base.js'
import type { SystemPrompt } from '../context/system-prompt.js'
import type { PermissionMode } from '../core/types.js'

export type AgentType = 'sga' | 'codex'

export interface BackendStartOptions {
  provider?: LLMProvider
  cwd?: string
  mcpServers?: Array<{ name: string; command: string; args: string[]; env?: Record<string, string> }>
  [key: string]: unknown
}

export interface BackendMessageOptions {
  prompt: string
  messages?: Message[]
  tools?: Tool[]
  model: string
  provider: LLMProvider
  systemPrompt?: SystemPrompt
  /**
   * Codex-specific: 作为 codex thread 的 developer_instructions 传入,
   * 用来强制行为规则 (语言偏好, 输出风格等).
   * SGA 后端忽略此字段.
   */
  developerInstructions?: string
  toolUseContext?: ToolUseContext
  permissionMode?: PermissionMode
  signal?: AbortSignal
  [key: string]: unknown
}

export interface BackendHealth {
  ok: boolean
  latencyMs: number
  details?: string
  version?: string
}

export interface AgentInfo {
  name: string
  description: string
  isBuiltIn: boolean
}

export interface Skill {
  name: string
  description: string
  source: AgentType | 'shared'
}

/**
 * 切换 agent 时的短期记忆 Bundle.
 * 由 source agent 的 exportHandoff 写出, target agent 的 importHandoff 读入.
 */
export interface HandoffBundle {
  schemaVersion: 1
  sessionId: string
  sourceAgent: AgentType
  exportedAt: number
  recentMessages: Message[]                  // 最近 N 轮 (默认 20)
  workingSetSummary: string                  // working set 的压缩摘要
  sessionMemory: string                      // 已压缩的 session 记忆摘要
  keyFacts: KeyFact[]                        // 长期记忆中的关键事实 (按重要性 top 20)
  userPreferences: Record<string, string>    // 用户偏好 (KV)
  customNotes?: string                       // source agent 补充的交接说明
}

export interface KeyFact {
  fact: string
  category: 'user' | 'project' | 'workflow' | 'tool' | 'preference'
  confidence: number                         // 0-1
  source: string                             // 来源 agent / 提取时间戳
  timestamp: number
}

export interface AgentBackend {
  readonly type: AgentType
  readonly displayName: string

  /** 启动 backend. lazy: 首个消息时调用, 或预热 */
  start(opts: BackendStartOptions): Promise<void>

  /** 关闭. 释放资源, 等待子进程退出 */
  stop(): Promise<void>

  /** 发送消息, 返回事件流. UI 通过 SSE 消费 */
  sendMessage(opts: BackendMessageOptions): AsyncIterable<AgentStreamEvent>

  /** 中断当前 turn. 立即生效 */
  abort(threadId?: string): Promise<void>

  /** 健康检查. 失败时返回 ok: false + 原因 */
  healthCheck(): Promise<BackendHealth>

  /** 列出该 backend 可用的 sub-agents */
  listAgents(): Promise<AgentInfo[]>

  /** 列出该 backend 可用的 skills */
  listSkills(): Promise<Skill[]>

  /**
   * 导出当前 session 的短期记忆为 Bundle, 供 target agent 吸收.
   * SGA: 从 working set + memory manager 抽取.
   * Codex: 通过 rollout 导出 thread.
   */
  exportHandoff(sessionId: string): Promise<HandoffBundle | null>

  /**
   * 启动时调用, 把 source agent 的 Bundle 吸收到自己的 context.
   * SGA: 把 recentMessages 合并到 session.messages, 把 keyFacts 写入 memory manager.
   * Codex: 把 recentMessages 作为 thread 初始 input, 把 keyFacts 拼入 system prompt.
   */
  importHandoff(bundle: HandoffBundle): Promise<void>

  /**
   * 当前 backend 是否可以作为 handoff 源.
   * SGA: 总是可以.
   * Codex: 仅在 thread 已关闭 (turn idle) 时可以.
   */
  canExportHandoff(): Promise<boolean>
}

/**
 * 错误分类, 用于切换时的 fallback 决策
 */
export class BackendNotAvailableError extends Error {
  constructor(public readonly backendType: AgentType, message: string) {
    super(message)
    this.name = 'BackendNotAvailableError'
  }
}

export class HandoffExportError extends Error {
  constructor(public readonly sessionId: string, message: string) {
    super(message)
    this.name = 'HandoffExportError'
  }
}

export class HandoffImportError extends Error {
  constructor(public readonly sessionId: string, message: string) {
    super(message)
    this.name = 'HandoffImportError'
  }
}
