import { existsSync, statSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getSgaConfig } from '../../config.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('consolidation-lock')

const LOCK_FILE = '.consolidate-lock'

export interface ConsolidationLockResult {
  acquired: boolean
  priorMtime: number
}

export function readLastConsolidatedAt(memoryDir: string): number {
  const lockPath = join(memoryDir, LOCK_FILE)
  try {
    const s = statSync(lockPath)
    return s.mtimeMs
  } catch {
    return 0
  }
}

export function tryAcquireConsolidationLock(memoryDir: string): ConsolidationLockResult {
  const lockPath = join(memoryDir, LOCK_FILE)

  let mtimeMs: number | undefined
  let holderPid: number | undefined

  try {
    const s = statSync(lockPath)
    mtimeMs = s.mtimeMs
    const raw = readFileSync(lockPath, 'utf8')
    const parsed = parseInt(raw.trim(), 10)
    holderPid = Number.isFinite(parsed) ? parsed : undefined
  } catch {
    // ENOENT — no prior lock
  }

  if (mtimeMs !== undefined && Date.now() - mtimeMs < getSgaConfig().consolidation.lockStaleMs) {
    if (holderPid !== undefined && isProcessRunning(holderPid)) {
      logger.debug(`Lock held by live PID ${holderPid}`)
      return { acquired: false, priorMtime: mtimeMs }
    }
  }

  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true })
  }

  writeFileSync(lockPath, String(process.pid))

  try {
    const verify = readFileSync(lockPath, 'utf8')
    if (parseInt(verify.trim(), 10) !== process.pid) {
      return { acquired: false, priorMtime: mtimeMs ?? 0 }
    }
  } catch {
    return { acquired: false, priorMtime: mtimeMs ?? 0 }
  }

  return { acquired: true, priorMtime: mtimeMs ?? 0 }
}

export function rollbackConsolidationLock(memoryDir: string, priorMtime: number): void {
  const lockPath = join(memoryDir, LOCK_FILE)
  try {
    if (priorMtime === 0) {
      unlinkSync(lockPath)
      return
    }
    writeFileSync(lockPath, '')
    const t = Math.floor(priorMtime / 1000)
    const fs = require('fs')
    fs.utimesSync(lockPath, t, t)
  } catch (e: unknown) {
    logger.warn(`Rollback failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function recordConsolidation(memoryDir: string): void {
  try {
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true })
    }
    writeFileSync(join(memoryDir, LOCK_FILE), String(process.pid))
  } catch (e: unknown) {
    logger.warn(`recordConsolidation failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
