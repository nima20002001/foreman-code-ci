import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { HostCiRunner, type HostCiPorts } from './runner.js'
import { readCiSlots } from './planningCapacity.js'
import { CircleRest } from './cloudCircle.js'
import { CircleCiProvider, type CloudRun } from './cloudProviders.js'
import { GitHubRest } from './cloudGithub.js'
import type { CloudHttp } from './cloudHttp.js'
import { DomainError } from '../errors.js'
import { readOperationalFailures } from '../diagnostics/logger.js'
import { packEntries } from '../files/archives/zip.js'
import { Budget } from '../files/archives/policy.js'
import { fixture } from './cloud.testSupport.js'
import { splitUnavailableGateParts } from './gateFallback.js'
import { CiRunRecordSchema } from '@foreman-code/contracts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function directory() {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-observations-'))
  roots.push(root)
  return root
}
const retained: CloudRun = { runId: 'retained', repository: 'example/project', mirror: 'example/mirror',
  commit: 'a'.repeat(40), suite: 'unit', startedAt: '2026-10-14T00:00:00Z', providerRunId: 'pipeline',
  state: 'running', finishedAt: null, exitCode: null, message: null }

it('does not report an estimated ordinary slot as observed capacity', async () => {
  const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool
  const capacity = await readCiSlots(pool, { computers: async () => [], request: vi.fn() })
  expect(capacity).toMatchObject({ host: 0, ordinary: 0 })
})

it('marks planning capacity incomplete after an executor observation fails', async () => {
  const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool
  const computer = { key: 'fixture-computer', label: 'Fixture', priority: 1,
    hostRef: { kind: 'main' as const, mainId: 'main' } }
  const capacity = await readCiSlots(pool, { computers: async () => [computer], request: async () => {
    throw Object.assign(new Error('Read unavailable'), { code: 'EIO' })
  } })
  expect(capacity).toMatchObject({ host: 0, ordinary: 0, complete: false, unavailableComputers: [computer.key] })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'read CI planning capacity', lastError: 'EIO' }))
})

it('rechecks provider readiness after a failed observation and retains its cause', async () => {
  const f = await fixture()
  vi.spyOn(f.cloud.provider, 'ready').mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { code: 'EIO' }))
    .mockResolvedValue(true)
  expect(await f.cloud.ready()).toBe(false)
  expect(await f.cloud.ready()).toBe(true)
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'check CI provider readiness',
    lastError: 'EIO', failureCount: 1 }))
})

it('reports a failed provider check as unavailable instead of a login requirement', async () => {
  const f = await fixture()
  vi.spyOn(f.cloud.provider, 'ready').mockRejectedValue(Object.assign(new Error('Unavailable'), { code: 'EIO' }))
  expect(await f.cloud.handle({ operation: 'status' })).toMatchObject({ ready: false,
    reasons: [expect.stringContaining('EIO')] })
  expect(f.cloud).toHaveProperty('readinessObservation', expect.objectContaining({
    status: 'unavailable', consecutiveFailures: 1, lastError: expect.stringContaining('EIO') }))
})

it('keeps a live output failure visible while preserving the running result', async () => {
  const failure = new DomainError('CI_CLOUD_FAILED', 'Provider output is unavailable', 502)
  const http = { operation: async () => { throw failure } } as unknown as CloudHttp
  expect(await new CircleRest(http).output('job', 0, 100)).toEqual({ ok: false, text: '' })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'read CircleCI live output',
    lastError: 'CI_CLOUD_FAILED' }))
})

it('keeps the terminal parent result and reports unavailable job details', async () => {
  const ports: HostCiPorts = { now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30,
    run: async (_binary, args) => args[0] === 'run'
      ? { code: 0, stderr: '', stdout: JSON.stringify({ phase: 'ended', outcome: 'succeeded',
        stopped_at: '2026-10-14T00:01:00Z', workflows: [{ phase: 'ended', jobs: [{ id: 'job' }] }] }) }
      : { code: 1, stdout: '', stderr: 'Job details unavailable' } }
  const provider = new CircleCiProvider(ports, { circleToken: async () => null })
  expect(await provider.status(retained)).toMatchObject({ done: true, conclusion: 'success' })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'read CircleCI job details' }))
})

it('marks skipped step logs in the returned text', async () => {
  const bytes = await packEntries([{ name: 'Suite/1_First.txt', bytes: Buffer.from('first\n') }], new Budget())
  const jobs = [{ id: 1, name: 'Suite', conclusion: 'success', steps: [
    { number: 1, name: 'First' }, { number: 2, name: 'Second' },
  ] }]
  const http = { operation: async (_ms: number, work: () => Promise<unknown>) => work(),
    request: async () => Response.json({ jobs }), check: async () => undefined,
    json: async () => ({ jobs }), download: async () => bytes } as unknown as CloudHttp
  const output = await new GitHubRest(http).log('example/mirror', 'pipeline')
  expect(output).toContain('Log unavailable: Suite / Second')
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'read GitHub step log' }))
})

it.each(['metadata', 'exit', 'step', 'empty exit'])('does not hide an unreadable retained %s file', async area => {
  const root = await directory()
  const runId = randomUUID()
  const run = join(root, 'runs', runId)
  await mkdir(run, { recursive: true })
  await writeFile(join(run, 'meta.json'), JSON.stringify({ ...retained, runId, cleaned: false,
    cancellationRequested: false }))
  if (area === 'metadata') await writeFile(join(run, 'meta.json'), '{invalid')
  else if (area === 'empty exit') await writeFile(join(run, 'exit'), '')
  else await mkdir(join(run, area))
  const runner = new HostCiRunner(root, { now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30,
    run: async binary => ({ code: 0, stdout: binary === 'systemctl' ? 'active\n' : '', stderr: '' }) })
  await expect(runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 100 })).rejects.toThrow()
})

