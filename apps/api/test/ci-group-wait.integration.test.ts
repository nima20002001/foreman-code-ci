import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type CiCommits } from '../src/modules/ci-host/service.js'
import { CI_GET_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

// eslint-disable-next-line no-restricted-syntax -- the helper only bounds negative windows and ordering, never a result
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const finishedAt = new Date().toISOString()

/** One workspace, one CI group initiated by the reader, and MCP clients for the reader and an ungranted caller. */
async function groupFixture() {
  const database = await migratedDatabase()
  const pool = database.pool
  const workspaceId = randomUUID()
  const groupId = randomUUID()
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const create = () => new HostCiService(pool, commands, new RunCiAuthority(pool), {} as CiCommits, {
    computers: async () => [], request: async () => { throw new Error('Unexpected build computer call') },
  })
  const ci = create()
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { ci, commands } as unknown as OperatorServices } })
  const clients: Client[] = []
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [workspaceId, JSON.stringify({ id: workspaceId, name: 'CI group wait fixture' })])
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const connect = async (granted: boolean) => {
    const issued = await access.issue({ name: 'CI group reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: granted ? [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: [workspaceId] } }] : [] })
    const client = new Client({ name: 'ci-group-wait-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
    return { client, issued }
  }
  const reader = await connect(true)
  const denied = await connect(false)
  const insert = async (changes: Partial<CiRunRecord>) => {
    const record = CiRunRecordSchema.parse({
      id: randomUUID(), workspaceId, groupId, suite: 'lint', part: null, partition: null, scope: 'full', files: [],
      repository: 'owner/repo', commit: 'a'.repeat(40), state: 'running', computer: null, step: 'lint',
      exitCode: null, message: null, queuedAt: new Date().toISOString(), startedAt: new Date().toISOString(),
      finishedAt: null, initiator: { principalId: reader.issued.principal.id, executionId: null }, ...changes,
    })
    await pool.query('insert into ci_runs(id,workspace_id,group_id,state,record,log_tail) values($1,$2,$3,$4,$5::jsonb,$6)',
      [record.id, workspaceId, groupId, record.state, JSON.stringify(record), ''])
    return record
  }
  const save = async (record: CiRunRecord) => {
    await pool.query('update ci_runs set state=$2,record=$3::jsonb where id=$1', [record.id, record.state, JSON.stringify(record)])
  }
  const call = (client: Client, ticketId: string, args: Record<string, unknown>) => client.callTool({ name: 'ci_get',
    arguments: { workspaceId, ticketId, logTail: false, ...args } })
  return { insert, save, call, reader, denied, create, workspaceId,
    close: async () => {
      await Promise.all(clients.map(client => client.close()))
      await ci.close()
      await app.close()
      await database.close()
    } }
}

const groupWait = { waitUntil: 'group-terminal', waitSeconds: 30 } as const
const value = (result: Parameters<typeof decodeMcpToolResult>[0]) => CiGetOutputSchema.parse(decodeMcpToolResult(result))

it('holds an authenticated group wait until every ticket is terminal and survives a restart', async () => {
  const f = await groupFixture()
  try {
    const a = await f.insert({ state: 'passed', exitCode: 0, finishedAt })
    const b = await f.insert({ state: 'running' })
    const denied = await f.call(f.denied.client, a.id, groupWait)
    expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
    const budget = value(await f.call(f.reader.client, a.id, { waitUntil: 'group-terminal', waitSeconds: 1 }))
    expect(budget.wait).toMatchObject({ until: 'group-terminal', status: 'still-running', tickets: 2, settledTickets: 1 })
    let completed = false
    const started = performance.now()
    const pending = f.call(f.reader.client, a.id, groupWait).then(result => { completed = true; return result })
    // eslint-disable-next-line no-restricted-syntax -- a bounded window in which the wait must not complete yet
    await pause(300)
    expect(completed).toBe(false)
    await f.save({ ...b, state: 'passed', exitCode: 0, finishedAt })
    const settled = value(await pending)
    expect(settled.wait).toMatchObject({ status: 'settled', tickets: 2, settledTickets: 2 })
    expect(performance.now() - started).toBeLessThan(10_000)
    const restarted = f.create()
    try {
      const readback = await restarted.get(f.reader.issued.principal, { workspaceId: f.workspaceId, ticketId: a.id,
        waitUntil: 'group-terminal', waitSeconds: 30 })
      expect(readback.run).toEqual(a)
      expect(readback).toMatchObject({ wait: { status: 'settled', tickets: 2, settledTickets: 2 } })
    } finally { await restarted.close() }
  } finally { await f.close() }
}, 60_000)

it('keeps a group open until every passed ticket has its unit results collected', async () => {
  const f = await groupFixture()
  try {
    const a = await f.insert({ state: 'passed', exitCode: 0, finishedAt, collection: 'pending' })
    await f.insert({ state: 'passed', exitCode: 0, finishedAt, collection: 'complete' })
    const budget = value(await f.call(f.reader.client, a.id, { waitUntil: 'group-terminal', waitSeconds: 1 }))
    expect(budget.wait).toMatchObject({ status: 'still-running', tickets: 2, settledTickets: 1 })
    let completed = false
    const pending = f.call(f.reader.client, a.id, groupWait).then(result => { completed = true; return result })
    // eslint-disable-next-line no-restricted-syntax -- a bounded window in which the wait must not complete yet
    await pause(300)
    expect(completed).toBe(false)
    await f.save({ ...a, collection: 'complete' })
    expect(value(await pending).wait).toMatchObject({ status: 'settled', tickets: 2, settledTickets: 2 })
  } finally { await f.close() }
}, 60_000)

it('keeps waiting when a member is added during the wait and settles after the new member', async () => {
  const f = await groupFixture()
  try {
    const a = await f.insert({ state: 'passed', exitCode: 0, finishedAt })
    const b = await f.insert({ state: 'running' })
    let completed = false
    const pending = f.call(f.reader.client, a.id, groupWait).then(result => { completed = true; return result })
    // eslint-disable-next-line no-restricted-syntax -- a bounded window in which the wait must not complete yet
    await pause(300)
    const added = await f.insert({ state: 'running' })
    // eslint-disable-next-line no-restricted-syntax -- a bounded window in which the wait must not complete yet
    await pause(300)
    await f.save({ ...b, state: 'passed', exitCode: 0, finishedAt })
    // eslint-disable-next-line no-restricted-syntax -- a bounded window in which the wait must not complete yet
    await pause(700)
    expect(completed).toBe(false)
    await f.save({ ...added, state: 'passed', exitCode: 0, finishedAt })
    expect(value(await pending).wait).toMatchObject({ status: 'settled', tickets: 3, settledTickets: 3 })
  } finally { await f.close() }
}, 60_000)
