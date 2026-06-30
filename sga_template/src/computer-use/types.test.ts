import { describe, expect, it } from 'vitest'
import { isTerminalAction, isCanvasAction, isVisualAction } from './types.js'

describe('isTerminalAction', () => {
  it('returns true for done action', () => {
    expect(isTerminalAction({ type: 'done', summary: 'finished' })).toBe(true)
  })

  it('returns true for require_approval action', () => {
    expect(isTerminalAction({ type: 'require_approval', question: 'proceed?' })).toBe(true)
  })

  it('returns false for screenshot action', () => {
    expect(isTerminalAction({ type: 'screenshot' })).toBe(false)
  })

  it('returns false for click action', () => {
    expect(isTerminalAction({ type: 'click', x: 10, y: 20 })).toBe(false)
  })

  it('returns false for run_goal action', () => {
    expect(isTerminalAction({ type: 'run_goal', goal: 'test' })).toBe(false)
  })

  it('returns false for canvas actions', () => {
    expect(isTerminalAction({ type: 'addNode', nodeType: 'KSampler' })).toBe(false)
  })
})

describe('new action types routing', () => {
  it('run_goal is not canvas or visual', () => {
    expect(isCanvasAction({ type: 'run_goal', goal: 'test' })).toBe(false)
    expect(isVisualAction({ type: 'run_goal', goal: 'test' })).toBe(false)
  })

  it('done is not canvas or visual', () => {
    expect(isCanvasAction({ type: 'done', summary: 'finished' })).toBe(false)
    expect(isVisualAction({ type: 'done', summary: 'finished' })).toBe(false)
  })
})
