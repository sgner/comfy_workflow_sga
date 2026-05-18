import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'
import { startServer, type ServerConfig } from './app.js'
import { initFileLogging, shutdownFileLogging } from '../utils/logger.js'
import { getSessionStore } from './session-store.js'

dotenvConfig({ path: resolve(process.cwd(), '.env'), override: true })

const logDir = process.env.LOG_DIR ?? resolve(process.cwd(), 'logs')
const enableFileLog = process.env.LOG_ENABLE_FILE !== 'false'
initFileLogging(logDir, enableFileLog)

const serverConfig: ServerConfig = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  host: process.env.HOST ?? '0.0.0.0',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  apiKey: process.env.SGA_API_KEY ?? undefined,
  basePath: process.env.BASE_PATH ?? '/api/v1',
}

async function gracefulShutdown(): Promise<void> {
  const store = getSessionStore()
  await store.shutdown()
  shutdownFileLogging()
  process.exit(0)
}

process.on('SIGINT', () => {
  gracefulShutdown().catch(() => process.exit(1))
})

process.on('SIGTERM', () => {
  gracefulShutdown().catch(() => process.exit(1))
})

startServer(serverConfig)
