import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it } from 'vitest'
import { CiRunRecordSchema, type CiHostReply, type CiHostRun, type CiRunRecord } from '@foreman-code/contracts'
import { ownedTestDatabaseUrl } from '../../../test/helpers/testResources.js'
import { migrations, assertMigrationVersions } from '../../infrastructure/migrations.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiComputer } from './service.js'
import { ticketStore } from './ciTicketStore.testSupport.js'
import { ciExecutionRunId } from './executionAttempt.js'
import { ciDirectoryCleanupCandidates } from './directoryRetention.js'

const github: HostCiComputer = { key: 'fixture:cloud:github:0', label: 'GitHub Actions', priority: 0,
  hostRef: { kind: 'cloud', mainId: 'fixture', provider: 'github', slot: 0 } }
const circle: HostCiComputer = { key: 'fixture:cloud:circleci:0', label: 'CircleCI', priority: 0,
  hostRef: { kind: 'cloud', mainId: 'fixture', provider: 'circleci', slot: 0 } }
const builder: HostCiComputer = { key: 'fixture:main', label: 'Main computer', priority: 0,
  hostRef: { kind: 'main', mainId: 'fixture' } }

async function observe(run: CiRunRecord, computer: HostCiComputer, state: CiHostRun['state']) {
  const assigned = CiRunRecordSchema.parse({ ...run, state: 'running', step: 'queued',
    computer: { hostRef: computer.hostRef, label: computer.label }, startedAt: new Date().toISOString() })
  const store = ticketStore([assigned], { [run.id]: computer.key })
  const authority: CiAuthority = { resolve: async principal => ({ principal, workspaceId: 'workspace' }) }
  const ci = new HostCiService(store.pool, new PostgresCommandCoordinator(store.pool), authority, {} as CiCommits, {
    computers: async () => [],
    request: async (_computer, request): Promise<CiHostReply> => {
      if (request.operation !== 'read') throw new Error(`Unexpected ${request.operation}`)
      expect(request.runId).toBe(ciExecutionRunId(run))
      const terminal = state === 'failed' || state === 'passed'
      return { operation: 'read', text: '', nextOffset: 0, run: {
        runId: request.runId, state, step: null, logBytes: 0,
        startedAt: assigned.startedAt ?? new Date().toISOString(), finishedAt: terminal ? new Date().toISOString() : null,
        exitCode: terminal ? Number(state === 'failed') : null, message: null,
        ...(state === 'failed' ? { testsStarted: false } : {}),
      } }
    },
  })
  try {
    await ci.dispatch()
    await ci.drain()
    const settled = store.read(run.id).record
    expect(settled.state).toBe(state === 'failed' ? 'queued' : state)
    return settled
  } finally {
    await ci.close()
  }
}

async function insertTickets(client: pg.Client, records: { id: string; state: string; record: unknown }[]) {
  await client.query(`insert into ci_runs (id,state,record)
    select id,state,record from jsonb_to_recordset($1::jsonb) as x(id text,state text,record jsonb)`,
  [JSON.stringify(records)])
}

it.each([false, true])('selects every executor after reassignment then setup retry, same provider: %s', async sameProvider => {
  const hosts = sameProvider ? [github,
    { ...github, key: 'fixture:cloud:github:1', hostRef: { ...github.hostRef, slot: 1 } },
    { ...github, key: 'fixture:cloud:github:2', hostRef: { ...github.hostRef, slot: 2 } }] : [github, circle, builder]
  const id = randomUUID()
  const initial = CiRunRecordSchema.parse({ id, workspaceId: 'workspace', groupId: id, suite: 'lint', part: null,
    scope: 'full', files: [], partition: null, repository: 'fixture/site', commit: 'a'.repeat(40), state: 'queued',
    computer: null, step: null, exitCode: null, message: null, queuedAt: new Date().toISOString(),
    startedAt: null, finishedAt: null, initiator: { principalId: 'operator', executionId: null } })
  const reassigned = await observe(initial, hosts[0]!, 'queued')
  const secondId = ciExecutionRunId(reassigned)
  expect(secondId).not.toBe(id)
  const retried = await observe(reassigned, hosts[1]!, 'failed')
  const thirdId = ciExecutionRunId(retried)
  expect(thirdId).not.toBe(secondId)
  expect(thirdId).not.toBe(id)
  const finished = await observe(retried, hosts[2]!, 'passed')
  const cleanupAt = Date.now() + 4 * 86_400_000
  const client = new pg.Client({ connectionString: ownedTestDatabaseUrl() })
  await client.connect()
  try {
    await client.query('create temporary table ci_runs (id text primary key, state text, record jsonb)')
    const retained = (sameProvider ? [github] : hosts).flatMap(host => Array.from({ length: 201 }, () => ({
      id: randomUUID(), state: 'passed', record: { computer: { hostRef: host.hostRef, label: host.label },
        finishedAt: new Date(cleanupAt).toISOString() },
    })))
    await insertTickets(client, [...retained, { id, state: finished.state, record: finished }])
    // Check the failed intermediate executor first: its directory is B, not the ticket's A.
    for (const index of [1, 0, 2]) {
      const host = hosts[index]!
      const expected = sameProvider ? [id, secondId, thirdId] : [[id], [secondId], [thirdId]][index]!
      const candidates = await ciDirectoryCleanupCandidates(client, { hostRef: host.hostRef, label: host.label }, cleanupAt)
      expect(candidates.sort()).toEqual([...expected].sort())
    }
    expect(await ciDirectoryCleanupCandidates(client,
      { hostRef: { kind: 'main', mainId: 'unrelated' }, label: 'Unrelated executor' }, cleanupAt)).toEqual([])
  } finally {
    await client.end()
  }
})

it('selects deduplicated prior directories when the terminal ticket has no current computer', async () => {
  const id = randomUUID()
  const previousId = randomUUID()
  const cleanupAt = Date.now() + 4 * 86_400_000
  const client = new pg.Client({ connectionString: ownedTestDatabaseUrl() })
  await client.connect()
  try {
    await client.query('create temporary table ci_runs (id text primary key, state text, record jsonb)')
    await insertTickets(client, [
      ...Array.from({ length: 201 }, () => ({ id: randomUUID(), state: 'passed',
        record: { computer: { hostRef: github.hostRef, label: github.label }, finishedAt: new Date(cleanupAt).toISOString() } })),
      { id, state: 'canceled', record: { computer: null, finishedAt: new Date().toISOString(), executionHistory: [
        { runId: previousId, hostRef: github.hostRef },
        { runId: previousId, hostRef: { ...github.hostRef, slot: 1 } },
        { runId: id, hostRef: circle.hostRef },
      ] } },
    ])
    const host = { hostRef: github.hostRef, label: github.label }
    expect(await ciDirectoryCleanupCandidates(client, host, cleanupAt)).toEqual([previousId])
    assertMigrationVersions(migrations)
    const migration = migrations.find(entry => entry.version === 2026101608)
    if (!migration) throw new Error('Execution history cleanup migration is not registered')
    await client.query(migration.sql)
    expect(await ciDirectoryCleanupCandidates(client, host, cleanupAt)).toEqual([previousId])
  } finally {
    await client.end()
  }
})
