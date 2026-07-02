/**
 * Shared ComfyUI API base URL — single source of truth.
 * Standardize on COMFYUI_API_HOST/PORT (matching the agent tool).
 */
export const COMFYUI_DEFAULT_TIMEOUT_MS = 30000

export function getComfyUIApiBaseUrl(): string {
  const host = (process.env.COMFYUI_API_HOST || '127.0.0.1').replace(/\/+$/, '')
  const port = process.env.COMFYUI_API_PORT || '8188'
  return `http://${host}:${port}`
}
