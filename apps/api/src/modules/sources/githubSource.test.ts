import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DomainError } from '../errors.js'
import { deviceApplicationFailure } from '../devices/deviceApplicationError.js'
import { openGitHubSource } from './githubSource.js'
import type { GitWorktreePorts } from './gitWorktree.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function acquisition(git: GitWorktreePorts['git']) {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'github-source-'))
  roots.push(root)
  const ports = { cloneDirectory: () => join(root, 'clone'), git }
  const reference = { repository: 'fixture/site', commit: 'a'.repeat(40), executablePolicy: 'strip' as const }
  const pin = { approvedSourceId: randomUUID(), snapshotId: randomUUID(), manifestDigest: `sha256:${'b'.repeat(64)}` }
  return { ports, reference, pin }
}

it.each([
  new DomainError('SOURCE_GIT_CACHE_CAPACITY', 'Git cache storage is full; free space and retry.', 409,
    { retryable: true, newCommandRequired: false }),
  Object.assign(new Error('GitHub connection reset; retry.'), { code: 'ECONNRESET' }),
  Object.assign(new Error('GitHub DNS lookup failed; retry.'), { code: 'EAI_AGAIN' }),
])('preserves typed acquisition failure $code and its retry classification', async failure => {
  const f = await acquisition(async () => { throw failure })
  await expect(openGitHubSource(f.ports, f.reference, f.pin, new AbortController().signal)).rejects.toBe(failure)
  expect(deviceApplicationFailure(failure)).toMatchObject({ class: 'transient', retryable: true })
})

it.each([
  ['fatal: Could not resolve host: github.com', 'DNS'],
  ['fatal: Recv failure: Connection reset by peer', 'connection'],
  ['fatal: The requested URL returned error: 503', 'unavailable'],
])('keeps failed Git transfers retryable: %s', async (stderr, reason) => {
  const f = await acquisition(async () => ({ code: 128, stdout: '', stderr: `${stderr}\nsecret-token` }))
  const error = await openGitHubSource(f.ports, f.reference, f.pin, new AbortController().signal)
    .catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'SOURCE_GITHUB_UNAVAILABLE', message: expect.stringContaining(reason) })
  expect(deviceApplicationFailure(error)).toMatchObject({ class: 'transient', retryable: true })
  expect((error as Error).message).not.toMatch(/sign in|Connect GitHub|secret-token/iu)
})

it('requests sign-in only when Git confirms authentication failed', async () => {
  const f = await acquisition(async () => ({ code: 128, stdout: '',
    stderr: "fatal: Authentication failed for 'https://secret-token@github.com/fixture/site.git/'" }))
  const error = await openGitHubSource(f.ports, f.reference, f.pin, new AbortController().signal)
    .catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'COMPUTER_GITHUB_REQUIRED', message: expect.stringMatching(/Sign in|Connect GitHub/u) })
  expect(deviceApplicationFailure(error)).toMatchObject({ class: 'permanent', retryable: false })
  expect((error as Error).message).not.toContain('secret-token')
})

it('preserves cancellation instead of reporting a GitHub failure', async () => {
  const lifetime = new AbortController()
  const reason = new Error('Source request cancelled')
  const f = await acquisition(async () => {
    lifetime.abort(reason)
    throw reason
  })
  await expect(openGitHubSource(f.ports, f.reference, f.pin, lifetime.signal)).rejects.toBe(reason)
})
