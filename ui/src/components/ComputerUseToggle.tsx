import { useState, useCallback } from 'react'
import { Monitor, MonitorOff, Loader2 } from 'lucide-react'

interface ComputerUseToggleProps {
  backendUrl: string
  onStateChange?: (active: boolean) => void
}

export function ComputerUseToggle({ backendUrl, onStateChange }: ComputerUseToggleProps) {
  const [active, setActive] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleToggle = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (active) {
        await import('../services/configService').then(m => m.stopComputerUse(backendUrl))
        setActive(false)
        onStateChange?.(false)
      } else {
        await import('../services/configService').then(m => m.startComputerUse(backendUrl))
        setActive(true)
        onStateChange?.(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [active, backendUrl, onStateChange])

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={handleToggle}
        disabled={loading}
        title={error ?? (active ? 'Computer Use active — click to stop' : 'Start Computer Use')}
        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1 ${
          active
            ? 'bg-purple-600 text-white hover:bg-purple-500'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : active ? (
          <Monitor className="w-3.5 h-3.5" />
        ) : (
          <MonitorOff className="w-3.5 h-3.5" />
        )}
        CU
      </button>
      {error && (
        <span className="text-[10px] text-red-400 max-w-[120px] truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  )
}
