import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readCiRuntimeCache, writeCiRuntimeCache } from './ciRuntimeCache.js'
import { CiRuntimeWorker } from './ciRuntimeWorker.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const installer = await mkdtemp(join(parent, 'runtime-cache-visibility-'))
  roots.push(installer)
  const prepared = { commit: 'a'.repeat(40), imageId: 'sha256:' + 'b'.repeat(64),
    imageManifestDigest: 'sha256:' + 'c'.repeat(64), qualificationSource: join(installer, 'source'),
    seedReceiptPath: join(installer, 'seed.json'), contextReceiptPath: join(installer, 'context.json') }
  await writeFile(prepared.seedReceiptPath, 'seed', { mode: 0o600 })
  await writeFile(prepared.contextReceiptPath, 'context', { mode: 0o600 })
  return { installer, prepared, inputDigest: 'd'.repeat(64), imageExists: vi.fn(async () => true) }
}

it.each(['json', 'metadata', 'receipt', 'missing-receipt', 'image'] as const)(
  'distinguishes a corrupt %s cache from an ordinary absent entry', async failure => {
    const f = await fixture()
    const onInvalid = vi.fn()
    expect(await readCiRuntimeCache({ ...f, onInvalid })).toBeNull()
    expect(onInvalid).not.toHaveBeenCalled()
    await writeCiRuntimeCache(f)
    const path = join(f.installer, 'runtime-cache', f.inputDigest + '.json')
    if (failure === 'json') await writeFile(path, '{', { mode: 0o600 })
    if (failure === 'metadata') await writeFile(path, '{}', { mode: 0o600 })
    if (failure === 'receipt') await writeFile(f.prepared.seedReceiptPath, 'damaged', { mode: 0o600 })
    if (failure === 'missing-receipt') await rm(f.prepared.contextReceiptPath)
    if (failure === 'image') f.imageExists.mockResolvedValue(false)
    expect(await readCiRuntimeCache({ ...f, onInvalid })).toBeNull()
    expect(onInvalid).toHaveBeenCalledWith(expect.any(String))
    expect(onInvalid).toHaveBeenCalledOnce()
    expect(onInvalid.mock.calls[0]![0]).not.toContain(f.installer)
  })

it('keeps rebuild diagnostics in public runtime status after completion and restart', async () => {
  const f = await fixture()
  const cache = { status: 'invalid' as const, lastError: 'Runtime cache metadata is invalid.', missCount: 1, rebuildCount: 1 }
  const ports = { git: { cloneDirectory: () => f.installer,
    git: async () => ({ code: 0, stdout: '', stderr: '' }) },
    managedRuntimeRoot: async () => f.installer, currentRuntimePaths: async () => [],
    prepare: vi.fn(async () => ({ ...f.prepared, cache })), lastRefresh: async () => null, now: () => new Date() }
  const worker = new CiRuntimeWorker(f.installer, ports, new AbortController().signal)
  await worker.handle({ operation: 'prepare', operationId: randomUUID(), repository: 'fixture/site',
    commit: f.prepared.commit, keepImages: [], review: { reviewedByPrincipalId: 'fixture-owner', decisionDigest: 'e'.repeat(64) } })
  await worker.close()
  expect(await worker.handle({ operation: 'status' })).toMatchObject({ state: 'prepared', cache })
  const restarted = new CiRuntimeWorker(f.installer, ports, new AbortController().signal)
  expect(await restarted.handle({ operation: 'status' })).toMatchObject({ state: 'prepared', cache })
})
