import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { HandoffStore } from './store.js'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('HandoffStore audit records', () => {
  it('writes, reads, and clears audit metadata without message bodies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sga-handoff-'))
    tempDirs.push(dir)
    const store = new HandoffStore({ sgaHome: dir })

    await store.writeAudit({
      sessionId: 'session/with unsafe chars',
      fromAgent: 'sga',
      toAgent: 'codex',
      switchedAt: 1782576000000,
      activeAgent: 'codex',
      lastExport: {
        ok: true,
        sourceAgent: 'sga',
        messageCount: 12,
        keyFactCount: 4,
      },
      lastImport: {
        ok: true,
        targetAgent: 'codex',
      },
      warnings: [],
      errors: [],
    })

    const audit = await store.readAudit('session/with unsafe chars')
    expect(audit?.lastExport.messageCount).toBe(12)
    expect(JSON.stringify(audit)).not.toContain('unsafe chars message body')

    await store.clear('session/with unsafe chars')
    await expect(store.readAudit('session/with unsafe chars')).resolves.toBeNull()
  })
})
