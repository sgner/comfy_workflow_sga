import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const sampleObjectInfo = {
  CheckpointLoaderSimple: {
    name: 'CheckpointLoaderSimple', category: 'loaders',
    input: { required: { ckpt_name: [['model1.safetensors', 'model2.safetensors']] } },
    output: ['MODEL', 'CLIP', 'VAE'], output_name: ['MODEL', 'CLIP', 'VAE'],
  },
  LoraLoader: {
    name: 'LoraLoader', category: 'loaders',
    input: { required: { model: ['MODEL'], clip: ['CLIP'], lora_name: [['style.safetensors']] } },
    output: ['MODEL', 'CLIP'], output_name: ['MODEL', 'CLIP'],
  },
  LoadImage: {
    name: 'LoadImage', category: 'image',
    input: { required: { image: ['STRING'] } },
    output: ['IMAGE', 'MASK'], output_name: ['IMAGE', 'MASK'],
  },
}

async function createModelFile(baseDir: string, category: string, name: string): Promise<void> {
  const dir = join(baseDir, 'models', category)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, name), 'fake')
}

function makeWorkflow(nodes: any[], links: any[]) {
  return { nodes, links, last_node_id: nodes.length, last_link_id: links.length }
}

describe('missing-ref-validator', () => {
  let tmpHome: string
  let tmpBaseDir: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-missing-ref-'))
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

  it('returns empty for clean workflow with all models present', async () => {
    await createModelFile(tmpBaseDir, 'checkpoints', 'model1.safetensors')
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['model1.safetensors'],
        outputs: [{ name: 'MODEL', type: 'MODEL', links: null }] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toEqual([])
  })

  it('detects missing checkpoint model', async () => {
    await createModelFile(tmpBaseDir, 'checkpoints', 'model1.safetensors')
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['nonexistent.safetensors'],
        outputs: [{ name: 'MODEL', type: 'MODEL', links: null }] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].category).toBe('missing_model')
    expect(issues[0].nodeId).toBe(1)
    expect(issues[0].message).toMatch(/nonexistent\.safetensors/)
    expect(issues[0].source).toBe('native')
  })

  it('detects missing lora model', async () => {
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'LoraLoader', widgets_values: ['missing_lora.safetensors', 0.8, 0.8] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toHaveLength(1)
    expect(issues[0].category).toBe('missing_model')
    expect(issues[0].message).toMatch(/missing_lora\.safetensors/)
  })

  it('detects missing media file', async () => {
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'LoadImage', widgets_values: ['nonexistent.png'] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toHaveLength(1)
    expect(issues[0].category).toBe('missing_media')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].message).toMatch(/nonexistent\.png/)
  })

  it('finds media file when present', async () => {
    const inputDir = join(tmpBaseDir, 'input')
    await fs.mkdir(inputDir, { recursive: true })
    await fs.writeFile(join(inputDir, 'photo.png'), 'fake')
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'LoadImage', widgets_values: ['photo.png'] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toEqual([])
  })

  it('skips unknown loader types', async () => {
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'SomeUnknownLoader', widgets_values: ['something'] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toEqual([])
  })

  it('skips nodes with no widgets_values', async () => {
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'CheckpointLoaderSimple' }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues).toEqual([])
  })

  it('issues carry source: native', async () => {
    const { validateMissingReferences } = await import('./missing-ref-validator.js')
    const wf = makeWorkflow(
      [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['missing.safetensors'] }],
      [],
    )
    const issues = await validateMissingReferences(wf)
    expect(issues.every(i => i.source === 'native')).toBe(true)
    expect(issues.every(i => typeof i.id === 'string' && i.id.length > 0)).toBe(true)
  })
})
