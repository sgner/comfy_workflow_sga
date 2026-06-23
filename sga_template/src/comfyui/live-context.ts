/**
 * ComfyUI Live Context — SGA ↔ Codex shared state
 *
 * 把前端传入的 "实时 ComfyUI 上下文" (workflow / 上下文标签 / 错误日志) 写入
 * <SGA_HOME>/shared/comfyui/, 让 codex 在 spawn 时通过 comfyui_agent 模块读取,
 * 与 SGA 共享同一份 workflow / context 视图.
 *
 * 设计动机:
 *   - SGA 把 workflow 钉到 working set (`workflow-<sessionId>`), 但 working set
 *     存在内存里, codex 启动时无法直接拿到 (跨进程 / 跨 agent).
 *   - 黑板 (blackboard.json) 只放 "热数据" (key facts / current task),
 *     全文 workflow 太大不适合塞进去.
 *   - 这里用独立的几个文件, 各自带时间戳, codex 端只读不写.
 *
 * 写入的文件 (相对 <SGA_HOME>/shared/comfyui/):
 *   - workflow.json         : 完整 ComfyUI workflow JSON (可能 20K+ tokens)
 *   - workflow-summary.json : { nodeCount, uniqueTypes, lastNodeId, lastLinkId, ... }
 *   - frontend-context.txt  : 前端 "上下文" 标签页里的提示词
 *   - error-log.txt         : 最近的运行时错误日志
 *
 * 注意: 这些是 SGA 单向写入, codex 单向读取. 双方都不需要 lock,
 *       写用 .tmp + rename 原子覆盖. 读时若文件不存在或解析失败直接返回 null.
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { getSgaHome } from '../memory/paths.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('comfyui-live-context')

/** 完整 workflow (大文件) */
export const LIVE_WORKFLOW_FILE = 'workflow.json'
/** workflow 摘要 (小, 1K tokens 以内) */
export const LIVE_WORKFLOW_SUMMARY_FILE = 'workflow-summary.json'
/** 前端 "上下文" 标签页 */
export const LIVE_FRONTEND_CONTEXT_FILE = 'frontend-context.txt'
/** 运行时错误日志 */
export const LIVE_ERROR_LOG_FILE = 'error-log.txt'

export interface WorkflowSummary {
  nodeCount: number
  uniqueNodeTypes: number
  nodeTypes: Array<{ type: string; count: number }>
  lastNodeId: string | number | null
  lastLinkId: string | number | null
  capturedAt: number
}

export interface LiveContextSnapshot {
  workflow: unknown | null
  workflowSummary: WorkflowSummary | null
  frontendContext: string | null
  errorLog: string | null
  capturedAt: number
}

function liveDir(sgaHome?: string): string {
  return join(sgaHome ?? getSgaHome(), 'shared', 'comfyui')
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, data, 'utf-8')
  await fs.rename(tmp, path)
}

/** 把前端传过来的 workflow 节点数组转成 WorkflowSummary */
export function summarizeWorkflow(workflow: Record<string, unknown> | null | undefined): WorkflowSummary {
  const nodes = (workflow?.nodes ?? []) as Array<Record<string, unknown>>
  const nodeTypes = nodes
    .map(n => (typeof n?.type === 'string' ? n.type : ''))
    .filter(Boolean)
  const counts = new Map<string, number>()
  for (const t of nodeTypes) {
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const uniqueNodeTypes = counts.size
  const nodeTypesArr = Array.from(counts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
  const lastNodeId = (workflow?.last_node_id ?? null) as string | number | null
  const lastLinkId = (workflow?.last_link_id ?? null) as string | number | null
  return {
    nodeCount: nodes.length,
    uniqueNodeTypes,
    nodeTypes: nodeTypesArr,
    lastNodeId,
    lastLinkId,
    capturedAt: Date.now(),
  }
}

/**
 * 把前端传过来的 live 上下文写到 SGA 共享目录.
 * SGA 在 handleComfyUIChatStream 收到请求时调用, 一次写入 0..4 个文件.
 *
 * - workflow: 前端传过来的完整 workflow JSON (object / string 都可以)
 * - frontendContext: 前端 "上下文" 标签页的提示词
 * - errorLog: 前端传过来的运行时错误
 *
 * 任一字段为 undefined / null / 空字符串时, 对应文件不被写入 (即沿用旧值).
 * 想清空某个文件请传 ''.
 */
export async function writeLiveContext(opts: {
  sgaHome?: string
  workflow?: unknown
  frontendContext?: string | null
  errorLog?: string | null
}): Promise<void> {
  const dir = liveDir(opts.sgaHome)
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (err) {
    logger.warn(`failed to create live context dir ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  if (opts.workflow !== undefined && opts.workflow !== null) {
    try {
      const json = typeof opts.workflow === 'string'
        ? opts.workflow
        : JSON.stringify(opts.workflow, null, 2)
      await atomicWrite(join(dir, LIVE_WORKFLOW_FILE), json)
      // summary 跟 workflow 一起更新, 永远保持一致
      const summary = summarizeWorkflow(opts.workflow as Record<string, unknown>)
      await atomicWrite(join(dir, LIVE_WORKFLOW_SUMMARY_FILE), JSON.stringify(summary, null, 2))
    } catch (err) {
      logger.warn(`failed to write workflow: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (opts.frontendContext !== undefined && opts.frontendContext !== null) {
    try {
      await atomicWrite(join(dir, LIVE_FRONTEND_CONTEXT_FILE), opts.frontendContext)
    } catch (err) {
      logger.warn(`failed to write frontend context: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (opts.errorLog !== undefined && opts.errorLog !== null) {
    try {
      await atomicWrite(join(dir, LIVE_ERROR_LOG_FILE), opts.errorLog)
    } catch (err) {
      logger.warn(`failed to write error log: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * 读取当前 live 上下文. 任何文件缺失 / 解析失败都视为 null, 不抛错.
 */
export async function readLiveContext(sgaHome?: string): Promise<LiveContextSnapshot> {
  const dir = liveDir(sgaHome)
  const snap: LiveContextSnapshot = {
    workflow: null,
    workflowSummary: null,
    frontendContext: null,
    errorLog: null,
    capturedAt: 0,
  }

  // workflow
  try {
    const raw = await fs.readFile(join(dir, LIVE_WORKFLOW_FILE), 'utf-8')
    snap.workflow = JSON.parse(raw)
  } catch {
    /* missing or malformed */
  }

  // summary
  try {
    const raw = await fs.readFile(join(dir, LIVE_WORKFLOW_SUMMARY_FILE), 'utf-8')
    snap.workflowSummary = JSON.parse(raw) as WorkflowSummary
    snap.capturedAt = snap.workflowSummary.capturedAt
  } catch {
    /* missing or malformed */
  }

  // frontend context
  try {
    const raw = await fs.readFile(join(dir, LIVE_FRONTEND_CONTEXT_FILE), 'utf-8')
    snap.frontendContext = raw
  } catch {
    /* missing */
  }

  // error log
  try {
    const raw = await fs.readFile(join(dir, LIVE_ERROR_LOG_FILE), 'utf-8')
    snap.errorLog = raw
  } catch {
    /* missing */
  }

  return snap
}
