import pg from 'pg'
import { ownedTestDatabaseUrl } from '../../../test/helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ciDirectoryCleanupCandidates, sweepCiRunDirectories } from './directoryRetention.js'
import { withHostCiRunLock } from './runnerLock.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-directory-'))
  roots.push(root)
  const runId = randomUUID()
  const directory = join(root, 'runs', runId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'meta.json'), JSON.stringify({ state: 'passed' }))
  await writeFile(join(directory, 'log'), 'retained bytes')
  const options = { root, runIds: [runId], isInUse: () => false,
    withRun: (_id: string, work: () => Promise<boolean>) => withHostCiRunLock(directory, work, { nonBlocking: true }) }
  return { directory, options }
}

it('preserves a terminal directory locked by another runner, then removes it once unused', async () => {
  const f = await fixture()
  await withHostCiRunLock(f.directory, async () => {
    await expect(sweepCiRunDirectories(f.options)).resolves.toEqual([])
  })
  await expect(readFile(join(f.directory, 'log'), 'utf8')).resolves.toBe('retained bytes')
  await expect(sweepCiRunDirectories(f.options)).resolves.toEqual(f.options.runIds)
  await expect(access(f.directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rechecks use after acquiring the directory lock', async () => {
  const f = await fixture()
  let inUse = false
  await expect(sweepCiRunDirectories({ ...f.options, isInUse: () => inUse,
    withRun: async (_id, work) => {
      inUse = true
      return work()
    } })).resolves.toEqual([])
  await expect(readFile(join(f.directory, 'log'), 'utf8')).resolves.toBe('retained bytes')
})

it('rejects identifiers outside the run directory namespace', async () => {
  const f = await fixture()
  await expect(sweepCiRunDirectories({ ...f.options, runIds: ['../retained'] })).rejects.toThrow()
  await expect(readFile(join(f.directory, 'log'), 'utf8')).resolves.toBe('retained bytes')
})

it('preserves a directory when a read starts while deletion checks its metadata', async () => {
  const f = await fixture()
  let inUse = false
  await expect(sweepCiRunDirectories({ ...f.options, isInUse: () => inUse,
    withRun: (_id, work) => {
      const deletion = work()
      inUse = true
      return deletion
    } })).resolves.toEqual([])
  await expect(readFile(join(f.directory, 'log'), 'utf8')).resolves.toBe('retained bytes')
  inUse = false
  await expect(sweepCiRunDirectories(f.options)).resolves.toEqual(f.options.runIds)
})


it('returns bounded cleanup pages without losing candidates at a page boundary', async () => {
  const host = { hostRef: { kind: 'main' as const, mainId: 'fixture-main' }, label: 'Build executor' }
  const ids = Array.from({ length: 1001 }, () => randomUUID())
  const rows = ids.map((id, index) => ({ run_id: id, state: 'passed',
    finished_at: '2026-01-01T00:00:00.000Z', collection: null, rank: String(index + 201) }))
  const pool = { query: async (_sql: string, parameters: unknown[]) => {
    const limit = parameters[3] as number | undefined
    const offset = parameters[4] as number | undefined ?? 0
    return { rows: rows.slice(offset, limit === undefined ? undefined : offset + limit) }
  } } as unknown as pg.Pool
  const now = Date.parse('2026-10-16T00:00:00.000Z')
  expect(await ciDirectoryCleanupCandidates(pool, host, now)).toEqual(ids.slice(0, 1000))
  expect(await ciDirectoryCleanupCandidates(pool, host, now, { offset: 1000 })).toEqual(ids.slice(1000))
  expect(await ciDirectoryCleanupCandidates(pool, host, now, { offset: 2000 })).toEqual([])
})

it.each([false, true])('selects and removes the execution directory after reassignment, setup retry: %s', async setupRetry => {
  const f = await fixture()
  const host = { hostRef: { kind: 'cloud' as const, mainId: 'fixture-main', provider: 'github' as const, slot: 0 },
    label: 'Cloud executor' }
  const ticketId = randomUUID()
  const retryId = randomUUID()
  const now = Date.parse('2026-10-16T00:00:00.000Z')
  const client = new pg.Client({ connectionString: ownedTestDatabaseUrl() })
  await client.connect()
  try {
    await client.query('create temporary table ci_runs (id text primary key, state text, record jsonb)')
    const retained = Array.from({ length: 201 }, () => ({ id: randomUUID(), state: 'passed',
      record: { computer: host, finishedAt: new Date(now).toISOString() } }))
    const record = { computer: host, finishedAt: '2026-10-01T00:00:00.000Z', executionRunId: f.options.runIds[0],
      ...(setupRetry ? { setupRetry: { runId: retryId,
        failedComputer: { kind: 'cloud', mainId: 'fixture-main', provider: 'circleci', slot: 0 }, reason: 'Setup failed' } } : {}) }
    await client.query(`insert into ci_runs (id,state,record)
      select id,state,record from jsonb_to_recordset($1::jsonb) as x(id text,state text,record jsonb)`,
    [JSON.stringify([...retained, { id: ticketId, state: 'passed', record }])])
    const candidates = await ciDirectoryCleanupCandidates(client, host, now)
    expect(candidates).toEqual(f.options.runIds)
    expect(candidates).not.toContain(ticketId)
    expect(candidates).not.toContain(retryId)
    expect(await sweepCiRunDirectories({ ...f.options, runIds: candidates })).toEqual(f.options.runIds)
    await expect(access(f.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await client.end()
  }
})


it('confirms an already absent expired directory so Main can finish log retention after a crash', async () => {
  const f = await fixture()
  await rm(f.directory, { recursive: true })
  await expect(sweepCiRunDirectories(f.options)).resolves.toEqual(f.options.runIds)
})

it('keeps primary cleanup away from secondary current, retry and historical attempts', async () => {
  const client = new pg.Client({ connectionString: ownedTestDatabaseUrl() })
  await client.connect()
  const mainId = 'fixture-main'
  const primary = { kind: 'cloud' as const, mainId, provider: 'circleci' as const, account: 'alpha' }
  const reserve = { ...primary, circleAccountId: 'reserve' }
  const now = Date.parse('2026-10-17T12:00:00Z')
  const id = randomUUID()
  const retryId = randomUUID()
  const historyId = randomUUID()
  try {
    await client.query('create temporary table ci_runs (id text primary key, state text, record jsonb)')
    const recent = Array.from({ length: 201 }, () => ({ id: randomUUID(), state: 'passed', record: {
      computer: { hostRef: reserve, label: 'Reserve' }, finishedAt: new Date(now).toISOString(),
    } }))
    const old = { id, state: 'passed', record: { computer: { hostRef: reserve, label: 'Reserve' },
      finishedAt: '2026-10-01T00:00:00Z', executionRunId: retryId,
      executionHistory: [{ runId: historyId, hostRef: reserve }] } }
    await client.query(`insert into ci_runs(id,state,record)
      select id,state,record from jsonb_to_recordset($1::jsonb) as x(id text,state text,record jsonb)`,
    [JSON.stringify([...recent, old])])
    expect(await ciDirectoryCleanupCandidates(client, { hostRef: primary, label: 'Primary' }, now)).toEqual([])
    expect((await ciDirectoryCleanupCandidates(client, { hostRef: reserve, label: 'Reserve' }, now)).sort())
      .toEqual([retryId, historyId].sort())
  } finally { await client.end() }
})
