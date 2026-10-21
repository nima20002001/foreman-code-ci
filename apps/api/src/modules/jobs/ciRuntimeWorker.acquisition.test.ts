import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DomainError } from '../errors.js'
import { CiRuntimeWorker, type CiRuntimeWorkerPorts } from './ciRuntimeWorker.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each([
  ['capacity', new DomainError('SOURCE_GIT_CACHE_CAPACITY', 'Git cache storage is full; free space and retry.', 409,
    { retryable: true }), 'Git cache storage is full; free space and retry.'],
  ['connection', Object.assign(new Error('GitHub connection reset; retry.'), { code: 'ECONNRESET' }),
    'GitHub connection reset; retry.'],
  ['authentication', new DomainError('COMPUTER_GITHUB_REQUIRED', 'Sign in to GitHub on this computer, then retry.', 409),
    'Sign in to GitHub on this computer, then retry.'],
] as const)('reports the actual %s acquisition failure in persisted CI preparation status', async (_kind, error, message) => {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'ci-acquisition-'))
  roots.push(root)
  const prepare = vi.fn<CiRuntimeWorkerPorts['prepare']>()
  const ports: CiRuntimeWorkerPorts = {
    git: { cloneDirectory: () => root, git: async () => { throw error } },
    managedRuntimeRoot: async () => root, currentRuntimePaths: async () => [],
    prepare, lastRefresh: async () => null, now: () => new Date(),
  }
  const worker = new CiRuntimeWorker(root, ports, new AbortController().signal)
  await worker.handle({ operation: 'prepare', operationId: randomUUID(), repository: 'fixture/site',
    commit: 'a'.repeat(40), keepImages: [],
    review: { reviewedByPrincipalId: 'operator', decisionDigest: 'b'.repeat(64) } })
  await worker.close()
  const restarted = new CiRuntimeWorker(root, ports, new AbortController().signal)
  expect(await restarted.handle({ operation: 'status' })).toMatchObject({ state: 'failed', stage: 'fetch-source', message })
  expect(prepare).not.toHaveBeenCalled()
})
