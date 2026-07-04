import { CheckCircle2, Circle, Loader2, Square } from 'lucide-react'
import { useState } from 'react'
import type { StepEvent } from '../hooks/useComputerUseRunEvents'

interface AutopilotStepFlowProps {
  steps: StepEvent[]
  isActive: boolean
  onStop: () => void
}

export function AutopilotStepFlow({ steps, isActive, onStop }: AutopilotStepFlowProps) {
  const [enlargedScreenshot, setEnlargedScreenshot] = useState<string | null>(null)

  if (steps.length === 0 && !isActive) return null

  // Pick a status color + icon based on the latest event in the run
  const lastEvent = steps[steps.length - 1]
  const isError = lastEvent?.type === 'error'
  const isFinished = !isActive && (lastEvent?.type === 'loop_done' || lastEvent?.type === 'stopped' || lastEvent?.type === 'approval_required')

  const statusColor = isActive
    ? { fg: '#a5b4fc', border: 'rgba(99, 102, 241, 0.45)', bg: 'rgba(99, 102, 241, 0.12)' }
    : isError
    ? { fg: '#fca5a5', border: 'rgba(239, 68, 68, 0.45)', bg: 'rgba(239, 68, 68, 0.12)' }
    : { fg: '#86efac', border: 'rgba(16, 185, 129, 0.45)', bg: 'rgba(16, 185, 129, 0.12)' }

  const statusLabel = isActive ? 'Live' : isError ? 'Error' : isFinished ? 'Finished' : 'Idle'
  const statusIcon = isActive
    ? <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: statusColor.fg }} />
    : isError
    ? <Circle className="w-3.5 h-3.5" style={{ color: statusColor.fg, fill: statusColor.fg }} />
    : <CheckCircle2 className="w-3.5 h-3.5" style={{ color: statusColor.fg }} />

  return (
    <div style={{
      border: `1px solid ${statusColor.border}`,
      borderRadius: '10px',
      padding: '12px',
      marginTop: '8px',
      maxHeight: '480px',
      overflowY: 'auto',
      background: 'rgba(15, 23, 42, 0.6)',
      backdropFilter: 'blur(4px)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '3px 8px',
            borderRadius: '999px',
            fontSize: '11px', fontWeight: 600,
            color: statusColor.fg,
            background: statusColor.bg,
            border: `1px solid ${statusColor.border}`,
          }}>
            {statusIcon}
            {statusLabel}
          </span>
          <span style={{ fontSize: '11px', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
            {steps.length} {steps.length === 1 ? 'step' : 'steps'}
          </span>
        </div>
        {isActive && (
          <button
            onClick={onStop}
            title="Stop the run"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              padding: '4px 10px',
              background: '#dc2626', color: 'white',
              border: 'none', borderRadius: '6px',
              cursor: 'pointer', fontSize: '11px', fontWeight: 600,
            }}
          >
            <Square className="w-3 h-3" fill="currentColor" />
            Stop
          </button>
        )}
      </div>

      {steps.map((event, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '6px', fontSize: '13px' }}>
          <span style={{ color: '#888', minWidth: '32px' }}>#{event.step + 1}</span>
          {event.screenshot && (
            <img
              src={`data:image/png;base64,${event.screenshot}`}
              alt={`Step ${event.step + 1} screenshot`}
              onClick={() => setEnlargedScreenshot(event.screenshot!)}
              style={{
                width: '60px',
                height: '40px',
                objectFit: 'cover',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            />
          )}
          <div style={{ flex: 1 }}>
            <span style={{ color: event.type === 'error' ? '#f66' : event.type === 'loop_done' ? '#6f6' : '#ccc' }}>
              {event.type.replace(/_/g, ' ')}
            </span>
            {event.action && (
              <span style={{ color: '#88f', marginLeft: '4px' }}>
                {(event.action as { type: string }).type}
              </span>
            )}
            {event.summary && <div style={{ color: '#6f6' }}>{event.summary}</div>}
            {event.error && <div style={{ color: '#f66' }}>{event.error}</div>}
            {event.question && <div style={{ color: '#ff6' }}>Approval: {event.question}</div>}
          </div>
        </div>
      ))}

      {enlargedScreenshot && (
        <div
          onClick={() => setEnlargedScreenshot(null)}
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            cursor: 'pointer',
          }}
        >
          <img
            src={`data:image/png;base64,${enlargedScreenshot}`}
            alt="Enlarged screenshot"
            style={{ maxWidth: '90%', maxHeight: '90%' }}
          />
        </div>
      )}
    </div>
  )
}
