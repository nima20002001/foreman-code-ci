import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import type { PreparedCiRuntime } from '@foreman-code/contracts'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { CiRuntimeWorker, type CiRuntimeWorkerPorts } from './ciRuntimeWorker.js'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(prepare: CiRuntimeWorkerPorts['prepare'],
  options: Partial<Pick<CiRuntimeWorkerPorts, 'refresh' | 'lastRefresh'>> = { refresh: vi.fn() }) {
  const root = await privateFixtureDirectory('ci-worker-lifetime-')
  roots.push(root)
  const lifetime = new AbortController()
  const ports: CiRuntimeWorkerPorts = {
    git: { cloneDirectory: () => root, git: async () => ({ code: 0, stdout: '', stderr: '' }) },
    managedRuntimeRoot: async () => root,
    currentRuntimePaths: async () => [], prepare, lastRefresh: async () => null, ...options,
    now: () => new Date(),
  }
  const worker = new CiRuntimeWorker(root, ports, lifetime.signal)
  const restart = (lastRefresh: CiRuntimeWorkerPorts['lastRefresh']) =>
    new CiRuntimeWorker(root, { ...ports, lastRefresh }, lifetime.signal)
  const request = { operation: 'prepare', operationId: randomUUID(), repository: 'fixture/site',
    commit: 'a'.repeat(40), keepImages: [],
    review: { reviewedByPrincipalId: 'owner', decisionDigest: 'b'.repeat(64) } }
  const prepared: PreparedCiRuntime = { commit: request.commit, imageId: `sha256:${'c'.repeat(64)}`,
    imageManifestDigest: `sha256:${'d'.repeat(64)}`, qualificationSource: `${root}/source`,
    seedReceiptPath: `${root}/seed.json`, contextReceiptPath: `${root}/context.json` }
  return { worker, lifetime, request, prepared, root, ports, restart }
}

