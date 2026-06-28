import { CheckCircle2, Clipboard, RefreshCw, ServerCog, XCircle } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { fetchSystemDiagnostics, SystemDiagnostics } from '../services/configService'

interface SystemDiagnosticsPanelProps {
  backendUrl: string
  handoffSummary?: string | null
}

const statusStyles = {
  ok: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  degraded: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  failed: 'bg-red-500/15 text-red-300 border-red-500/30',
}

const SystemDiagnosticsPanel: React.FC<SystemDiagnosticsPanelProps> = ({ backendUrl, handoffSummary }) => {
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const loadDiagnostics = useCallback(async () => {
    if (!backendUrl) return
    setLoading(true)
    try {
      setDiagnostics(await fetchSystemDiagnostics(backendUrl))
    } finally {
      setLoading(false)
    }
  }, [backendUrl])

  useEffect(() => {
    void loadDiagnostics()
  }, [loadDiagnostics])

  const health = diagnostics?.status === 'ok' ? 'ok' : diagnostics ? 'degraded' : 'failed'
  const title = diagnostics ? (diagnostics.status === 'ok' ? 'System healthy' : 'System needs attention') : 'Diagnostics unavailable'

  const rows = useMemo(() => {
    if (!diagnostics) return []
    return [
      { label: 'Backend', value: `${diagnostics.backend.service} ${diagnostics.backend.nodeVersion}`, ok: diagnostics.backend.healthy },
      { label: 'Providers', value: `${diagnostics.providers.count} configured, default ${diagnostics.providers.defaultProvider ?? 'none'}`, ok: diagnostics.providers.missingKeys.length === 0 },
      { label: 'Codex', value: `${diagnostics.codex.state}${diagnostics.codex.canSwitchToCodex ? ', switchable' : ''}`, ok: diagnostics.codex.state === 'ready' || diagnostics.codex.state === 'disabled' || diagnostics.codex.state === 'unavailable' },
      { label: 'MCP', value: `${diagnostics.mcp.connected}/${diagnostics.mcp.total} connected`, ok: diagnostics.mcp.connected === diagnostics.mcp.total },
      { label: 'ComfyUI', value: diagnostics.comfyui.reachable === null ? 'not probed' : diagnostics.comfyui.reachable ? 'reachable' : 'unreachable', ok: diagnostics.comfyui.reachable !== false },
    ]
  }, [diagnostics])

  const copyJson = useCallback(async () => {
    if (!diagnostics) return
    await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [diagnostics])

  return (
    <div className="mx-3 my-2 rounded-lg border border-slate-700/60 bg-slate-900/70 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-slate-800/60 transition-colors"
      >
        <ServerCog className="w-4 h-4 text-cyan-300 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-slate-200 truncate">System Diagnostics</span>
            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${statusStyles[health]}`}>{health}</span>
          </div>
          {handoffSummary && <div className="mt-0.5 text-[10px] text-slate-400 truncate">{handoffSummary}</div>}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-800 px-3 py-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-slate-400">{title}</span>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={loadDiagnostics} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200" title="Refresh diagnostics">
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button type="button" onClick={copyJson} disabled={!diagnostics} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-40" title="Copy diagnostics JSON">
                <Clipboard className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {copied && <div className="text-[10px] text-emerald-300">Diagnostics JSON copied.</div>}

          {rows.map(row => (
            <div key={row.label} className="flex items-start gap-2 text-[10px]">
              {row.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0 mt-0.5" /> : <XCircle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />}
              <div className="min-w-0 flex-1">
                <span className="text-slate-300 font-semibold">{row.label}</span>
                <span className="text-slate-500">: </span>
                <span className="text-slate-400 break-words">{row.value}</span>
              </div>
            </div>
          ))}

          {diagnostics?.errors.length ? (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 space-y-1">
              {diagnostics.errors.slice(0, 3).map((error, index) => (
                <div key={`${error}-${index}`} className="text-[10px] text-amber-200 break-words">{error}</div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

export default SystemDiagnosticsPanel
