import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { CiRuntimeWorkerStateSchema } from '@foreman-code/contracts'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { CiRuntimeWorker } from './ciRuntimeWorker.js'
import { writeCiRuntimeState } from './ciRuntimeState.js'

it.each([true, false])('restores a matching refresh outcome after persisted preparation (success=%s)', async ok => {
  const directory = await privateFixtureDirectory('ci-worker-restart-')
  const operationId = randomUUID()
  const commit = 'c'.repeat(40)
  const state = CiRuntimeWorkerStateSchema.parse({ operationId, commit, state: 'prepared',
    stage: null, message: null, updatedAt: new Date().toISOString(),
    prepared: { commit, imageId: `sha256:${'1'.repeat(64)}`, imageManifestDigest: `sha256:${'2'.repeat(64)}`,
      seedReceiptPath: '/ci/seed.json', contextReceiptPath: '/ci/context.json', qualificationSource: '/ci/source' } })
  const lastRefresh = vi.fn(async () => ({ operationId, commit, ok, log: ok ? 'exit=0' : 'exit=1' }))
  const worker = new CiRuntimeWorker(directory, {
    git: { cloneDirectory: () => '/ci/repository', git: vi.fn() },
    managedRuntimeRoot: async () => directory,
    prepare: vi.fn(), lastRefresh, currentRuntimePaths: async () => [], now: () => new Date(),
  }, new AbortController().signal)
  try {
    await writeCiRuntimeState(directory, state)
    expect(await worker.handle({ operation: 'status' })).toMatchObject({ operationId, commit,
      state: ok ? 'idle' : 'failed', stage: 'refresh', prepared: null,
      message: ok ? null : 'The runtime refresh failed: exit=1' })
    expect(lastRefresh).toHaveBeenCalledOnce()
    expect(await worker.handle({ operation: 'status' })).toMatchObject({ state: ok ? 'idle' : 'failed' })
  } finally {
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('retains a prepared operation when the last refresh belongs to another operation', async () => {
  const directory = await privateFixtureDirectory('ci-worker-prepared-')
  const operationId = randomUUID()
  const commit = 'c'.repeat(40)
  const state = CiRuntimeWorkerStateSchema.parse({ operationId, commit, state: 'prepared',
    stage: null, message: null, updatedAt: new Date().toISOString(),
    prepared: { commit, imageId: `sha256:${'1'.repeat(64)}`, imageManifestDigest: `sha256:${'2'.repeat(64)}`,
      seedReceiptPath: '/ci/seed.json', contextReceiptPath: '/ci/context.json', qualificationSource: '/ci/source' } })
  const worker = new CiRuntimeWorker(directory, {
    git: { cloneDirectory: () => '/ci/repository', git: vi.fn() },
    managedRuntimeRoot: async () => directory, prepare: vi.fn(),
    lastRefresh: async () => ({ operationId: randomUUID(), commit, ok: true, log: 'exit=0' }),
    currentRuntimePaths: async () => [], now: () => new Date(),
  }, new AbortController().signal)
  try {
    await writeCiRuntimeState(directory, state)
    expect(await worker.handle({ operation: 'status' })).toMatchObject(state)
  } finally {
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})