describe('worker CI preparation lifetime', () => {
  it.each([true, false])('restores the refresh outcome after restarting a prepared worker: success=%s', async ok => {
    const prepare = vi.fn<CiRuntimeWorkerPorts['prepare']>()
    const f = await fixture(prepare)
    prepare.mockResolvedValue(f.prepared)
    const fingerprint = verificationRuntimeFixture().measurement.fingerprint
    await f.worker.handle(f.request)
    await f.worker.close()
    await f.worker.handle({ operation: 'refresh', operationId: f.request.operationId, commit: f.request.commit,
      root: fingerprint.root, resources: fingerprint.resources,
      manifest: { version: 1, ...fingerprint.root.source,
        git: { commit: f.request.commit, tree: 'a'.repeat(40), objectFormat: 'sha1' },
        capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved', entries: [], deletions: [],
        totalEntries: 0, totalBytes: 0 } })
    const lastRefresh = async () => ({ operationId: f.request.operationId, commit: f.request.commit,
      ok, log: ok ? 'exit=0' : 'exit=1' })
    const restarted = f.restart(lastRefresh)
    expect(await restarted.handle({ operation: 'status' })).toMatchObject({
      operationId: f.request.operationId, commit: f.request.commit, stage: 'refresh', prepared: null,
      state: ok ? 'idle' : 'failed', message: ok ? null : 'The runtime refresh failed: exit=1',
    })
    expect(await f.restart(async () => null).handle({ operation: 'status' })).toMatchObject({
      operationId: f.request.operationId, state: ok ? 'idle' : 'failed', stage: 'refresh',
    })
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('preserves a later preparation when the retained refresh belongs to an earlier operation', async () => {
    const prepare = vi.fn<CiRuntimeWorkerPorts['prepare']>()
    const f = await fixture(prepare)
    prepare.mockResolvedValue(f.prepared)
    await f.worker.handle(f.request)
    await f.worker.close()
    const restarted = f.restart(async () => ({ operationId: randomUUID(), commit: 'b'.repeat(40),
      ok: true, log: 'exit=0' }))
    expect(await restarted.handle({ operation: 'status' })).toMatchObject({
      operationId: f.request.operationId, state: 'prepared', prepared: f.prepared,
    })
    await restarted.handle(f.request)
    expect(prepare).toHaveBeenCalledOnce()
  })

  it.each([true, false])('reconciles a completed refresh after restart when refresh succeeds: %s', async ok => {
    const prepare = vi.fn<CiRuntimeWorkerPorts['prepare']>()
    const f = await fixture(prepare)
    prepare.mockResolvedValue(f.prepared)
    await f.worker.handle(f.request)
    await f.worker.close()
    expect(await f.worker.handle({ operation: 'status' })).toMatchObject({ state: 'prepared' })

    const restarted = new CiRuntimeWorker(f.root, {
      ...f.ports,
      lastRefresh: async () => ({ operationId: f.request.operationId, commit: f.request.commit, ok, log: 'exit=1' }),
    }, f.lifetime.signal)
    expect(await restarted.handle({ operation: 'status' })).toMatchObject({
      operationId: f.request.operationId,
      commit: f.request.commit,
      state: ok ? 'idle' : 'failed',
      stage: 'refresh',
      prepared: null,
      message: ok ? null : 'The runtime refresh failed: exit=1',
    })
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('preserves prepared state when the refresh outcome belongs to another operation', async () => {
    const prepare = vi.fn<CiRuntimeWorkerPorts['prepare']>()
    const f = await fixture(prepare)
    prepare.mockResolvedValue(f.prepared)
    await f.worker.handle(f.request)
    await f.worker.close()

    const restarted = new CiRuntimeWorker(f.root, {
      ...f.ports,
      lastRefresh: async () => ({ operationId: randomUUID(), commit: f.request.commit, ok: true, log: 'exit=0' }),
    }, f.lifetime.signal)
    expect(await restarted.handle({ operation: 'status' })).toMatchObject({
      operationId: f.request.operationId, state: 'prepared', prepared: f.prepared,
    })
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('rejects legacy refresh on a Host CI computer while preserving idle, pending and prepared status', async () => {
    let finish!: (value: PreparedCiRuntime) => void
    const native = new Promise<PreparedCiRuntime>(resolve => { finish = resolve })
    const prepare = vi.fn<CiRuntimeWorkerPorts['prepare']>(() => native)
    const f = await fixture(prepare, {})
    const fingerprint = verificationRuntimeFixture().measurement.fingerprint
    const refresh = { operation: 'refresh', operationId: f.request.operationId, commit: f.request.commit,
      root: fingerprint.root, resources: fingerprint.resources,
      manifest: { version: 1, ...fingerprint.root.source,
        git: { commit: f.request.commit, tree: 'a'.repeat(40), objectFormat: 'sha1' },
        capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved', entries: [], deletions: [],
        totalEntries: 0, totalBytes: 0 } }
    try {
      await expect(f.worker.handle(refresh)).rejects.toMatchObject({ code: 'CI_RUNTIME_RETIRED' })
      expect(await f.worker.handle({ operation: 'status' })).toMatchObject({ state: 'idle', stage: null })
      expect(prepare).not.toHaveBeenCalled()
      await f.worker.handle(f.request)
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      await expect(f.worker.handle(refresh)).rejects.toMatchObject({ code: 'CI_RUNTIME_RETIRED' })
      expect(await f.worker.handle({ operation: 'status' })).toMatchObject({ state: 'preparing' })
      finish(f.prepared)
      await f.worker.close()
      await expect(f.worker.handle(refresh)).rejects.toMatchObject({ code: 'CI_RUNTIME_RETIRED' })
      expect(await f.worker.handle({ operation: 'status' })).toMatchObject({ state: 'prepared', stage: null })
    } finally {
      finish(f.prepared)
      await f.worker.close()
    }
  })

  it.each([true, false])('reconciles a persisted preparation with its refresh outcome ok=%s after restart', async ok => {
    const prepare = vi.fn<CiRuntimeWorkerPorts['prepare']>()
    const f = await fixture(prepare)
    prepare.mockResolvedValue(f.prepared)
    await f.worker.handle(f.request)
    await f.worker.close()
    const replacement = new CiRuntimeWorker(f.root, {
      ...f.ports,
      lastRefresh: async () => ({ operationId: f.request.operationId, commit: f.request.commit, ok, log: 'refresh result' }),
    }, new AbortController().signal)
    expect(await replacement.handle({ operation: 'status' })).toMatchObject({
      operationId: f.request.operationId, commit: f.request.commit,
      state: ok ? 'idle' : 'failed', stage: 'refresh', prepared: null,
      message: ok ? null : 'The runtime refresh failed: refresh result',
    })
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('keeps a newer persisted preparation when the last refresh belongs to an older operation', async () => {
    const prepare = vi.fn<CiRuntimeWorkerPorts['prepare']>()
    const f = await fixture(prepare)
    prepare.mockResolvedValue(f.prepared)
    await f.worker.handle(f.request)
    await f.worker.close()
    const replacement = new CiRuntimeWorker(f.root, {
      ...f.ports,
      lastRefresh: async () => ({ operationId: randomUUID(), commit: f.request.commit, ok: true, log: 'previous refresh' }),
    }, new AbortController().signal)
    expect(await replacement.handle({ operation: 'status' })).toMatchObject({
      operationId: f.request.operationId, state: 'prepared', prepared: f.prepared,
    })
  })

  it('returns preparing while work continues and joins it on close', async () => {
    let finish!: (value: PreparedCiRuntime) => void
    const native = new Promise<PreparedCiRuntime>(resolve => { finish = resolve })
    const prepare = vi.fn<CiRuntimeWorkerPorts['prepare']>(() => native)
    const f = await fixture(prepare)
    try {
      expect((await f.worker.handle(f.request)).state).toBe('preparing')
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      expect(prepare.mock.calls[0]?.[0].signal).toBe(f.lifetime.signal)
      let closed = false
      const closing = f.worker.close().then(() => { closed = true })
      await new Promise(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
      finish(f.prepared)
      await closing
      expect(await f.worker.handle({ operation: 'status' })).toMatchObject({ state: 'prepared', prepared: f.prepared })
    } finally {
      finish(f.prepared)
      await f.worker.close()
    }
  })

  it('joins cancelled preparation before shutdown and never publishes its late result', async () => {
    let finish!: (value: PreparedCiRuntime) => void
    const native = new Promise<PreparedCiRuntime>(resolve => { finish = resolve })
    const prepare = vi.fn<CiRuntimeWorkerPorts['prepare']>(() => native)
    const f = await fixture(prepare)
    try {
      await f.worker.handle(f.request)
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      f.lifetime.abort(new Error('Worker shutdown'))
      let closed = false
      const closing = f.worker.close().then(() => { closed = true })
      await new Promise(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
      finish(f.prepared)
      await closing
      expect(await f.worker.handle({ operation: 'status' })).toMatchObject({
        state: 'failed', prepared: null, message: 'Worker shutdown',
      })
      await expect(f.worker.handle(f.request)).rejects.toThrow('Worker shutdown')
    } finally {
      finish(f.prepared)
      await f.worker.close()
    }
  })
})
