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

  return (
    <div style={{
      border: '1px solid var(--border-color, #444)',
      borderRadius: '8px',
      padding: '12px',
      marginTop: '8px',
      maxHeight: '400px',
      overflowY: 'auto',
      background: 'var(--bg-color, #1a1a1a)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <strong>Autopilot {isActive ? '(running)' : '(finished)'}</strong>
        {isActive && (
          <button
            onClick={onStop}
            style={{
              padding: '4px 12px',
              background: '#d33',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
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
