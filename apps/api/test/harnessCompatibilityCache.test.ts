import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileCompatibilityCache, type CompatibilityCacheEntry } from '../src/modules/harnesses/compatibility/cache.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const now = Date.parse('2026-09-19T00:00:00.000Z')
function entry(): CompatibilityCacheEntry {
  return { format: 2, key: 'b'.repeat(64), harness: 'codex', installedVersion: '99.0.0', status: 'probe-passed',
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(), reason: null, schemaSha256: 'c'.repeat(64) }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graphql-compatibility-cache-test-')); roots.push(root)
  const directory = join(root, 'cache')
  return { directory, cache: new FileCompatibilityCache(directory) }
}
describe('local compatibility cache', () => {
  it('reuses a bounded record after a service restart and writes owner-only files', async () => {
    const { directory, cache } = await fixture()
    const value = entry()
    await cache.save(value)
    expect(await new FileCompatibilityCache(directory).load('codex', value.key, now)).toEqual(value)
    if (process.platform !== 'win32') expect((await stat(join(directory, 'codex.json'))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(join(directory, 'codex.json'), 'utf8'))).toEqual(value)
  })
  it('ignores expired, future, wrong-key and implausibly long-lived results', async () => {
    const { cache } = await fixture(); const value = entry()
    await cache.save(value)
    expect(await cache.load('codex', 'd'.repeat(64), now)).toBeNull()
    expect(await cache.load('codex', value.key, now + 86_400_000)).toBeNull()
    expect(await cache.load('codex', value.key, now - 1)).toBeNull()
    await cache.save({ ...value, expiresAt: new Date(now + 8 * 86_400_000).toISOString() })
    expect(await cache.load('codex', value.key, now)).toBeNull()
  })
  it('surfaces corruption for recomputation, and a later successful write repairs it', async () => {
    const { directory, cache } = await fixture(); const value = entry()
    await cache.save(value)
    await writeFile(join(directory, 'codex.json'), '{broken')
    await expect(cache.load('codex', value.key, now)).rejects.toThrow()
    await cache.save(value)
    expect(await cache.load('codex', value.key, now)).toEqual(value)
  })
  it('rejects an oversized file without reading arbitrary data into memory', async () => {
    const { directory, cache } = await fixture(); const value = entry()
    await cache.save(value)
    await writeFile(join(directory, 'codex.json'), 'x'.repeat(16_385))
    await expect(cache.load('codex', value.key, now)).rejects.toThrow()
  })
})
