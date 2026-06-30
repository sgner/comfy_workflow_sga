import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ComputerUseOrchestrator } from './orchestrator.js'
import { ComputerUseSessionState } from './types.js'

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
