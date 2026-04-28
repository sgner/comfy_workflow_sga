import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'
import { startServer, type ServerConfig } from './app.js'

dotenvConfig({ path: resolve(process.cwd(), '.env'), override: true })

const serverConfig: ServerConfig = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  host: process.env.HOST ?? '0.0.0.0',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  apiKey: process.env.SGA_API_KEY ?? undefined,
  basePath: process.env.BASE_PATH ?? '/api/v1',
}

startServer(serverConfig)
