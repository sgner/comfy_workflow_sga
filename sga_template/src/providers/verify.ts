/**
 * Provider 验证 & 模型拉取工具
 *
 * 用于 API 配置 UI 的「验证地址 / 验证协议 / 拉取模型」三步：
 * 1. verifyAddress  - 测试 baseUrl 的可达性
 * 2. verifyProtocol - 测试协议兼容性（OpenAI / 异步 / Gemini）
 * 3. fetchModels    - 从上游拉取模型列表
 *
 * 设计原则：尽量不依赖 SGA 内部 provider 体系，
 * 因为用户在配置前还没有创建 provider 实例。
 */

import { createLogger } from '../utils/logger.js'
import { normalizeProviderConfig } from './provider-store.js'
import type { StoredProviderConfig } from './provider-store.js'

const logger = createLogger('provider-verify')

export type ProtocolType = 'openai' | 'async' | 'gemini' | 'custom'

export interface VerifyAddressResult {
  ok: boolean
  message: string
  /** 服务端返回的状态码(若可达) */
  status?: number
  /** 响应时间 (ms) */
  latencyMs?: number
}

export interface VerifyProtocolResult {
  ok: boolean
  message: string
  protocol: ProtocolType
  /** 后端识别到的具体 endpoint */
  endpoint?: string
  status?: number
  latencyMs?: number
}

export interface RemoteModel {
  /** Provider 的模型 ID (OpenAI: id, Gemini: name 后缀) */
  id: string
  /** 人类可读名称 */
  displayName?: string
  /** 模型归属(owner/createdBy) */
  owner?: string
  /** 上下文长度(若可获取) */
  contextWindow?: number
  /** 是否支持 vision */
  supportsVision?: boolean
  /** 是否支持 tool use */
  supportsToolUse?: boolean
  /** 是否支持 streaming */
  supportsStreaming?: boolean
  /** 是否支持 thinking */
  supportsThinking?: boolean
  /** 原始数据(供高级用户查看) */
  raw?: unknown
}

export interface FetchModelsResult {
  ok: boolean
  message: string
  models: RemoteModel[]
  protocol: ProtocolType
}

export interface VerifyAndAddResult {
  addressOk: boolean
  protocolOk: boolean
  fetchOk: boolean
  models: RemoteModel[]
  protocol: ProtocolType
  errors: string[]
  warnings: string[]
}

interface VerifyInputs {
  baseUrl: string
  apiKey: string
  protocol: ProtocolType
  /** 异步协议 (如 doubao) 的 host */
  asyncHost?: string
  /** 异步协议的 region (如 cn-north-1) */
  asyncRegion?: string
  /** 自定义协议:chat 端点路径(相对于 baseUrl) */
  customChatEndpoint?: string
  /** 自定义协议:models 端点路径(相对于 baseUrl) */
  customModelsEndpoint?: string
  /** 自定义协议:额外 headers (JSON 字符串) */
  customHeaders?: string
  /** 超时毫秒 */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT = 10_000

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

function joinUrl(base: string, path: string): string {
  const b = stripTrailingSlash(base)
  if (!path) return b
  if (path.startsWith('/')) return b + path
  return b + '/' + path
}

function pickEndpointForModels(protocol: ProtocolType, inputs: VerifyInputs): string {
  switch (protocol) {
    case 'openai':
    case 'async':
    case 'custom':
      return joinUrl(inputs.baseUrl, inputs.customModelsEndpoint || '/models')
    case 'gemini':
      // Gemini: {baseUrl}/v1beta/models?key=...
      const base = inputs.baseUrl || 'https://generativelanguage.googleapis.com'
      return joinUrl(base, '/v1beta/models')
  }
}

function pickEndpointForChat(protocol: ProtocolType, inputs: VerifyInputs): string {
  switch (protocol) {
    case 'openai':
    case 'async':
      return joinUrl(inputs.baseUrl, '/chat/completions')
    case 'gemini':
      const base = inputs.baseUrl || 'https://generativelanguage.googleapis.com'
      return joinUrl(base, '/v1beta/models/gemini-2.5-flash:generateContent')
    case 'custom':
      return joinUrl(inputs.baseUrl, inputs.customChatEndpoint || '/chat/completions')
  }
}

function buildHeaders(protocol: ProtocolType, inputs: VerifyInputs): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'comfy-workflow-agent/1.0',
  }

  switch (protocol) {
    case 'openai':
    case 'async':
    case 'custom':
      if (inputs.apiKey) {
        headers['Authorization'] = `Bearer ${inputs.apiKey}`
      }
      break
    case 'gemini': {
      // Gemini 使用 ?key=xxx,不在 header
      break
    }
  }

  if (inputs.customHeaders && protocol === 'custom') {
    try {
      const parsed = JSON.parse(inputs.customHeaders) as Record<string, string>
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') {
          headers[k] = v.replace(/\$apiKey/g, inputs.apiKey ?? '')
        }
      }
    } catch (err) {
      logger.warn(`customHeaders 解析失败: ${(err as Error).message}`)
    }
  }

  return headers
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<{ res: Response; latencyMs: number }> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  const start = Date.now()
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    const latencyMs = Date.now() - start
    return { res, latencyMs }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Step 1: 验证地址可达性
 * 简单 GET {baseUrl}/models (或 Gemini 的 list models),不要求业务成功
 */
