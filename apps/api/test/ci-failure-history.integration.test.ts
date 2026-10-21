import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiRunRecordSchema, CiTestResultsSchema, type CiTestResults } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService } from '../src/modules/ci-host/service.js'
import { CI_GET_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

type TestFile = CiTestResults['files'][number]
function testFile(file: string, status: 'passed' | 'failed',
  options: { includeOlderTest?: boolean } = {}): TestFile {
  return { file, status, durationMs: 1, tests: [
    { name: 'shared assertion', status, durationMs: 1 },
    ...(options.includeOlderTest ? [{ name: 'older assertion', status: 'failed' as const, durationMs: 1 }] : []),
  ] }
}

async function fixture() {
  const pool = database.pool
  const workspaceId = randomUUID()
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [workspaceId, JSON.stringify({ id: workspaceId, name: 'Failure history fixture' })])
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const ci = new HostCiService(pool, commands, new RunCiAuthority(pool), {
    resolve: async () => { throw new Error('Ticket reads must not resolve commits') },
    capabilities: async () => ({ parts: false, integrationPartitions: false, affected: false }),
  }, {
    computers: async () => [],
    request: async () => { throw new Error('Ticket reads must not contact build computers') },
  })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices },
  })
  const clients: Client[] = []
  const issued = await access.issue({ name: 'History reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: [workspaceId] } }],
  })
  const connect = async (token: string, address: string) => {
    const client = new Client({ name: 'ci-history-fixture', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    return client
  }
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const reader = await connect(issued.token, address)
    const deniedCredential = await access.issue({ name: 'History nonreader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [],
    })
    const denied = await connect(deniedCredential.token, address)
    const now = Date.now()
    const insert = async (files: TestFile[], options: {
      minutesAgo: number; gate?: boolean; workspaceId?: string; state?: 'passed' | 'failed' | 'canceled';
    }) => {
      const at = new Date(now - options.minutesAgo * 60_000).toISOString()
      const tests = files.flatMap(file => file.tests)
      const failed = tests.filter(test => test.status === 'failed').length
      const results = CiTestResultsSchema.parse({ files, truncated: false,
        summary: { passed: tests.length - failed, failed, skipped: 0 },
      })
      const state = options.state ?? (files.some(file => file.status === 'failed') ? 'failed' : 'passed')
      const record = CiRunRecordSchema.parse({ id: randomUUID(), groupId: randomUUID(),
        workspaceId: options.workspaceId ?? workspaceId, suite: 'integration', part: null, partition: null,
        gate: options.gate ?? true, scope: 'full', files: files.map(file => file.file),
        repository: 'fixture/project', commit: 'c'.repeat(40), state, computer: null, step: 'integration',
        exitCode: state === 'passed' ? 0 : 1, message: null, queuedAt: at, startedAt: at, finishedAt: at,
        initiator: { principalId: issued.principal.id, executionId: null },
      })
      await pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,test_results,created_at)
        values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
      [record.id, record.workspaceId, record.groupId, state, JSON.stringify(record), JSON.stringify(results), at])
      return record.id
    }
    const call = (client: Client, ticketId: string) => client.callTool({ name: 'ci_get',
      arguments: { workspaceId, ticketId, logTail: false },
    })
    return { workspaceId, insert, denied: (ticketId: string) => call(denied, ticketId),
      async read(ticketId: string) {
        const result = await call(reader, ticketId)
        expect(result.isError).not.toBe(true)
        return CiGetOutputSchema.parse(decodeMcpToolResult(result))
      },
      async close() {
        await Promise.all(clients.map(client => client.close()))
        await ci.close()
        await app.close()
      },
    }
  } catch (error) {
    await Promise.all(clients.map(client => client.close()))
    await ci.close()
    await app.close()
    throw error
  }
}

it('ci_get counts only the newest twenty matching gate runs before selecting test names', async () => {
  const f = await fixture()
  try {
    const file = 'apps/api/test/tracked.integration.test.ts'
    const unrelated = 'apps/api/test/unrelated.integration.test.ts'
    // The oldest five matches fail; only one of the newest twenty fails this file.
    for (let index = 0; index < 25; index++) {
      const status = index < 5 || index === 23 ? 'failed' : 'passed'
      await f.insert([testFile(unrelated, 'failed'), testFile(file, status, { includeOlderTest: index < 5 })],
        { minutesAgo: 120 - index * 2 })
    }
    // More recent nonmatching runs must not consume the twenty-run history limit.
    for (let index = 0; index < 30; index++) {
      await f.insert([testFile(unrelated, 'failed')], { minutesAgo: 60 - index })
    }
    await f.insert([testFile(file, 'failed', { includeOlderTest: true })], { minutesAgo: 5, gate: false })
    await f.insert([testFile(file, 'failed', { includeOlderTest: true })], { minutesAgo: 15 * 24 * 60 })
    await f.insert([testFile(file, 'failed', { includeOlderTest: true })], { minutesAgo: 4, state: 'canceled' })
    const otherWorkspace = randomUUID()
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [otherWorkspace, JSON.stringify({ id: otherWorkspace, name: 'Other history workspace' })])
    await f.insert([testFile(file, 'failed', { includeOlderTest: true })], { minutesAgo: 3, workspaceId: otherWorkspace })
    const ticketId = await f.insert([testFile(file, 'failed', { includeOlderTest: true })], { minutesAgo: 0 })
    const expected = [
      { file, test: 'shared assertion', failedRuns: 1, runs: 20 },
      { file, test: 'older assertion', failedRuns: 0, runs: 0 },
    ]
    expect((await f.read(ticketId)).failureHistory).toEqual(expected)
    expect((await f.read(ticketId)).failureHistory).toEqual(expected)
    expect((await f.denied(ticketId)).isError).toBe(true)
  } finally { await f.close() }
}, 60_000)

it('ci_get returns empty history counts without error for a newly added failing file', async () => {
  const f = await fixture()
  try {
    const file = 'apps/api/test/added.integration.test.ts'
    for (let index = 0; index < 30; index++) {
      await f.insert([testFile('apps/api/test/existing.integration.test.ts', 'failed')], { minutesAgo: index + 1 })
    }
    const ticketId = await f.insert([{ file, status: 'failed', durationMs: 1, tests: [] }], { minutesAgo: 0 })
    const read = await f.read(ticketId)
    expect(read.run.id).toBe(ticketId)
    expect(read.failedFiles).toEqual([file])
    expect(read.failureHistory).toEqual([{ file, test: null, failedRuns: 0, runs: 0 }])
  } finally { await f.close() }
}, 60_000)
