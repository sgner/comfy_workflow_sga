/**
 * Codex binary 路径探测
 *
 * 探测顺序 (返回第一个找到的):
 *   1. process.env.CODEX_BINARY                          (用户显式覆盖, 用于调试/自编译)
 *   2. <projectRoot>/sga_template/codex-rs/target/release/codex-app-server[.exe]
 *      (本地 vendored 编译, 优先于 OpenAI 官方下载)
 *   3. <projectRoot>/sga_template/codex-rs/target/debug/codex-app-server[.exe]
 *   4. <projectRoot>/codex/codex-rs/target/release/codex[.exe]   (旧 submodule 布局, 兼容)
 *   5. <projectRoot>/codex/codex-rs/target/debug/codex[.exe]
 *   6. OpenAI Codex 自动安装路径 (官方预装版, 子目录名是哈希):
 *        - Windows: %LOCALAPPDATA%\\OpenAI\\Codex\\bin\\<hash>\\codex.exe
 *        - macOS:   ~/Library/Application Support/com.openai.codex/bin/<hash>/codex
 *        - Linux:   ~/.local/share/openai/codex/bin/<hash>/codex
 *   7. PATH 中 `codex` / `codex.exe` (兜底, 兼容其它安装)
 *
 * 用途:
 *   - CodexBackend.start() 用 detect() 拿到 binary 路径, 然后 spawn
 *   - 不抛错: 找不到时返 null, 让调用方决定如何降级
 *   - 不直接执行 `codex --version` 验证: 启动时再验, 这里只判存在性
 *
 * 环境变量:
 *   - CODEX_PROJECT_ROOT: 项目根目录. 默认从本文件位置反推
 *   - CODEX_BINARY:      显式 binary 路径
 *
 * binary 名约定:
 *   - vendored 本地编译: codex-app-server[.exe]  (cargo build -p codex-app-server)
 *   - OpenAI 官方安装:   codex[.exe]
 *   两套 binary 名都探测. 本地 vendored 版优先以便使用我们需要的最新功能
 *   (例如 streaming delta 支持、developerInstructions 字段等).
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
 * - 否则从当前文件位置向上走, 找到含 "sga_template/codex-rs/Cargo.toml" 的目录
 *   (这是 vendored layout). 也兼容旧的 "codex/codex-rs/Cargo.toml" (submodule layout).
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
  //    优先看 vendored 路径, 找不到再兼容旧路径.
  let cur = moduleDir
  for (let i = 0; i < 8; i++) {
    const vendoredCandidate = join(cur, 'sga_template', 'codex-rs', 'Cargo.toml')
    if (existsSync(vendoredCandidate)) {
      return { path: cur, source: 'walk' }
    }
    const legacyCandidate = join(cur, 'codex', 'codex-rs', 'Cargo.toml')
    if (existsSync(legacyCandidate)) {
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

/**
 * 取得 binary 文件名 (含平台后缀).
 * vendored 构建产物是 `codex-app-server[.exe]`, OpenAI 官方安装是 `codex[.exe]`,
 * 两套都探测, 按顺序返回.
 */
function binaryNames(): string[] {
  if (isWindows()) {
    return ['codex-app-server.exe', 'codex.exe', 'codex-app-server.cmd', 'codex.cmd']
  }
  return ['codex-app-server', 'codex']
}

/** 拼接 candidate 路径并判存在 */
function checkFile(path: string): string | null {
  return existsSync(path) ? path : null
}

/**
 * 在一组 root 目录里按顺序探测 binary 路径.
 * 每个 root 探测 <root>/target/release/, <root>/target/debug/, <root>/bin/.
 * 第一个找到的返, 都找不到返 null.
 */
function probeInRoots(roots: string[], sourcePrefix: string): string | null {
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const name of binaryNames()) {
      const release = checkFile(join(root, 'target', 'release', name))
      if (release) {
        logger.info(`Found codex binary (${sourcePrefix}/release): ${release}`)
        return release
      }
    }
    for (const name of binaryNames()) {
      const debug = checkFile(join(root, 'target', 'debug', name))
      if (debug) {
        logger.info(`Found codex binary (${sourcePrefix}/debug): ${debug}`)
        return debug
      }
    }
    for (const name of binaryNames()) {
      const bin = checkFile(join(root, 'bin', name))
      if (bin) {
        logger.info(`Found codex binary (${sourcePrefix}/bin): ${bin}`)
        return bin
      }
    }
  }
  return null
}