it('keeps reporting status without a run whose retained metadata file is unreadable', async () => {
  const root = await directory()
  const runId = randomUUID()
  await mkdir(join(root, 'runs', runId), { recursive: true })
  await writeFile(join(root, 'runs', runId, 'meta.json'), '{invalid')
  const runner = new HostCiRunner(root, { now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30,
    run: async binary => ({ code: 0, stdout: binary === 'systemctl' ? 'active\n' : '', stderr: '' }) })
  expect(await runner.handle({ operation: 'status' })).toMatchObject({ operation: 'status', runs: [] })
})

it('fails a missing retained cloud log instead of returning empty successful output', async () => {
  const f = await fixture()
  const runId = randomUUID()
  const path = join(f.root, 'ci-cloud', 'runs', runId)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'meta.json'), JSON.stringify({ ...retained, runId, state: 'passed',
    exitCode: 0, finishedAt: '2026-10-14T00:01:00Z', collection: { log: true, artifacts: true } }))
  await expect(f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 100 })).rejects.toThrow()
})

it('keeps the build-computer reassignment cause on the original ticket', async () => {
  const run = CiRunRecordSchema.parse({ repository: retained.repository, commit: retained.commit, startedAt: null,
    finishedAt: null, exitCode: null, message: null, id: randomUUID(), groupId: randomUUID(),
    workspaceId: 'workspace', gate: true, suite: 'integration', state: 'queued', computer: null,
    queuedAt: '2026-10-13T00:00:00Z', plannedHostKey: 'fixture-build', step: null, partition: null,
    files: ['apps/api/test/feature.integration.test.ts'],
    initiator: { principalId: 'operator', executionId: null } })
  const query = async () => ({ rows: [], rowCount: 1 })
  const pool = { connect: async () => ({ query, release: () => undefined }) } as unknown as pg.Pool
  const cloud = { key: 'fixture-cloud', label: 'Fixture cloud', priority: 1,
    hostRef: { kind: 'cloud' as const, mainId: 'main', provider: 'github' as const, slot: 0 } }
  const parts = await splitUnavailableGateParts(pool, [run], { computers: [cloud],
    shards: new Map([[cloud.key, 1]]), durations: new Map(), reservedCloud: new Set(), gate: undefined,
    canTake: () => true, idle: () => true, freeSlots: () => 1 })
  expect(parts[0]).toMatchObject({ id: run.id, message: expect.stringMatching(/unavailable.*reassigned/i) })
  expect(parts[0]).toMatchObject({ reassignment: { count: 1, previousHostKey: run.plannedHostKey,
    lastError: 'CI_BUILD_COMPUTER_UNAVAILABLE' } })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'reassign unavailable CI build part' }))
})

it('reports the source, count and elapsed time of one mirror repair', async () => {
  const f = await fixture()
  const git = f.git.git.bind(f.git)
  let injected = false
  vi.spyOn(f.git, 'git').mockImplementation(async (args, options) => {
    if (!injected && args[0] === 'fetch' && options.cwd?.endsWith('site-ci')) {
      injected = true
      return { code: 1, stdout: '', stderr: 'fatal: bad object' }
    }
    return git(args, options)
  })
  const started = await f.cloud.handle({ operation: 'start', runId: randomUUID(), workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  expect(injected).toBe(true)
  expect(started).toMatchObject({ run: { mirrorPublication: { repair: { count: 1,
    repository: 'octo/site-ci', sourceCommit: f.commit, reason: 'CI_MIRROR_CORRUPT', elapsedMs: expect.any(Number) } } } })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'repair CI mirror clone',
    failureCount: 1, attempt: 1, elapsedMs: expect.any(Number) }))
})

it('does not return an empty log after a completed native run loses its retained log', async () => {
  const root = await directory()
  const runId = randomUUID()
  const path = join(root, 'runs', runId)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'meta.json'), JSON.stringify({ ...retained, runId, state: 'passed',
    exitCode: 0, finishedAt: '2026-10-14T00:01:00Z', cleaned: true, cancellationRequested: false }))
  const runner = new HostCiRunner(root, { now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30,
    run: async () => ({ code: 0, stdout: '', stderr: '' }) })
  await expect(runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 100 }))
    .rejects.toMatchObject({ code: 'CI_LOG_UNAVAILABLE' })
})

it('reports missing completed progress while preserving the verified result', async () => {
  const root = await directory()
  const runId = randomUUID()
  const path = join(root, 'runs', runId)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'meta.json'), JSON.stringify({ ...retained, runId, state: 'passed',
    exitCode: 0, finishedAt: '2026-10-14T00:01:00Z', cleaned: true, cancellationRequested: false }))
  await writeFile(join(path, 'log'), 'Tests passed.\n')
  const runner = new HostCiRunner(root, { now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30,
    run: async () => ({ code: 0, stdout: '', stderr: '' }) })
  expect(await runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 100 }))
    .toMatchObject({ run: { state: 'passed' }, text: 'Tests passed.\n' })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'read completed CI progress', lastError: 'ENOENT' }))
})
