import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadFixture } from './fixture-loader.js'

const sampleObjectInfo = {
  CheckpointLoaderSimple: {
    name: 'CheckpointLoaderSimple', category: 'loaders',
    input: { required: { "ckpt_name": [["model1.safetensors"]] } },
    output: ['MODEL', 'CLIP', 'VAE'], output_name: ['MODEL', 'CLIP', 'VAE'],
  },
  CLIPTextEncode: {
    name: 'CLIPTextEncode', category: 'conditioning',
    input: { required: { "text": ["STRING"], "clip": ["CLIP"] } },
    output: ['CONDITIONING'], output_name: ['CONDITIONING'],
  },
}

describe('validate-workflow', () => {
  let tmpHome: string
  let tmpBaseDir: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-orch-'))
    tmpBaseDir = await fs.mkdtemp(join(tmpdir(), 'sga-comfyui-'))
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

  it('runs all 4 validators and returns combined issues', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    const { validateWorkflow } = await import('./validate-workflow.js')
    const wf = {
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['missing.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: null }] },
      ],
      links: [],
    }
    const issues = await validateWorkflow(wf)
    // Should have at least: missing_model from missing-ref validator
    const categories = new Set(issues.map(i => i.category))
    expect(categories.has('missing_model')).toBe(true)
  })

  it('deduplicates issues by id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    const { validateWorkflow } = await import('./validate-workflow.js')
    const wf = {
      nodes: [
        { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['missing.safetensors'],
          outputs: [{ name: 'MODEL', type: 'MODEL', links: null }] },
      ],
      links: [],
    }
    const issues = await validateWorkflow(wf)
    const ids = issues.map(i => i.id)
    const uniqueIds = new Set(ids)
    expect(ids.length).toBe(uniqueIds.size)
  })

  it('loads all fixtures and validates expected issue ids are present', async () => {
    const { validateWorkflow } = await import('./validate-workflow.js')
    const { listFixtures, loadFixture } = await import('./fixture-loader.js')
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
      // Clear NodeDefIndex cache file so each iteration re-fetches its own objectInfo
      await fs.rm(join(tmpHome, 'node-defs.json'), { force: true })
      vi.resetModules()
      const { validateWorkflow: validate } = await import('./validate-workflow.js')
      const issues = await validate(fixture.workflow)
      for (const expectedId of fixture.expectedIssueIds) {
        const found = issues.some(i => i.id === expectedId || i.id.startsWith(expectedId))
        expect(found, `Fixture "${name}": expected issue id "${expectedId}" not found. Got: ${issues.map(i => i.id).join(', ')}`).toBe(true)
      }
    }
  })
})