export async function verifyAddress(inputs: VerifyInputs): Promise<VerifyAddressResult> {
  const timeout = inputs.timeoutMs ?? DEFAULT_TIMEOUT
  const protocol = inputs.protocol || 'openai'
  if (!inputs.baseUrl) {
    return { ok: false, message: 'baseUrl 不能为空' }
  }
  const url = pickEndpointForModels(protocol, inputs)
  const headers = buildHeaders(protocol, inputs)
  const start = Date.now()
  try {
    const { res, latencyMs } = await fetchWithTimeout(url, { method: 'GET', headers }, timeout)
    if (res.status === 401 || res.status === 403) {
      // 地址可达,但鉴权失败(可能需要 key)
      return {
        ok: true,
        status: res.status,
        latencyMs,
        message: `地址可达 (${res.status}) - 需要有效 API Key`,
      }
    }
    if (res.status >= 200 && res.status < 500) {
      return {
        ok: true,
        status: res.status,
        latencyMs,
        message: `地址可达 (${res.status})`,
      }
    }
    return {
      ok: false,
      status: res.status,
      latencyMs,
      message: `地址返回 ${res.status}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - start
    if (msg.includes('abort')) {
      return { ok: false, message: `地址超时 (${timeout}ms)`, latencyMs }
    }
    return { ok: false, message: `地址不可达: ${msg}`, latencyMs }
  }
}

/**
 * Step 2: 验证协议兼容性
 * 发一个最小的 chat 请求,检查响应是否符合 OpenAI / Gemini 协议
 */
export async function verifyProtocol(inputs: VerifyInputs): Promise<VerifyProtocolResult> {
  const timeout = inputs.timeoutMs ?? DEFAULT_TIMEOUT
  const protocol = inputs.protocol || 'openai'
  if (!inputs.apiKey) {
    return { ok: false, protocol, message: '需要 API Key 才能验证协议' }
  }
  const url = pickEndpointForChat(protocol, inputs)
  const headers = buildHeaders(protocol, inputs)

  let body: string = ''
  switch (protocol) {
    case 'openai':
    case 'async':
    case 'custom':
      body = JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      })
      break
    case 'gemini':
      // Gemini: ?key=APIKEY
      body = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 },
      })
      break
  }

  let finalUrl = url
  if (protocol === 'gemini' && inputs.apiKey) {
    finalUrl = url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(inputs.apiKey)
  }

  try {
    const { res, latencyMs } = await fetchWithTimeout(
      finalUrl,
      { method: 'POST', headers, body },
      timeout,
    )
    if (res.status === 200) {
      // 检查 body 是否符合协议
      const text = await res.text()
      let parsedOk = false
      let detail = ''
      if (protocol === 'gemini') {
        try {
          const j = JSON.parse(text)
          parsedOk = !!(j.candidates || j.modelVersion)
          detail = parsedOk ? 'Gemini 协议响应正常' : '响应缺少 candidates 字段'
        } catch {
          detail = '响应不是合法 JSON'
        }
      } else {
        try {
          const j = JSON.parse(text)
          parsedOk = !!(j.choices || j.id)
          detail = parsedOk ? 'OpenAI 协议响应正常' : '响应缺少 choices 字段'
        } catch {
          detail = '响应不是合法 JSON'
        }
      }
      return {
        ok: parsedOk,
        protocol,
        endpoint: url,
        status: res.status,
        latencyMs,
        message: parsedOk ? detail : `协议不匹配: ${detail}`,
      }
    }
    const errText = (await res.text()).slice(0, 200)
    return {
      ok: false,
      protocol,
      endpoint: url,
      status: res.status,
      latencyMs,
      message: `协议验证失败 (HTTP ${res.status}): ${errText}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('abort')) {
      return { ok: false, protocol, endpoint: url, message: `协议验证超时 (${timeout}ms)` }
    }
    return { ok: false, protocol, endpoint: url, message: `协议验证失败: ${msg}` }
  }
}

