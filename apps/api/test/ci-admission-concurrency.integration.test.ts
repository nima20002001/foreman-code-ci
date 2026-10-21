import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiRunOutputSchema, type CiRunInput } from '@foreman-code/contracts'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type CiCommits } from '../src/modules/ci-host/service.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { createTestPool } from './helpers/testPool.mjs'
import { expectCiPreparationOutsideTransaction } from './helpers/ciPreparationTransactions.js'
import { ciRunReadback } from './helpers/ciRunReadback.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

function barrier() {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  return { entered, release, wait: async () => { enter(); await blocked } }
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Admission did not complete while resolution was blocked.')), 2000)
    })])
  } finally {
    clearTimeout(timer)
  }
}

async function fixture(overrides: Partial<CiCommits>) {
  const pool = createTestPool({ connectionString: database.databaseUrl, max: 10,
    application_name: 'ci-admission-test', options: '-c statement_timeout=300 -c lock_timeout=300' })
  const workspaceId = randomUUID()
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId, JSON.stringify({
    id: workspaceId, name: 'CI workspace',
    repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' },
  })])
  const commits: CiCommits = {
    capabilities: async () => ({ parts: false, integrationPartitions: false, affected: true }),
    resolve: async (_repository, _branch, commit) => commit ?? 'a'.repeat(40),
    ...overrides,
  }
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const ci = new HostCiService(pool, commands, new RunCiAuthority(pool), commits, {
    computers: async () => [], request: async () => { throw new Error('No executor is configured') },
  })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (actions: ManagementAction[], scopeWorkspace = workspaceId) => {
    const issued = await access.issue({ name: 'CI caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions, scope: { workspaceIds: [scopeWorkspace] } }] })
    const client = new Client({ name: 'ci-concurrency-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
    }))
    return { client, token: issued.token, principalId: issued.principal.id }
  }
  const operator = await connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
  const call = (name: string, input: Record<string, unknown>, client = operator.client) =>
    client.callTool({ name, arguments: { workspaceId, ...input } })
  const run = async (input: CiRunInput) => {
    const result = await call('ci_run', input)
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return CiRunOutputSchema.parse(decodeMcpToolResult(result))
  }
  const read = async (ticketId: string) => {
    const result = await call('ci_get', { ticketId })
    expect(result.isError).not.toBe(true)
    return CiGetOutputSchema.parse(decodeMcpToolResult(result)).run
  }
  return { pool, workspaceId, principalId: operator.principalId, connect, call, run, read,
    http: (input: CiRunInput) => app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/ci`, payload: input,
      headers: { authorization: `Bearer ${operator.token}` } }),
    close: async () => {
      await Promise.all(clients.map(client => client.close()))
      await ci.close()
      await app.close()
      await pool.end()
    } }
}

it('admits concurrent authenticated MCP and HTTP requests while another commit resolver is blocked', async () => {
  const blocked = barrier()
  const slowCommit = 'a'.repeat(40)
  const resolve = vi.fn<CiCommits['resolve']>(async (_repository, _branch, commit) => {
    if (commit === slowCommit) await blocked.wait()
    return commit!
  })
  const f = await fixture({ resolve })
  const input: CiRunInput = { commandId: 'slow-resolution', suite: 'unit', scope: 'affected',
    files: ['apps/api/src/example.test.ts'], commit: slowCommit }
  let settled = false
  const first = f.call('ci_run', input).then(result => { settled = true; return result })
  let duplicate: ReturnType<typeof f.call> | undefined
  try {
    await within(blocked.entered)
    duplicate = f.call('ci_run', input)
    const fastInput = { ...input, commit: 'b'.repeat(40) }
    const admissions = await within(Promise.all([
      f.run({ ...fastInput, commandId: 'fast-mcp-one' }),
      f.run({ ...fastInput, commandId: 'fast-mcp-two' }),
      f.http({ ...fastInput, commandId: 'fast-http' }).then(response => {
        expect(response.statusCode).toBe(200)
        return CiRunOutputSchema.parse(response.json())
      }),
    ]))
    expect(settled).toBe(false)
    expect(new Set(admissions.map(value => value.ticketId)).size).toBe(3)
    for (const admission of admissions) {
      expect(await f.read(admission.ticketId)).toMatchObject({ commit: fastInput.commit,
        scope: 'affected', files: input.files, state: 'queued' })
    }
    const denied = await f.connect(CI_RUN_ACTIONS, randomUUID())
    const calls = resolve.mock.calls.length
    expect((await f.call('ci_run', { ...fastInput, commandId: 'denied' }, denied.client)).isError).toBe(true)
    expect(resolve).toHaveBeenCalledTimes(calls)
    await expectCiPreparationOutsideTransaction(f.pool, `command:${f.principalId}:ci.run:${input.commandId}`)
    blocked.release()
    const result = await first
    expect(result.isError).not.toBe(true)
    const accepted = CiRunOutputSchema.parse(decodeMcpToolResult(result))
    expect(decodeMcpToolResult(await duplicate)).toEqual(accepted)
    expect(await f.run(input)).toEqual(accepted)
    expect(resolve.mock.calls.filter(([, , commit]) => commit === slowCommit)).toHaveLength(1)
    expect((await f.call('ci_run', { ...input, files: [] })).isError).toBe(true)
    expect((await f.pool.query<{ count: number }>(`select count(*)::int as count from ci_runs
      where workspace_id=$1`, [f.workspaceId])).rows[0]!.count).toBe(4)
    expect((await f.pool.query(`select outcome from management_audit
      where action='ci.run' and target_key=$1 and details->>'commandId'='slow-resolution'`,
    [f.workspaceId])).rows).toEqual([{ outcome: 'succeeded' }, { outcome: 'failed' }])
    expect((await f.pool.query(`select outcome from management_audit
      where action='ci_run' and outcome='denied'`)).rows).toContainEqual({ outcome: 'denied' })
  } finally {
    blocked.release()
    await first
    await duplicate
    await f.close()
  }
})

it('prepares supersession ancestry outside the lock and includes tickets admitted during preparation', async () => {
  const blocked = barrier()
  const [oldCommit, middleCommit, nextCommit] = ['a', 'b', 'c'].map(value => value.repeat(40))
  const f = await fixture({ branch: async () => 'feature',
    isAncestor: async (_repository, ancestor, commit) => {
      if (ancestor === oldCommit && commit === nextCommit) await blocked.wait()
      return ancestor !== commit
    } })
  const input: CiRunInput = { commandId: 'old', suite: 'unit', scope: 'affected',
    files: ['apps/api/src/example.test.ts'], commit: oldCommit }
  let next: ReturnType<typeof f.call> | undefined
  try {
    const old = await f.run(input)
    next = f.call('ci_run', { ...input, commandId: 'next', commit: nextCommit })
    await within(blocked.entered)
    const middle = await within(f.run({ ...input, commandId: 'middle', commit: middleCommit }))
    const oldRead = await ciRunReadback(async input => decodeMcpToolResult(await f.call('ci_get', input)),
      old.ticketId, 'canceled')
    expect(oldRead.run).toMatchObject({ supersededBy: middle.ticketId, state: 'canceled' })
    blocked.release()
    const result = await next
    expect(result.isError).not.toBe(true)
    const accepted = CiRunOutputSchema.parse(decodeMcpToolResult(result))
    // Supersession is recorded at admission; the cancellation may finish after a pending dispatch settles.
    const superseded = await ciRunReadback(async input => decodeMcpToolResult(await f.call('ci_get', input)),
      middle.ticketId, 'canceled')
    expect(superseded.run).toMatchObject({ supersededBy: accepted.ticketId, state: 'canceled' })
    expect((await f.pool.query(`select outcome from management_audit
      where action='ci.run' and target_key=$1 and details->>'commandId'='next'`, [f.workspaceId])).rows)
      .toEqual([{ outcome: 'succeeded' }])
  } finally {
    blocked.release()
    await next
    await f.close()
  }
})

it('rechecks grants after slow preparation before inserting a CI ticket', async () => {
  const blocked = barrier()
  const f = await fixture({ resolve: async () => { await blocked.wait(); return 'a'.repeat(40) } })
  const request = f.call('ci_run', { commandId: 'revoked', suite: 'unit', files: [], commit: 'a'.repeat(40) })
  try {
    await within(blocked.entered)
    await f.pool.query("update management_principals set grants='[]'::jsonb where id=$1", [f.principalId])
    blocked.release()
    expect((await request).isError).toBe(true)
    expect((await f.pool.query('select id from ci_runs where workspace_id=$1', [f.workspaceId])).rows).toEqual([])
  } finally {
    blocked.release()
    await request
    await f.close()
  }
})
