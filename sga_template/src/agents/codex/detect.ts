/**
 * Codex binary 路径探测
 *
 * 探测顺序 (返回第一个找到的):
 *   1. process.env.CODEX_BINARY        (用户显式覆盖, 用于调试/自编译)
 *   2. <projectRoot>/codex/target/release/codex[.exe]
 *   3. <projectRoot>/codex/target/debug/codex[.exe]
 *   4. OpenAI Codex 自动安装路径 (官方预装版, 子目录名是哈希):
 *        - Windows: %LOCALAPPDATA%\\OpenAI\\Codex\\bin\\<hash>\\codex.exe
 *        - macOS:   ~/Library/Application Support/com.openai.codex/bin/<hash>/codex
 *        - Linux:   ~/.local/share/openai/codex/bin/<hash>/codex
 *   5. PATH 中 `codex` / `codex.exe` (兜底, 兼容其它安装)
 *
 * 用途:
 *   - CodexBackend.start() 用 detect() 拿到 binary 路径, 然后 spawn
 *   - 不抛错: 找不到时返 null, 让调用方决定如何降级
 *   - 不直接执行 `codex --version` 验证: 启动时再验, 这里只判存在性
 *
 * 环境变量:
 *   - CODEX_PROJECT_ROOT: 项目根目录 (含 codex/ 子目录). 默认从本文件位置反推
 *   - CODEX_BINARY:      显式 binary 路径
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { join, dirname, isAbsolute } from 'path'
import { fileURLToPath } from 'url'
import { platform, homedir } from 'os'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('codex-detect')

// 在 ESM 下拿当前文件所在目录. Node 22+ 直接支持 import.meta.dirname.
// 在不支持的运行时, 退到 import.meta.url + fileURLToPath.
const moduleDir: string = (() => {
  // 用类型保护避免类型告警, 同时兼容旧 Node 运行时
  const meta = import.meta as ImportMeta & { dirname?: string }
  if (typeof meta.dirname === 'string') return meta.dirname
  return dirname(fileURLToPath(import.meta.url))
})()

export interface CodexBinaryInfo {
  /** 绝对路径 */
  path: string
  /** 探测来源, 便于 UI 显示 */
  source: 'env' | 'release' | 'debug' | 'path'
  /** 推测的版本 (从 .codex-revision 文件读 git rev, 截前 8 位) */
  revision?: string
}

export interface CodexProjectRoot {
  /** 绝对路径 */
  path: string
  /** 探测来源 */
  source: 'env' | 'walk' | 'cwd'
}

/**
 * 解析项目根目录
 * - env CODEX_PROJECT_ROOT 优先
 * - 否则从当前文件位置向上走, 找到含 "codex/codex-rs/Cargo.toml" 的目录
 * - 最后兜底用 process.cwd()
 */