/**
 * Step 3: 拉取模型列表
 * 解析上游 {baseUrl}/models 响应为 RemoteModel[]
 */
export async function fetchRemoteModels(inputs: VerifyInputs): Promise<FetchModelsResult> {
  const timeout = inputs.timeoutMs ?? DEFAULT_TIMEOUT
  const protocol = inputs.protocol || 'openai'
  if (!inputs.baseUrl) {
    return { ok: false, protocol, models: [], message: 'baseUrl 不能为空' }
  }
  let url = pickEndpointForModels(protocol, inputs)
  const headers = buildHeaders(protocol, inputs)

  if (protocol === 'gemini' && inputs.apiKey) {
    url = url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(inputs.apiKey)
  }

  try {
    const { res, latencyMs } = await fetchWithTimeout(url, { method: 'GET', headers }, timeout)
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300)
      return {
        ok: false,
        protocol,
        models: [],
        message: `拉取模型失败 (HTTP ${res.status}): ${errText}`,
      }
    }
    const text = await res.text()
    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, protocol, models: [], message: `响应不是合法 JSON: ${text.slice(0, 200)}` }
    }

    const models = parseModelList(protocol, parsed)
    return {
      ok: true,
      protocol,
      models,
      message: `成功拉取 ${models.length} 个模型 (${latencyMs}ms)`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('abort')) {
      return { ok: false, protocol, models: [], message: `拉取模型超时 (${timeout}ms)` }
    }
    return { ok: false, protocol, models: [], message: `拉取模型失败: ${msg}` }
  }
}

