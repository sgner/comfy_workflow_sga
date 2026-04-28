export function createLogger(name: string, level: LogLevel = 'info'): Logger {
  return new Logger(name, level)
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

export class Logger {
  private name: string
  private level: LogLevel
  private levelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
  }

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
    if (this.levelPriority[level] < this.levelPriority[this.level]) return

    const timestamp = new Date().toISOString()
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${this.name}]`

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
        console.error(prefix, message, data ?? '')
        break
    }
  }
}