/**
 * 主入口: 探测 codex binary
 * @returns 找到返 CodexBinaryInfo; 找不到返 null (不抛错)
 */
export function detectCodexBinary(): CodexBinaryInfo | null {
  // 1. 显式 env (最高优先级, 调试/自编译时用)
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

  // 2. vendored 本地编译 (<projectRoot>/sga_template/codex-rs/target/...)
  //    这是 SGA 主动构建的产物, 优先于任何外部安装 (因为我们可能会改 codex 源码).
  const vendoredRoots = [join(projectRoot, 'sga_template', 'codex-rs')]
  const vendoredHit = probeInRoots(vendoredRoots, 'vendored')
  if (vendoredHit) {
    const isDebug = /[\\/]target[\\/]debug[\\/]/.test(vendoredHit)
    return {
      path: vendoredHit,
      source: isDebug ? 'debug' : 'release',
      revision: readRevisionNear(vendoredHit),
    }
  }

  // 3. 旧 submodule 布局 (<projectRoot>/codex/codex-rs/target/...)
  //    兼容旧项目结构, 仍然支持.
  const legacyRoots = [
    join(projectRoot, 'codex', 'codex-rs'),
    join(projectRoot, 'codex'),
  ]
  const legacyHit = probeInRoots(legacyRoots, 'legacy')
  if (legacyHit) {
    const isDebug = /[\\/]target[\\/]debug[\\/]/.test(legacyHit)
    return {
      path: legacyHit,
      source: isDebug ? 'debug' : 'release',
      revision: readRevisionNear(legacyHit),
    }
  }

  // 4. 拒绝使用 OpenAI 官方安装的 codex:
  //    官方版 (com.openai.codex) 不包含 comfyui_agent.rs 改造, 会用
  //    "No task was provided" 之类的原始 Codex CLI 身份回复, 破坏
  //    Comfy Workflow Agent 的统一行为. 此处主动拒绝, 强制使用 vendored 编译版.
  //    如果用户确实想用官方版, 可通过 CODEX_BINARY 环境变量显式指定.
  logger.warn(
    '[codex-detect] OpenAI official codex install is explicitly REJECTED in this build. ' +
    'It would override the Comfy Workflow Agent identity. ' +
    'Build the vendored binary via scripts/build-codex.mjs, or set CODEX_BINARY env var.',
  )

  // 5. PATH 兜底 — 同样拒绝, 防止 PATH 里有同名 binary 造成回退.
  //    防止 PATH 中的 `codex` / `codex.exe` (例如 OpenAI CLI) 干扰.
  const pathHit = findInPath(binaryNames())
  if (pathHit) {
    logger.warn(
      `[codex-detect] Ignoring codex binary in PATH: ${pathHit}. ` +
      `Build the vendored binary via scripts/build-codex.mjs, or set CODEX_BINARY env var.`,
    )
  }

  logger.warn(
    'codex binary not found (env / vendored / legacy all miss). ' +
    'OpenAI official install and PATH lookups are intentionally disabled. ' +
    'Build the vendored binary via scripts/build-codex.mjs to enable codex backend.',
  )
  return null
}

/** 读 .codex-revision 拿到 git rev 前 8 位.
 *  兼容两种布局:
 *    - vendored: binary 位于 <projectRoot>/sga_template/codex-rs/target/<profile>/...
 *                → 向上 4 层 = <projectRoot>/sga_template/codex-rs/
 *    - legacy:   binary 位于 <projectRoot>/codex/codex-rs/target/<profile>/...
 *                → 向上 4 层 = <projectRoot>/codex/codex-rs/
 *  任何一种能找到都返回. */
function readRevisionNear(binaryPath: string): string | undefined {
  const levels = [4, 3]
  for (const n of levels) {
    try {
      const dir = join(binaryPath, ...Array(n).fill('..'))
      const revFile = join(dir, '.codex-revision')
      if (existsSync(revFile)) {
        const raw = readFileSync(revFile, 'utf-8').trim()
        return raw.slice(0, 8)
      }
    } catch {
      // 继续找下一层
    }
  }
  return undefined
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
 *
 * 注意: 这个函数在生产路径中**不再被调用** (comfyui_agent 改造之后,
 * detectCodexBinary 主动拒绝官方版). 保留它供调试/测试用.
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
