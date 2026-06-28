import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

async function createModelFile(baseDir: string, category: string, name: string): Promise<void> {
  const dir = join(baseDir, 'models', category)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, name), 'fake model data')
}

async function createMediaFile(baseDir: string, name: string): Promise<void> {
  const dir = join(baseDir, 'input')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, name), 'fake image data')
}

describe('model-index', () => {
  let tmpHome: string
  let tmpBaseDir: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(join(tmpdir(), 'sga-model-idx-'))
    tmpBaseDir = await fs.mkdtemp(join(tmpdir(), 'sga-comfyui-'))
    vi.stubEnv('SGA_HOME', tmpHome)
    vi.stubEnv('COMFYUI_BASE_DIR', tmpBaseDir)
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fs.rm(tmpHome, { recursive: true, force: true })
    await fs.rm(tmpBaseDir, { recursive: true, force: true })
  })

  it('returns null when no models exist on disk', async () => {
    const { getModelFile, getModelIndexStats } = await import('./model-index.js')
    expect(await getModelFile('checkpoints', 'anything.safetensors')).toBeNull()
    expect(getModelIndexStats().source).toBe('fresh')
    expect(getModelIndexStats().size).toBe(0)
  })

  it('finds a model file by category and name', async () => {
    await createModelFile(tmpBaseDir, 'checkpoints', 'v1-5-pruned.safetensors')
    await createModelFile(tmpBaseDir, 'loras', 'style.safetensors')
    const { getModelFile } = await import('./model-index.js')
    const model = await getModelFile('checkpoints', 'v1-5-pruned.safetensors')
    expect(model).not.toBeNull()
    expect(model?.name).toBe('v1-5-pruned.safetensors')
    expect(model?.category).toBe('checkpoints')
    expect(model?.relativePath).toBe('checkpoints/v1-5-pruned.safetensors')
  })

  it('persists cache to <SGA_HOME>/model-index.json after scan', async () => {
    await createModelFile(tmpBaseDir, 'checkpoints', 'model1.safetensors')
    const { refreshModelIndex } = await import('./model-index.js')
    await refreshModelIndex()
    const raw = await fs.readFile(join(tmpHome, 'model-index.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.fetchedAt).toBeGreaterThan(0)
    expect(parsed.models.checkpoints[0].name).toBe('model1.safetensors')
  })

  it('loads from cache file on startup when fresh enough', async () => {
    const past = Date.now() - 10_000
    await fs.writeFile(join(tmpHome, 'model-index.json'), JSON.stringify({
      fetchedAt: past,
      models: { checkpoints: [{ name: 'cached.safetensors', category: 'checkpoints', relativePath: 'checkpoints/cached.safetensors', sizeBytes: 0 }] },
      media: [],
    }))
    // Remove the actual file from disk to prove cache is used
    const { getModelFile, getModelIndexStats } = await import('./model-index.js')
    const model = await getModelFile('checkpoints', 'cached.safetensors')
    expect(model?.name).toBe('cached.safetensors')
    expect(getModelIndexStats().source).toBe('cache-file')
  })

  it('re-scans when TTL has expired', async () => {
    const stale = Date.now() - 400_000
    await fs.writeFile(join(tmpHome, 'model-index.json'), JSON.stringify({
      fetchedAt: stale,
      models: { checkpoints: [{ name: 'stale.safetensors', category: 'checkpoints', relativePath: 'checkpoints/stale.safetensors', sizeBytes: 0 }] },
      media: [],
    }))
    await createModelFile(tmpBaseDir, 'checkpoints', 'fresh.safetensors')
    const { getModelFile } = await import('./model-index.js')
    const fresh = await getModelFile('checkpoints', 'fresh.safetensors')
    expect(fresh?.name).toBe('fresh.safetensors')
    const staleModel = await getModelFile('checkpoints', 'stale.safetensors')
    expect(staleModel).toBeNull()
  })

  it('finds media files in input/ recursively', async () => {
    await createMediaFile(tmpBaseDir, 'photo.png')
    const inputSubdir = join(tmpBaseDir, 'input', 'subfolder')
    await fs.mkdir(inputSubdir, { recursive: true })
    await fs.writeFile(join(inputSubdir, 'nested.jpg'), 'fake')
    const { getMediaFile, listMediaFiles } = await import('./model-index.js')
    const media = await getMediaFile('photo.png')
    expect(media?.name).toBe('photo.png')
    const nested = await getMediaFile('nested.jpg')
    expect(nested?.relativePath).toBe('subfolder/nested.jpg')
    const all = await listMediaFiles()
    expect(all).toHaveLength(2)
  })
})