function parseModelList(protocol: ProtocolType, parsed: any): RemoteModel[] {
  const out: RemoteModel[] = []
  if (protocol === 'gemini') {
    const items: any[] = parsed.models || []
    for (const it of items) {
      // name 形如 "models/gemini-2.5-flash"
      const id = typeof it.name === 'string' ? it.name.replace(/^models\//, '') : ''
      if (!id) continue
      out.push({
        id,
        displayName: it.displayName || id,
        supportsVision: Array.isArray(it.supportedGenerationMethods)
          ? it.supportedGenerationMethods.includes('generateContent')
          : undefined,
        raw: it,
      })
    }
    return out
  }
  // OpenAI / async / custom: data: [{id, owned_by, ...}]
  const items: any[] = parsed.data || parsed.models || []
  for (const it of items) {
    if (typeof it.id !== 'string') continue
    // 过滤掉非 chat 模型
    const id = it.id
    out.push({
      id,
      displayName: it.display_name || id,
      owner: it.owned_by || it.owner,
      contextWindow: typeof it.context_window === 'number' ? it.context_window : undefined,
      raw: it,
    })
  }
  return out
}

/**
 * 一站式: 验证地址 -> 验证协议 -> 拉取模型 -> 写回配置
 */
export async function verifyAndAdd(
  rawConfig: Record<string, unknown>,
): Promise<VerifyAndAddResult> {
  const errors: string[] = []
  const warnings: string[] = []

  // 从 rawConfig 提取验证参数
  const baseUrl = (rawConfig.baseUrl ?? rawConfig.base_url ?? '') as string
  const apiKey = (rawConfig.apiKey ?? rawConfig.api_key ?? '') as string
  const protocol = ((rawConfig.protocol as ProtocolType) ?? 'openai') as ProtocolType
  const asyncHost = (rawConfig.asyncHost ?? rawConfig.async_host ?? '') as string
  const asyncRegion = (rawConfig.asyncRegion ?? rawConfig.async_region ?? '') as string
  const customChatEndpoint = (rawConfig.customChatEndpoint ?? rawConfig.custom_chat_endpoint ?? '') as string
  const customModelsEndpoint = (rawConfig.customModelsEndpoint ?? rawConfig.custom_models_endpoint ?? '') as string
  const customHeaders = (rawConfig.customHeaders ?? rawConfig.custom_headers ?? '') as string

  const verifyInputs: VerifyInputs = {
    baseUrl,
    apiKey,
    protocol,
    asyncHost,
    asyncRegion,
    customChatEndpoint,
    customModelsEndpoint,
    customHeaders,
  }

  // Step 1: 验证地址
  const addressResult = await verifyAddress(verifyInputs)
  if (!addressResult.ok) {
    errors.push(`验证地址失败: ${addressResult.message}`)
    return {
      addressOk: false,
      protocolOk: false,
      fetchOk: false,
      models: [],
      protocol,
      errors,
      warnings,
    }
  }

  // Step 2: 验证协议 (有 key 时才验证)
  let protocolOk = true
  if (apiKey) {
    const protocolResult = await verifyProtocol(verifyInputs)
    protocolOk = protocolResult.ok
    if (!protocolOk) {
      errors.push(`验证协议失败: ${protocolResult.message}`)
      warnings.push('地址可达但协议不匹配,请检查请求格式/端点')
    }
  } else {
    warnings.push('未提供 API Key,跳过协议验证')
  }

  // Step 3: 拉取模型(如果 body 已经带了 modelConfigs / models,则跳过重新拉取)
  let models: RemoteModel[] = []
  let fetchOk = true
  const providedModels = (rawConfig.modelConfigs ?? rawConfig.model_configs) as
    | Record<string, unknown>
    | undefined
  const providedModelList = (rawConfig.models as unknown[] | undefined) ?? undefined
  const hasProvidedModels =
    (providedModels && Object.keys(providedModels).length > 0) ||
    (providedModelList && providedModelList.length > 0)

  if (!hasProvidedModels && protocolOk) {
    const fetchResult = await fetchRemoteModels(verifyInputs)
    fetchOk = fetchResult.ok
    models = fetchResult.models
    if (!fetchOk) {
      errors.push(`拉取模型失败: ${fetchResult.message}`)
    }
  } else if (hasProvidedModels) {
    // 复用 client 已经拉到的模型,转换为 RemoteModel 格式
    const sourceMap = (providedModels as Record<string, any>) || {}
    models = Object.values(sourceMap).map((m: any) => ({
      id: m.id,
      displayName: m.displayName || m.id,
      contextWindow: m.contextWindow,
      supportsVision: m.supportsVision,
      supportsToolUse: m.supportsToolUse,
      supportsStreaming: m.supportsStreaming,
      supportsThinking: m.supportsThinking,
    }))
    fetchOk = true
  }

  return {
    addressOk: true,
    protocolOk,
    fetchOk,
    models,
    protocol,
    errors,
    warnings,
  }
}

/**
 * 把 RemoteModel[] 转换为 SGA StoredProviderConfig 中的 modelConfigs
 */
export function remoteModelsToStoredModelConfigs(
  models: RemoteModel[],
): Record<string, import('./types.js').ModelConfig> {
  const result: Record<string, import('./types.js').ModelConfig> = {}
  for (const m of models) {
    result[m.id] = {
      id: m.id,
      displayName: m.displayName || m.id,
      contextWindow: m.contextWindow,
      supportsVision: m.supportsVision,
      supportsToolUse: m.supportsToolUse,
      supportsStreaming: m.supportsStreaming,
      supportsThinking: m.supportsThinking,
      inputPricePerMToken: 0,
      outputPricePerMToken: 0,
    }
  }
  return result
}

/**
 * 工具: 从请求 body 解析出 VerifyInputs
 */
export function parseVerifyInputsFromBody(body: Record<string, unknown>): VerifyInputs {
  return {
    baseUrl: ((body.baseUrl ?? body.base_url ?? '') as string) || '',
    apiKey: ((body.apiKey ?? body.api_key ?? '') as string) || '',
    protocol: ((body.protocol ?? 'openai') as ProtocolType),
    asyncHost: body.asyncHost as string | undefined,
    asyncRegion: body.asyncRegion as string | undefined,
    customChatEndpoint: body.customChatEndpoint as string | undefined,
    customModelsEndpoint: body.customModelsEndpoint as string | undefined,
    customHeaders: body.customHeaders as string | undefined,
    timeoutMs: body.timeoutMs as number | undefined,
  }
}
