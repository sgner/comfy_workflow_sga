import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { compileGraph } from '../graph-walker.js'

const sampleObjectInfo = {
  LoadImage: {
    name: 'LoadImage', category: 'image',
    input: { required: { image: ['STRING'] } },
    output: ['IMAGE', 'MASK'], output_name: ['IMAGE', 'MASK'],
  },
}

describe('missingMediaRule', () => {
  let tmpHome: string
  let tmpBaseDir: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-mdm-'))
    tmpBaseDir = await fs.mkdtemp(join(tmpdir(), 'sga-comfyui-'))
    vi.stubEnv('SGA_HOME', tmpHome)
    vi.stubEnv('COMFYUI_BASE_DIR', tmpBaseDir)
    vi.stubEnv('COMFYUI_API_HOST', '127.0.0.1')
    vi.stubEnv('COMFYUI_API_PORT', '8188')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => sampleObjectInfo,
    } as unknown as Response))
    vi.resetModules()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fs.rm(tmpHome, { recursive: true, force: true })
    await fs.rm(tmpBaseDir, { recursive: true, force: true })
  })

  it('returns no issues when media exists on disk', async () => {
    const inputDir = join(tmpBaseDir, 'input')
    await fs.mkdir(inputDir, { recursive: true })
    await fs.writeFile(join(inputDir, 'photo.png'), 'fake')
    const { missingMediaRule } = await import('./missing-media.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'LoadImage', widgets_values: ['photo.png'] }],
      links: [],
    })
    expect(await missingMediaRule.run(graph)).toEqual([])
  })

  it('detects missing media file', async () => {
    const { missingMediaRule } = await import('./missing-media.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'LoadImage', widgets_values: ['nonexistent.png'] }],
      links: [],
    })
    const issues = await missingMediaRule.run(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('missing_media:1')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].category).toBe('missing_media')
    expect(issues[0].source).toBe('native')
  })

  it('skips non-media-loader nodes', async () => {
    const { missingMediaRule } = await import('./missing-media.js')
    const graph = compileGraph({
      nodes: [{ id: 1, type: 'KSampler', widgets_values: ['something'] }],
      links: [],
    })
    expect(await missingMediaRule.run(graph)).toEqual([])
  })
})
