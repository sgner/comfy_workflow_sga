/**
 * Codex app-server 子进程管理
 *
 * 启动一个 `codex app-server --stdio` 子进程, 把它的 stdio 包装成双向流:
 *   - stdin: 写入 JSON-RPC 消息 (每行一个 JSON)
 *   - stdout: 按行读出 JSON-RPC 消息, 喂给 JsonRpcStream
 *   - stderr: 捕获为日志, 实时打印
 *
 * 注意:
 *   - 启动后必须发 `initialize` 请求, 拿到 InitializeResponse 后才允许发业务请求
 *   - 进程退出 (正常或异常) 时通知所有 in-flight 请求
 *   - 二进制路径由 detect.ts 提供, 这里只负责 spawn
 *
 * 不实现 (留到 Sprint 2.4+):
 *   - 自动重连
 *   - token 鉴权 (capability-token)
 *   - websocket transport (目前只 stdio)
 */

import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { createLogger } from '../../utils/logger.js'
import type { CodexBinaryInfo } from './detect.js'

const logger = createLogger('codex-process')

export interface SpawnCodexOptions {
  /** 工作目录, 设为 codex 实际操作的目录 */
  cwd: string
  /** 模型 id, e.g. "gpt-5" / "gpt-5-codex" */
  model?: string
  /** 沙箱模式 */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** 会话来源标识, SGA 这里用 "vscode" 即可, codex 用于埋点 */
  sessionSource?: string
  /** 透传的环境变量 (会合并到 process.env) */
  extraEnv?: Record<string, string>
}

export interface CodexProcessHandle {
  /** 子进程 PID */
  pid: number
  /** 实际可执行文件路径 */
  binary: string
  /** 杀进程 (先 SIGTERM, 2s 后 SIGKILL) */
  kill(): Promise<void>
  /** 暴露给上层接 JSON-RPC 读写 */
  getStdinWriter(): (line: string) => void
  onStdoutLine(cb: (line: string) => void): void
  onStderrLine(cb: (line: string) => void): void
  onExit(cb: (code: number | null, signal: string | null) => void): void
  /** 已经启动时间 (ms) */
  startTime: number
}

export function spawnCodexAppServer(
  binary: CodexBinaryInfo,
  opts: SpawnCodexOptions,
): CodexProcessHandle {
  const args: string[] = ['app-server', '--stdio']

  if (opts.sandbox) {
    // -c 走 config 覆盖, app-server 支持 TOML 字面量
    args.push('-c', `sandbox=${opts.sandbox}`)
  }
  // 注: --session-source 在旧版 codex (0.138 之前) 不存在, 这里不传.
  //     SGA 标识直接由 thread/start 的 metadata 携带.
  // 关闭遥测, 避免污染 SGA 日志. 注意: 该 flag 是 bool 不接 value.
  args.push('--analytics-default-enabled')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.extraEnv,
    // 强制子进程输出 UTF-8, 防止 Windows 上 GBK 解码失败
    PYTHONIOENCODING: 'utf-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
  }

  logger.info(`Spawning codex: ${binary.path} ${args.join(' ')}`)
  logger.debug(`  cwd = ${opts.cwd}`)

  const child: ChildProcess = spawn(binary.path, args, {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Windows 上避免弹出黑框
    windowsHide: true,
  })

  if (!child.pid) {
    throw new Error('failed to spawn codex process (no pid)')
  }
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill('SIGKILL')
    throw new Error('failed to obtain codex stdio pipes')
  }

  const stdoutReader = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const stderrReader = createInterface({ input: child.stderr, crlfDelay: Infinity })

  const stdoutCbs: Array<(line: string) => void> = []
  const stderrCbs: Array<(line: string) => void> = []
  const exitCbs: Array<(code: number | null, signal: string | null) => void> = []

  stdoutReader.on('line', (line) => {
    if (!line) return
    for (const cb of stdoutCbs) {
      try {
        cb(line)
      } catch (err) {
        logger.warn(`stdout callback threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  })

  stderrReader.on('line', (line) => {
    if (!line) return
    // 实时转发到 SGA 日志. codex 的 stderr 通常是 WARN/ERROR, 直接 INFO 级别
    // 让用户看到; 真要静音可以调 logger.debug.
    logger.info(`[codex stderr] ${line}`)
    for (const cb of stderrCbs) {
      try {
        cb(line)
      } catch (err) {
        logger.warn(`stderr callback threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  })

  child.on('error', (err) => {
    logger.error(`codex process error: ${err.message}`)
  })

  child.on('exit', (code, signal) => {
    logger.info(`codex process exited (code=${code}, signal=${signal})`)
    for (const cb of exitCbs) {
      try {
        cb(code, signal)
      } catch (err) {
        logger.warn(`exit callback threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  })

  const stdinWriter = (line: string): void => {
    if (!child.stdin || child.stdin.destroyed) {
      throw new Error('codex stdin is closed')
    }
    child.stdin.write(line + '\n', (err) => {
      if (err) {
        logger.warn(`codex stdin write error: ${err.message}`)
      }
    })
  }

  return {
    pid: child.pid,
    binary: binary.path,
    startTime: Date.now(),
    kill: async (): Promise<void> => {
      if (child.exitCode !== null) return
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          logger.warn('codex did not exit on SIGTERM, sending SIGKILL')
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }
      }, 2000)
      try {
        child.kill('SIGTERM')
      } catch (err) {
        logger.warn(`SIGTERM failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          clearTimeout(killTimer)
          resolve()
          return
        }
        child.once('exit', () => {
          clearTimeout(killTimer)
          resolve()
        })
      })
    },
    getStdinWriter: () => stdinWriter,
    onStdoutLine: (cb) => stdoutCbs.push(cb),
    onStderrLine: (cb) => stderrCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
  }
}
