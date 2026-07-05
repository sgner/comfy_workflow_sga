import { useEffect, useState, useCallback } from 'react'

export interface StepEvent {
  step: number
  type: 'step_start' | 'screenshot_taken' | 'action_decided'
      | 'action_executed' | 'step_done' | 'loop_done'
      | 'error' | 'approval_required' | 'stopped'
  action?: Record<string, unknown>
  result?: { success: boolean; error?: string; data?: unknown; screenshot?: string }
  screenshot?: string
  summary?: string
  error?: string
  question?: string
  /** Full workflow JSON after canvas ops, used to sync headless browser state to user's browser. */
  workflowJson?: string
  timestamp: number
}

export function useComputerUseRunEvents(baseUrl: string) {
  const [steps, setSteps] = useState<StepEvent[]>([])
  const [isActive, setIsActive] = useState(false)
  const [eventSource, setEventSource] = useState<EventSource | null>(null)
  const [latestWorkflowJson, setLatestWorkflowJson] = useState<string | null>(null)

  const connect = useCallback(() => {
    if (eventSource) eventSource.close()

    const es = new EventSource(`${baseUrl}/api/v1/computer-use/run-events`)
    setEventSource(es)
    setIsActive(true)
    setSteps([])

    es.onmessage = (e) => {
      const event: StepEvent = JSON.parse(e.data)
      setSteps(prev => [...prev, event])
      // Capture workflow JSON for sync to user's browser canvas
      if (event.workflowJson) {
        setLatestWorkflowJson(event.workflowJson)
      }
      if (event.type === 'loop_done' || event.type === 'stopped' || event.type === 'error' || event.type === 'approval_required') {
        es.close()
        setIsActive(false)
      }
    }

    es.onerror = () => {
      es.close()
      setIsActive(false)
    }
  }, [baseUrl, eventSource])

  const disconnect = useCallback(() => {
    if (eventSource) {
      eventSource.close()
      setEventSource(null)
    }
    setIsActive(false)
  }, [eventSource])

  useEffect(() => {
    return () => {
      if (eventSource) eventSource.close()
    }
  }, [eventSource])

  return { steps, isActive, connect, disconnect, latestWorkflowJson }
}