export function resolveProjectRoot(): CodexProjectRoot {
  // 1. env
  const fromEnv = process.env.CODEX_PROJECT_ROOT
  if (fromEnv && existsSync(fromEnv)) {
    return { path: fromEnv, source: 'env' }
  }

  // 2. 从本文件位置向上找. 本文件位置:
  //    <projectRoot>/sga_template/src/agents/codex/detect.ts
  //    → 向上 4 层 = projectRoot
  let cur = moduleDir
  for (let i = 0; i < 8; i++) {
    const candidate = join(cur, 'codex', 'codex-rs', 'Cargo.toml')
    if (existsSync(candidate)) {
      return { path: cur, source: 'walk' }
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }

  // 3. 兜底 cwd
  return { path: process.cwd(), source: 'cwd' }
}

/** 是否 Windows */
function isWindows(): boolean {
  return platform() === 'win32'
}

/** 取得 binary 文件名 (含平台后缀) */
function binaryNames(): string[] {
  return isWindows() ? ['codex.exe', 'codex.cmd'] : ['codex']
}

/** 拼接 candidate 路径并判存在 */
function checkFile(path: string): string | null {
  return existsSync(path) ? path : null
}

/**
 * 主入口: 探测 codex binary
 * @returns 找到返 CodexBinaryInfo; 找不到返 null (不抛错)
 */
export function detectCodexBinary(): CodexBinaryInfo | null {
  // 1. 显式 env
  const explicit = process.env.CODEX_BINARY
  if (explicit) {
    if (!isAbsolute(explicit)) {
      logger.warn(`CODEX_BINARY is not absolute: ${explicit}, ignoring`)
    } else if (existsSync(explicit)) {
      logger.info(`Using CODEX_BINARY from env: ${explicit}`)
      return { path: explicit, source: 'env', revision: readRevisionNear(explicit) }
    } else {
      logger.warn(`CODEX_BINARY env points to missing file: ${explicit}`)
    }
  }

  const projectRoot = resolveProjectRoot().path
  const codexDir = join(projectRoot, 'codex')

  if (!existsSync(codexDir)) {
    logger.debug(`codex/ not found under project root: ${codexDir}`)
  } else {
    // 2. release build
    for (const name of binaryNames()) {
      const p = checkFile(join(codexDir, 'target', 'release', name))
      if (p) {
        logger.info(`Found codex binary (release): ${p}`)
        return { path: p, source: 'release', revision: readRevisionNear(p) }
      }
    }
    // 3. debug build
    for (const name of binaryNames()) {
      const p = checkFile(join(codexDir, 'target', 'debug', name))
      if (p) {
        logger.info(`Found codex binary (debug): ${p}`)
        return { path: p, source: 'debug', revision: readRevisionNear(p) }
      }
    }
    // 3.5 自动下载的 binary (codex/bin/codex[.exe])
    for (const name of binaryNames()) {
      const p = checkFile(join(codexDir, 'bin', name))
      if (p) {
        logger.info(`Found codex binary (downloaded): ${p}`)
        return { path: p, source: 'release' }
      }
    }
  }

  // 4. OpenAI Codex 自动安装路径 (官方预装版)
  const officialHit = findInOfficialInstallDir()
  if (officialHit) {
    logger.info(`Found codex binary (official install): ${officialHit}`)
    return { path: officialHit, source: 'path' }
  }

  // 5. PATH 兜底
  const pathHit = findInPath(binaryNames())
  if (pathHit) {
    logger.info(`Found codex binary in PATH: ${pathHit}`)
    return { path: pathHit, source: 'path' }
  }

  logger.warn('codex binary not found (env / release / debug / official / PATH all miss)')
  return null
}

/** 读 <projectRoot>/codex/.codex-revision 拿到 git rev 前 8 位 */
function readRevisionNear(binaryPath: string): string | undefined {
  try {
    // binary 位于 <projectRoot>/codex/target/{release,debug}/codex[.exe]
    // 向上 3 层 = <projectRoot>/codex/
    const codexDir = join(binaryPath, '..', '..', '..')
    const revFile = join(codexDir, '.codex-revision')
    if (!existsSync(revFile)) return undefined
    const raw = readFileSync(revFile, 'utf-8').trim()
    return raw.slice(0, 8)
  } catch {
    return undefined
  }
}

/** 在 PATH 中查找 binary (跨平台) */
function findInPath(names: string[]): string | null {
  const sep = isWindows() ? ';' : ':'
  const pathEnv = process.env.PATH ?? ''
  const dirs = pathEnv.split(sep).filter(Boolean)

  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

/**
 * 在 OpenAI Codex 官方自动安装目录中查找 binary.
 * 官方安装器会把 codex 放到带哈希的子目录, 例如:
 *   Windows: %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
 *            也可能位于 %APPDATA%\Codex\bin\<hash>\codex.exe
 *   macOS:   ~/Library/Application Support/com.openai.codex/bin/<hash>/codex
 *   Linux:   ~/.local/share/openai/codex/bin/<hash>/codex
 */
function findInOfficialInstallDir(): string | null {
  const candidates: string[] = []

  if (isWindows()) {
    const localappdata = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    candidates.push(
      join(localappdata, 'OpenAI', 'Codex', 'bin'),
      join(appdata, 'OpenAI', 'Codex', 'bin'),
      join(localappdata, 'Programs', 'OpenAI', 'Codex', 'resources'),
      join(appdata, 'Codex', 'bin'),
    )
  } else if (platform() === 'darwin') {
    candidates.push(
      join(homedir(), 'Library', 'Application Support', 'com.openai.codex', 'bin'),
      join(homedir(), 'Library', 'Application Support', 'OpenAI', 'Codex', 'bin'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
    )
  } else {
    candidates.push(
      join(homedir(), '.local', 'share', 'openai', 'codex', 'bin'),
      join(homedir(), '.local', 'share', 'OpenAI', 'Codex', 'bin'),
      '/usr/local/bin/codex',
      '/usr/bin/codex',
    )
  }

  for (const dir of candidates) {
    const found = pickLatestVersionedBinary(dir)
    if (found) return found
  }
  return null
}

/**
 * 扫描 `bin/` 目录, 找到 `<hash>/codex[.exe]` (子目录名是 hash).
 * 多个 hash 同时存在时, 选文件系统 mtime 最新的一份.
 */
function pickLatestVersionedBinary(binRoot: string): string | null {
  if (!existsSync(binRoot)) return null
  let entries: string[]
  try {
    entries = readdirSync(binRoot)
  } catch {
    return null
  }

  let best: { path: string; mtime: number } | null = null
  const names = binaryNames()

  for (const sub of entries) {
    const subDir = join(binRoot, sub)
    let stat: ReturnType<typeof statSync> | null = null
    try {
      stat = statSync(subDir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    for (const n of names) {
      const cand = join(subDir, n)
      if (!existsSync(cand)) continue
      const m = stat.mtimeMs
      if (!best || m > best.mtime) {
        best = { path: cand, mtime: m }
      }
    }
  }
  return best?.path ?? null
}

/**
 * 把 CodexBinaryInfo 格式化为用户可读字符串 (用于 UI / 日志)
 */
export function formatCodexBinary(info: CodexBinaryInfo | null): string {
  if (!info) return 'not found'
  const rev = info.revision ? ` @${info.revision}` : ''
  return `${info.path} (${info.source}${rev})`
}
