import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiHostRequestSchema, CiRunOutputSchema,
  type CiHostRequest, type CiHostRun, type CiTestResults } from '@foreman-code/contracts'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { RunCiAuthority, CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { ciReadWhen } from './helpers/ciReadWhen.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { ciRunReadback } from './helpers/ciRunReadback.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

it.each([
  { includeProvenance: false, failure: 'endpoint-error' },
  { includeProvenance: true, failure: 'endpoint-error' },
  { includeProvenance: true, failure: 'empty-complete' },
])('persists outcome and retries collection after $failure with provenance=$includeProvenance', async ({ includeProvenance, failure }) => {
  const pool = database.pool
  const workspaceId = randomUUID()
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId, JSON.stringify({
    id: workspaceId, name: 'CI collection', repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' },
  })])
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const computer = { key: 'ci-builder', hostRef: { kind: 'main' as const, mainId: 'ci-main' }, label: 'CI builder', priority: 1 }
  const provenance = { sourceCommit: 'a'.repeat(40), workflowCommit: 'b'.repeat(40), workflowRef: `ci-snapshot/${'b'.repeat(40)}` }
  const persistedPins = includeProvenance ? { provenance } : {}
  const tests: CiTestResults = { summary: { passed: 1, failed: 0, skipped: 0 }, truncated: false,
    files: [{ file: 'apps/api/test/example.test.ts', status: 'passed', durationMs: 10,
      tests: [{ name: 'returns café 🚀', status: 'passed', durationMs: 10, message: 'Done.\0\ud800' }] }] }
  const expectedTests: CiTestResults = { ...tests,
    files: [{ ...tests.files[0]!, tests: [{ ...tests.files[0]!.tests[0]!, message: 'Done.\ufffd' }] }] }
  let remote: CiHostRun | undefined
  let finished = false
  let failedRead = false
  let starts = 0
  const reads: CiHostRequest[] = []
  const endpoint: HostCiEndpoint = {
    computers: async () => [computer],
    request: async (_computer, request) => {
      if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
        cpuCount: 4, memoryBytes: 8 * 2 ** 30, runs: remote ? [remote] : [] }
      if (request.operation === 'start') {
        starts++
        remote = { runId: request.runId, state: 'running', step: 'unit', startedAt: new Date().toISOString(),
          finishedAt: null, exitCode: null, logBytes: 0, message: null, ...persistedPins }
        return { operation: 'start', run: remote }
      }
      if (!remote || request.operation !== 'read') throw new Error('Unexpected CI request')
      reads.push(CiHostRequestSchema.parse(request))
      const run = finished ? { ...remote, state: 'passed' as const, exitCode: 0, finishedAt: new Date().toISOString() } : remote
      if (request.testResults && !failedRead) {
        failedRead = true
        if (failure === 'endpoint-error') throw new Error('Temporary result endpoint failure')
        return { operation: 'read', run: { ...run, collection: 'complete' }, text: '', nextOffset: 0 }
      }
      return { operation: 'read', run, text: '', nextOffset: 0,
        ...(request.testResults ? { testResults: tests } : {}) }
    },
  }
  const commits: CiCommits = {
    resolve: async () => provenance.sourceCommit,
    capabilities: async () => ({ parts: false, integrationPartitions: false, affected: false }),
  }
  const create = () => new HostCiService(pool, commands, new RunCiAuthority(pool), commits, endpoint)
  let ci = create()
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (actions: ManagementAction[]) => {
    const issued = await access.issue({ name: 'CI reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions, scope: { workspaceIds: [workspaceId] } }] })
    const client = new Client({ name: 'ci-collection-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
    return client
  }
  try {
    const operator = await connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const denied = await connect(['workspaces:read'])
    const invoke = async (name: string, input: Record<string, unknown>) => decodeMcpToolResult(await operator.callTool({
      name, arguments: { workspaceId, ...input },
    }))
    const started = CiRunOutputSchema.parse(await invoke('ci_run', { suite: 'unit', scope: 'full', commandId: randomUUID() }))
    await ci.dispatch()
    await ciReadWhen(pool, async () => CiGetOutputSchema.parse(await invoke('ci_get', { ticketId: started.ticketId })),
      output => output.run.state === 'running')
    finished = true
    await ci.dispatch()
    const pending = await ciReadWhen(pool, async () => CiGetOutputSchema.parse(await invoke('ci_get', { ticketId: started.ticketId })),
      output => output.run.state === 'passed' && output.run.collection === 'pending')
    expect(reads).toContainEqual({ operation: 'read', runId: started.ticketId,
      afterOffset: 0, maxBytes: 32_768, durations: true })
    expect(pending.run).toMatchObject({ state: 'passed', collection: 'pending', ...persistedPins })
    expect((await denied.callTool({ name: 'ci_get', arguments: { workspaceId, ticketId: started.ticketId } })).isError).toBe(true)
    const stored = await pool.query<{ record: unknown }>('select record from ci_runs where id=$1', [started.ticketId])
    expect(stored.rows[0]!.record).toMatchObject({ state: 'passed', collection: 'pending', ...persistedPins })
    await ci.close()
    ci = create()
    ci.start()
    const complete = await ciRunReadback(input => invoke('ci_get', { ...input, testStatus: ['passed'] }),
      started.ticketId, 'passed')
    expect(complete.run).toMatchObject({ state: 'passed', collection: 'complete', ...persistedPins })
    expect(complete.tests).toEqual(expectedTests)
    expect(starts).toBe(1)
    expect((await pool.query('select test_results from ci_runs where id=$1', [started.ticketId])).rows[0].test_results).toEqual(expectedTests)
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await ci.close()
    await app.close()
  }
})
