import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { WorkflowIssue } from '../../issue-types.js'

describe('validate-workflow', () => {
  let tmpHome: string
  let tmpBaseDir: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-gw-orch-'))
    tmpBaseDir = await fs.mkdtemp(join(tmpdir(), 'sga-gw-comfyui-'))
    vi.stubEnv('SGA_HOME', tmpHome)
    vi.stubEnv('COMFYUI_BASE_DIR', tmpBaseDir)
    vi.stubEnv('COMFYUI_API_HOST', '127.0.0.1')
    vi.stubEnv('COMFYUI_API_PORT', '8188')
    vi.resetModules()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fs.rm(tmpHome, { recursive: true, force: true })
    await fs.rm(tmpBaseDir, { recursive: true, force: true })
  })

  it('returns empty issues for empty workflow', async () => {
    const { validateWorkflow } = await import('./validate-workflow.js')
    const issues = await validateWorkflow({ nodes: [], links: [] })
    expect(issues).toEqual([])
  })

  it('deduplicates issues by id', async () => {
    const { RULES } = await import('./validator-registry.js')
    const mockIssue: WorkflowIssue = {
      id: 'test:1', nodeId: 1, severity: 'info', message: 'test', source: 'native',
    }
    RULES.push({
      id: 'mockDuplicate',
      run: () => [mockIssue, { ...mockIssue }],
    })
    const { validateWorkflow } = await import('./validate-workflow.js')
    const issues = await validateWorkflow({ nodes: [], links: [] })
    expect(issues.filter(i => i.id === 'test:1')).toHaveLength(1)
  })

  it('loads all fixtures and validates expected issue ids are present', async () => {
    const { listFixtures, loadFixture } = await import('../fixture-loader.js')
    for (const name of listFixtures()) {
      const fixture = loadFixture(name)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => fixture.objectInfo,
      } as unknown as Response))
      // Create model files on disk
      for (const [category, names] of Object.entries(fixture.models)) {
        for (const modelName of names) {
          const dir = join(tmpBaseDir, 'models', category)
          await fs.mkdir(dir, { recursive: true })
          await fs.writeFile(join(dir, modelName), 'fake')
        }
      }
      // Create media files on disk
      for (const mediaName of fixture.input) {
        const dir = join(tmpBaseDir, 'input')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(join(dir, mediaName), 'fake')
      }
      // Cache isolation fix: clear node-defs.json so each iteration re-fetches its own objectInfo
      await fs.rm(join(tmpHome, 'node-defs.json'), { force: true })
      vi.resetModules()
      const { validateWorkflow } = await import('./validate-workflow.js')
      const issues = await validateWorkflow(fixture.workflow)
      for (const expectedId of fixture.expectedIssueIds) {
        const found = issues.some(i => i.id === expectedId || i.id.startsWith(expectedId))
        expect(found, `Fixture "${name}": expected issue id "${expectedId}" not found. Got: ${issues.map(i => i.id).join(', ')}`).toBe(true)
      }
    }
  })
})
