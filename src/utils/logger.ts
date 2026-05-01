import * as fs from 'fs'
import * as path from 'path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

export interface LoggerOptions {
  level?: LogLevel
  logDir?: string
  enableFile?: boolean
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
}

let globalLogDir: string | null = null
let globalEnableFile = true
let fileStream: fs.WriteStream | null = null
let errorFileStream: fs.WriteStream | null = null
let initialized = false

export function initFileLogging(logDir?: string, enableFile = true): void {
  globalEnableFile = enableFile
  if (!enableFile) return

  globalLogDir = logDir ?? path.resolve(process.cwd(), 'logs')

  if (!fs.existsSync(globalLogDir)) {
    fs.mkdirSync(globalLogDir, { recursive: true })
  }

  const dateStr = new Date().toISOString().slice(0, 10)
  const allLogFile = path.join(globalLogDir, `${dateStr}.log`)
  const errorLogFile = path.join(globalLogDir, `${dateStr}-error.log`)

  fileStream = fs.createWriteStream(allLogFile, { flags: 'a', encoding: 'utf-8' })
  errorFileStream = fs.createWriteStream(errorLogFile, { flags: 'a', encoding: 'utf-8' })

  initialized = true
}

export function shutdownFileLogging(): void {
  fileStream?.end()
  errorFileStream?.end()
  fileStream = null
  errorFileStream = null
  initialized = false
}

function writeToFile(level: LogLevel, line: string): void {
  if (!globalEnableFile || !initialized) return

  const data = line + '\n'
  fileStream?.write(data)
  if (level === 'error') {
    errorFileStream?.write(data)
  }
}

export class Logger {
  private name: string
  private level: LogLevel

  constructor(name: string, level: LogLevel = 'info') {
    this.name = name
    this.level = level
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data)
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data)
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data)
  }

  error(message: string, data?: unknown): void {
    this.log('error', message, data)
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.level]) return

    const timestamp = new Date().toISOString()
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${this.name}]`
    const dataStr = data !== undefined ? (typeof data === 'string' ? data : JSON.stringify(data)) : ''
    const fullLine = dataStr ? `${prefix} ${message} ${dataStr}` : `${prefix} ${message}`

    switch (level) {
      case 'debug':
        console.debug(prefix, message, data ?? '')
        break
      case 'info':
        console.info(prefix, message, data ?? '')
        break
      case 'warn':
        console.warn(prefix, message, data ?? '')
        break
      case 'error':
        console.error('\x1b[31m%s\x1b[0m', prefix, message, data ?? '')
        break
    }

    writeToFile(level, fullLine)
  }
}

export function createLogger(name: string, level: LogLevel = 'info'): Logger {
  return new Logger(name, level)
}
