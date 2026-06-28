/**
 * Fixture loader — reads and parses JSON test fixtures from __fixtures__/.
 * Each fixture contains a workflow, object_info stub, model list, and
 * expected issue ids for validator tests.
 */
import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, '__fixtures__')

export interface LoadedFixture {
  name: string
  description: string
  objectInfo: Record<string, unknown>
  models: Record<string, string[]>
  input: string[]
  workflow: Record<string, unknown>
  expectedIssueIds: string[]
}

export function loadFixture(name: string): LoadedFixture {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8')
  return JSON.parse(raw) as LoadedFixture
}

export function listFixtures(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
    .sort()
}
