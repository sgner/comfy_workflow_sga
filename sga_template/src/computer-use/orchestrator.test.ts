import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ComputerUseOrchestrator } from './orchestrator.js'
import { ComputerUseSessionState } from './types.js'
import type { ComputerUseAdapter, ComputerUseAction, StepEvent } from './types.js'

// Mock playwright
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(undefined),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))

describe('ComputerUseOrchestrator', () => {
  let orchestrator: ComputerUseOrchestrator

  beforeEach(() => {
    orchestrator = new ComputerUseOrchestrator({
      comfyuiUrl: 'http://127.0.0.1:8188',
      headless: true,  // use headless in tests
      sessionTimeoutMs: 5000,
    })
  })

  afterEach(async () => {
    await orchestrator.stop()
  })

  it('starts in idle state', () => {
    expect(orchestrator.getStatus().state).toBe('idle')
  })

  it('transitions to ready after start()', async () => {
    await orchestrator.start()
    expect(orchestrator.getStatus().state).toBe('ready')
    expect(orchestrator.getStatus().browserConnected).toBe(true)
  })

  it('transitions to stopped after stop()', async () => {
    await orchestrator.start()
    await orchestrator.stop()
    expect(orchestrator.getStatus().state).toBe('stopped')
    expect(orchestrator.getStatus().browserConnected).toBe(false)
  })

  it('returns a screenshot from takeScreenshot()', async () => {
    await orchestrator.start()
    const screenshot = await orchestrator.takeScreenshot()
    expect(screenshot).toBeTruthy()
    expect(typeof screenshot).toBe('string')
  })

  it('throws when takeScreenshot() called before start()', async () => {
    await expect(orchestrator.takeScreenshot()).rejects.toThrow(/not started|idle/i)
  })

  it('throws when start() called twice without stop()', async () => {
    await orchestrator.start()
    await expect(orchestrator.start()).rejects.toThrow(/already running/i)
  })
})

describe('ComputerUseOrchestrator.runGoal', () => {
  // Helper: create a mock adapter with a scripted sequence of actions
  function createMockAdapter(actions: ComputerUseAction[]): ComputerUseAdapter {
    let callIndex = 0
    return {
      name: 'mock',
      sendScreenshotAndGetCurrentAction: vi.fn().mockImplementation(async () => {
        const action = actions[callIndex] ?? { type: 'done', summary: 'default done' }
        callIndex++
        return action
      }),
      interpretActionResult: vi.fn().mockReturnValue('mock feedback'),
    }
  }

  it('terminates when adapter returns done action', async () => {
    const orchestrator = new ComputerUseOrchestrator()
    // Mock start() by setting internal state — use a spy
    ;(orchestrator as any).state = 'ready'
    ;(orchestrator as any).page = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    }
    const adapter = createMockAdapter([
      { type: 'screenshot' },
      { type: 'done', summary: 'Task completed' },
    ])

    const events: StepEvent[] = []
    for await (const event of orchestrator.runGoal('test goal', { adapter, maxSteps: 5 })) {
      events.push(event)
    }

    const doneEvent = events.find(e => e.type === 'loop_done')
    expect(doneEvent).toBeDefined()
    expect((doneEvent as StepEvent).summary).toBe('Task completed')
  })

  it('terminates when maxSteps is reached', async () => {
    const orchestrator = new ComputerUseOrchestrator()
    ;(orchestrator as any).state = 'ready'
    ;(orchestrator as any).page = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
      mouse: { click: vi.fn().mockResolvedValue(undefined) },
    }
    // Adapter never returns done — always clicks
    const adapter = createMockAdapter([
      { type: 'click', x: 0, y: 0 },
      { type: 'click', x: 1, y: 1 },
      { type: 'click', x: 2, y: 2 },
    ])

    const events: StepEvent[] = []
    for await (const event of orchestrator.runGoal('test goal', { adapter, maxSteps: 2 })) {
      events.push(event)
    }

    const doneEvent = events.find(e => e.type === 'loop_done')
    expect(doneEvent).toBeDefined()
    expect((doneEvent as StepEvent).summary).toMatch(/max steps/i)
    expect((doneEvent as StepEvent).step).toBe(2)
  })

  it('terminates after 3 consecutive failures', async () => {
    const orchestrator = new ComputerUseOrchestrator()
    ;(orchestrator as any).state = 'ready'
    ;(orchestrator as any).page = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    }
    // Adapter returns scroll (not implemented) 3 times
    const adapter = createMockAdapter([
      { type: 'scroll', dx: 0, dy: 0 },
      { type: 'scroll', dx: 0, dy: 0 },
      { type: 'scroll', dx: 0, dy: 0 },
    ])
    // Mock executeAction to always fail
    vi.spyOn(orchestrator, 'executeAction').mockResolvedValue({
      success: false,
      error: 'not implemented',
      action: { type: 'scroll', dx: 0, dy: 0 },
    })

    const events: StepEvent[] = []
    for await (const event of orchestrator.runGoal('test goal', { adapter, maxSteps: 10 })) {
      events.push(event)
    }

    const errorEvent = events.find(e => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as StepEvent).error).toMatch(/consecutive.*fail/i)
  })

  it('throws if state is not ready', async () => {
    const orchestrator = new ComputerUseOrchestrator()
    // state is 'idle' by default
    const adapter = createMockAdapter([])

    await expect(async () => {
      for await (const _event of orchestrator.runGoal('test', { adapter })) {
        // should not iterate
      }
    }).rejects.toThrow(/not ready/i)
  })

  it('rejects nested run_goal action from adapter', async () => {
    const orchestrator = new ComputerUseOrchestrator()
    ;(orchestrator as any).state = 'ready'
    ;(orchestrator as any).page = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    }
    const adapter = createMockAdapter([
      { type: 'run_goal', goal: 'nested' },
    ])

    const events: StepEvent[] = []
    for await (const event of orchestrator.runGoal('test', { adapter, maxSteps: 5 })) {
      events.push(event)
    }

    const errorEvent = events.find(e => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as StepEvent).error).toMatch(/nested/i)
  })
})
