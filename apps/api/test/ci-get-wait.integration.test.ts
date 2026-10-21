import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiRunRecordSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type CiCommits } from '../src/modules/ci-host/service.js'
import { CI_GET_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

it('long-polls authenticated MCP against persisted ticket changes and reads them back after restart', async () => {
  const database = await migratedDatabase()
  const pool = database.pool
  const workspaceId = randomUUID()
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
  try {
    await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'CI wait fixture' })])
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (granted: boolean) => {
      const issued = await access.issue({ name: 'CI wait reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000),
        grants: granted ? [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: [workspaceId] } }] : [] })
      const client = new Client({ name: 'ci-wait-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
      return { client, issued }
    }
    const reader = await connect(true)
    const denied = await connect(false)
    let record = CiRunRecordSchema.parse({
      id: randomUUID(), workspaceId, groupId: randomUUID(), suite: 'lint', part: null, partition: null,
      scope: 'full', files: [], repository: 'owner/repo', commit: 'a'.repeat(40), state: 'running',
      computer: null, step: 'lint', exitCode: null, message: null,
      queuedAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null,
      initiator: { principalId: reader.issued.principal.id, executionId: null },
    })
    await pool.query('insert into ci_runs(id,workspace_id,group_id,state,record,log_tail) values($1,$2,$3,$4,$5::jsonb,$6)',
      [record.id, workspaceId, record.groupId, record.state, JSON.stringify(record), 'persisted log\n'])
    const args = { workspaceId, ticketId: record.id, waitSeconds: 5, logTail: false }
    const rejected = await denied.client.callTool({ name: 'ci_get', arguments: args })
    expect(rejected.isError).toBe(true)
    expect(JSON.stringify(rejected.content)).toContain('ACCESS_DENIED')
    let completed = false
    const waiting = reader.client.callTool({ name: 'ci_get', arguments: args }).then(result => {
      completed = true
      return result
    })
    // This window verifies that an unchanged ticket does not complete the wait.
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(completed).toBe(false)
    record = { ...record, step: 'collecting' }
    await pool.query('update ci_runs set record=$2::jsonb where id=$1', [record.id, JSON.stringify(record)])
    const changed = CiGetOutputSchema.parse(decodeMcpToolResult(await waiting))
    expect(changed.run).toEqual(record)
    expect(changed).not.toHaveProperty('logTail')
    record = { ...record, state: 'passed', exitCode: 0, finishedAt: new Date().toISOString() }
    await pool.query('update ci_runs set state=$2,record=$3::jsonb where id=$1',
      [record.id, record.state, JSON.stringify(record)])
    await ci.close()
    const restarted = create()
    try {
      const readback = await restarted.get(reader.issued.principal, { workspaceId, ticketId: record.id })
      expect(readback.run).toEqual(record)
      expect(readback.logTail).toBe('persisted log\n')
      const terminal = CiGetOutputSchema.parse(decodeMcpToolResult(
        await reader.client.callTool({ name: 'ci_get', arguments: args })))
      expect(terminal.run).toEqual(record)
    } finally { await restarted.close() }
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await ci.close()
    await app.close()
    await database.close()
  }
}, 60_000)
