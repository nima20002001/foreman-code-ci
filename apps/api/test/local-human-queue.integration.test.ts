import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('local human queue transport parity', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let access: PostgresAccessService
  let writer: Awaited<ReturnType<PostgresAccessService['issue']>>
  let reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  const queues: Awaited<ReturnType<typeof buildQueueFixture>>[] = []
  const apps: ReturnType<typeof buildApp>[] = []
  const clients: Client[] = []
  beforeEach(async () => {
    database = await agent3Database()
    access = new PostgresAccessService(database.pool)
    writer = await access.issue({ name: 'Local queue fixture writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{
        actions: ['job_definitions:read', 'job_definitions:write', 'jobs:start', 'jobs:read', 'jobs:cancel',
          'settings:read', 'settings:update', 'capabilities:read'], scope: {},
      }] })
    reader = await access.issue({ name: 'Queue MCP reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['jobs:read'], scope: {} }] })
  }, 60_000)
  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map(client => client.close()))
    await Promise.allSettled(apps.splice(0).map(app => app.close()))
    await Promise.allSettled(queues.splice(0).map(queue => queue.jobs.closeQueue()))
    await database?.close()
  })
  it('reads the persisted queue without browser credentials and matches authenticated MCP', async () => {
    const f = await buildQueueFixture(database.pool, writer.principal)
    queues.push(f)
    const definition = await f.save()
    const admission = await f.jobs.enqueue(f.principal, 'http', f.workspaceId, {
      commandId: randomUUID(), definitionId: definition.id, expectedRevision: definition.revision,
    })
    if (admission.kind === 'retained-execution') throw new Error('A fresh request must own a queue ticket.')
    const ticketId = admission.kind === 'accepted' ? admission.ticketId : admission.ticket.id
    await f.jobs.wakeQueue()
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { jobs: f.jobs, commands: f.commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const client = new Client({ name: 'local-queue-parity', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${reader.token}` } } }))
    const read = await client.callTool({ name: 'job_queue_get', arguments: {
      workspaceId: f.workspaceId, ticketId,
    } })
    expect(read.isError).not.toBe(true)
    const persisted = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticketId)
    expect(decodeMcpToolResult(read)).toEqual({ ticket: persisted })
    const listed = await client.callTool({ name: 'job_queue_list', arguments: { workspaceId: f.workspaceId } })
    expect(listed.isError).not.toBe(true)
    const localRead = await app.inject({ method: 'GET',
      url: `/api/management/workspaces/${f.workspaceId}/jobs/queue/${persisted.id}` })
    expect(localRead.statusCode, localRead.body).toBe(200)
    expect(localRead.json()).toEqual(decodeMcpToolResult(read))
    const localList = await app.inject({ method: 'GET',
      url: `/api/management/workspaces/${f.workspaceId}/jobs/queue` })
    expect(localList.statusCode, localList.body).toBe(200)
    expect(localList.json()).toEqual(decodeMcpToolResult(listed))
  })
})
