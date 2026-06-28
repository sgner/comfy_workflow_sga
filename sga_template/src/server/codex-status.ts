import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getSgaHome } from '../memory/paths.js'
import { detectCodexBinary } from '../agents/codex/detect.js'

export type CodexCapabilityState = 'disabled' | 'unavailable' | 'source-present' | 'building' | 'ready' | 'failed'

export interface CodexBuildStatus {
  status: string
  lastCheckedAt: string
  error: string | null
  pid?: number
}

export interface CodexCapabilityStatus {
  enabled: boolean
  mode: 'auto' | 'true' | 'false'
  state: CodexCapabilityState
  build: CodexBuildStatus
  binary: {
    available: boolean
    source?: string
    revision?: string
  }
  canSwitchToCodex: boolean
  message: string
}

function getCodexMode(): 'auto' | 'true' | 'false' {
  const raw = (process.env.SGA_ENABLE_CODEX ?? 'auto').toLowerCase()
  if (raw === 'true' || raw === '1' || raw === 'yes') return 'true'
  if (raw === 'false' || raw === '0' || raw === 'no') return 'false'
  return 'auto'
}

function readBuildStatus(): CodexBuildStatus {
  const lastCheckedAt = new Date().toISOString()
  try {
    const statusFile = join(getSgaHome(), 'codex-build.json')
    if (!existsSync(statusFile)) {
      return { status: 'idle', lastCheckedAt, error: null }
    }

    const parsed = JSON.parse(readFileSync(statusFile, 'utf-8')) as Record<string, unknown>
    let status = typeof parsed.status === 'string' ? parsed.status : 'unknown'
    let error = typeof parsed.error === 'string' ? parsed.error : null
    const pid = typeof parsed.pid === 'number' ? parsed.pid : undefined

    if ((status === 'building' || status === 'pending') && pid && !isProcessAlive(pid)) {
      status = 'failed'
      error = error ?? `worker process (pid=${pid}) exited unexpectedly`
    }

    return {
      status,
      lastCheckedAt: typeof parsed.updated_at === 'string'
        ? parsed.updated_at
        : typeof parsed.finished_at === 'string'
          ? parsed.finished_at
          : lastCheckedAt,
      error,
      ...(pid ? { pid } : {}),
    }
  } catch (error) {
    return {
      status: 'error',
      lastCheckedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    return err.code === 'EPERM'
  }
}

// TTL 缓存: 避免每次请求都执行同步文件 IO
let _cachedStatus: CodexCapabilityStatus | null = null
let _cachedAt = 0
const STATUS_CACHE_TTL_MS = 2000

export function getCodexCapabilityStatus(): CodexCapabilityStatus {
  const now = Date.now()
  if (_cachedStatus && now - _cachedAt < STATUS_CACHE_TTL_MS) {
    return _cachedStatus
  }
  const result = computeCodexCapabilityStatus()
  _cachedStatus = result
  _cachedAt = now
  return result
}

function computeCodexCapabilityStatus(): CodexCapabilityStatus {
  const mode = getCodexMode()
  const enabled = mode !== 'false'
  const build = readBuildStatus()
  const binary = detectCodexBinary()

  if (!enabled) {
    return {
      enabled,
      mode,
      state: 'disabled',
      build,
      binary: { available: !!binary, source: binary?.source, revision: binary?.revision },
      canSwitchToCodex: false,
      message: 'Codex backend is disabled by SGA_ENABLE_CODEX=false.',
    }
  }

  if (build.status === 'building' || build.status === 'pending') {
    return {
      enabled,
      mode,
      state: 'building',
      build,
      binary: { available: !!binary, source: binary?.source, revision: binary?.revision },
      canSwitchToCodex: false,
      message: 'Codex backend is building. SGA remains available.',
    }
  }

  if (build.status === 'failed' || build.status === 'error') {
    return {
      enabled,
      mode,
      state: 'failed',
      build,
      binary: { available: !!binary, source: binary?.source, revision: binary?.revision },
      canSwitchToCodex: false,
      message: build.error ?? 'Codex build failed.',
    }
  }

  if (binary) {
    return {
      enabled,
      mode,
      state: 'ready',
      build,
      binary: { available: true, source: binary.source, revision: binary.revision },
      canSwitchToCodex: true,
      message: 'Codex backend is ready.',
    }
  }

  const projectRootHasSource = existsSync(join(process.cwd(), 'codex-rs', 'Cargo.toml')) ||
    existsSync(join(process.cwd(), 'sga_template', 'codex-rs', 'Cargo.toml'))

  return {
    enabled,
    mode,
    state: projectRootHasSource ? 'source-present' : 'unavailable',
    build,
    binary: { available: false },
    canSwitchToCodex: false,
    message: projectRootHasSource
      ? 'Codex source is present, but no vendored codex-app-server binary was found.'
      : 'Codex backend is unavailable. SGA remains the default backend.',
  }
}

export function codexSwitchError(status = getCodexCapabilityStatus()): { code: string; message: string } | null {
  if (status.canSwitchToCodex) return null
  if (status.state === 'disabled') return { code: 'CODEX_DISABLED', message: status.message }
  if (status.state === 'failed') return { code: 'CODEX_BUILD_FAILED', message: status.message }
  return { code: 'CODEX_NOT_READY', message: status.message }
}
