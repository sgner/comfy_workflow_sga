import type { LLMProvider, ProviderConfig, RequestTransformer, ResponseTransformer, StreamChunkTransformer } from './types.js'
import { ProviderRequestError } from './anthropic.js'

const loadedModules: Map<string, unknown> = new Map()

export async function loadProviderModule(modulePath: string): Promise<new (config: Omit<ProviderConfig, 'name'> & { name?: string }) => LLMProvider> {
  const cached = loadedModules.get(modulePath)
  if (cached) return cached as new (config: Omit<ProviderConfig, 'name'> & { name?: string }) => LLMProvider

  try {
    const absolutePath = resolveModulePath(modulePath)
    const module = await import(absolutePath)

    const ProviderClass = module.default ?? module.Provider ?? module[Object.keys(module)[0]]

    if (typeof ProviderClass !== 'function') {
      throw new Error(`Module "${modulePath}" does not export a valid Provider class`)
    }

    loadedModules.set(modulePath, ProviderClass)
    return ProviderClass as new (config: Omit<ProviderConfig, 'name'> & { name?: string }) => LLMProvider
  } catch (error) {
    throw new Error(
      `Failed to load provider module "${modulePath}": ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export async function loadRequestTransformer(modulePath: string): Promise<RequestTransformer | undefined> {
  try {
    const absolutePath = resolveModulePath(modulePath)
    const module = await import(absolutePath)
    const transformer = module.default ?? module.requestTransformer ?? module.transform
    if (typeof transformer !== 'function') return undefined
    return transformer as RequestTransformer
  } catch {
    return undefined
  }
}

export async function loadResponseTransformer(modulePath: string): Promise<ResponseTransformer | undefined> {
  try {
    const absolutePath = resolveModulePath(modulePath)
    const module = await import(absolutePath)
    const transformer = module.default ?? module.responseTransformer ?? module.transform
    if (typeof transformer !== 'function') return undefined
    return transformer as ResponseTransformer
  } catch {
    return undefined
  }
}

export async function loadStreamChunkTransformer(modulePath: string): Promise<StreamChunkTransformer | undefined> {
  try {
    const absolutePath = resolveModulePath(modulePath)
    const module = await import(absolutePath)
    const transformer = module.default ?? module.streamChunkTransformer ?? module.transform
    if (typeof transformer !== 'function') return undefined
    return transformer as StreamChunkTransformer
  } catch {
    return undefined
  }
}

function resolveModulePath(modulePath: string): string {
  if (modulePath.startsWith('.') || modulePath.startsWith('/') || modulePath.match(/^[A-Z]:\\/)) {
    return require('path').resolve(process.cwd(), modulePath)
  }
  return modulePath
}

export function clearLoadedModules(): void {
  loadedModules.clear()
}

export { ProviderRequestError }
