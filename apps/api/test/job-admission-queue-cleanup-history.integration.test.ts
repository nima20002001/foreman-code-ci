import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { JobService } from '../src/modules/jobs/service.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { setupJobAdmissionQueue } from './helpers/jobAdmissionQueue.js'

describe.skipIf(!postgresEnabled)('durable build admission queue: cleanup-history', () => {
  const queue = setupJobAdmissionQueue()
  const { services, apps, clients, fixture, submit } = queue

  it('keeps delayed cleanup active beyond a history page and exposes the scoped claimed computer through HTTP and MCP', async () => {
    const { database, access, writer, reader } = queue
    const f = await fixture()
    const definition = await f.save()
    const original = await submit(f, definition)
    await f.jobs.wakeQueue()
    const prepare = f.accept.getMockImplementation()!
    let resume!: () => void
    let entered!: () => void
    const paused = new Promise<void>(resolve => { resume = resolve })
    const preparing = new Promise<void>(resolve => { entered = resolve })
    f.accept.mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args)
      entered()
      await paused
      return prepared
    })
    f.online()
    const pending = f.jobs.wakeQueue()
    await preparing
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { jobs: f.jobs, commands: f.commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'claim-readback', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
      return client
    }
    const client = await connect(reader.token)
    let claimed: Awaited<ReturnType<JobService['getQueueTicket']>>
    try {
      claimed = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, original.id)
      const computer = f.computers[0]!.candidate
      expect(claimed).toMatchObject({ state: 'claimed', selectedComputer: {
        target: computer.spec.target, rootId: computer.profile.root.binding.rootId,
        bindingRevision: 1, profileId: computer.profile.id, profileRevision: 1,
      } })
      const read = await client.callTool({ name: 'job_queue_get', arguments: {
        workspaceId: f.workspaceId, ticketId: original.id,
      } })
      expect(read.isError).not.toBe(true)
      expect(decodeMcpToolResult(read)).toEqual({ ticket: claimed })
      const http = await app.inject({ method: 'GET',
        url: `/api/management/workspaces/${f.workspaceId}/jobs/queue/${original.id}`,
        headers: { authorization: `Bearer ${reader.token}` } })
      expect(http.statusCode).toBe(200)
      expect(http.json()).toEqual(decodeMcpToolResult(read))
      const foreign = await access.issue({ name: 'Foreign claim reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['jobs:read'],
          scope: { workspaceIds: [randomUUID()] } }] })
      const denied = await (await connect(foreign.token)).callTool({ name: 'job_queue_get', arguments: {
        workspaceId: f.workspaceId, ticketId: original.id,
      } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).not.toContain(computer.spec.target.destination.canonicalProjectRoot)
      const deniedHttp = await app.inject({ method: 'GET',
        url: `/api/management/workspaces/${f.workspaceId}/jobs/queue/${original.id}`,
        headers: { authorization: `Bearer ${foreign.token}` } })
      expect(deniedHttp.statusCode).toBe(403)
      await f.jobs.cancelQueued(writer.principal, 'mcp', f.workspaceId, { commandId: randomUUID(),
        ticketId: claimed.id, expectedRevision: claimed.revision })
    } finally {
      resume()
      await pending
    }
    // History fillers are cancelled before admission; only the original request needs cleanup.
    await f.jobs.closeQueue()
    for (let index = 0; index < 105; index += 8) {
      await Promise.all(Array.from({ length: Math.min(8, 105 - index) }, async () => {
        const admission = await f.jobs.enqueue(f.principal, 'http', f.workspaceId, queue.command(definition))
        if (admission.kind !== 'pending-admission') throw new Error('History fillers must remain queued')
        const newer = admission.ticket
        expect(newer).toMatchObject({ state: 'waiting', selectedComputer: null, cleanupStatus: 'none' })
        const cancelled = await f.jobs.cancelQueued(writer.principal, 'mcp', f.workspaceId, {
          commandId: randomUUID(), ticketId: newer.id, expectedRevision: newer.revision,
        })
        expect(cancelled).toMatchObject({ state: 'terminal', terminalReason: 'cancelled', cleanupStatus: 'none' })
      }))
    }
    const restarted = f.createService()
    services.push(restarted)
    const ticket = await restarted.getQueueTicket(reader.principal, f.workspaceId, original.id)
    expect(ticket).toMatchObject({ state: 'terminal', terminalReason: 'cancelled', cleanupStatus: 'pending',
      selectedComputer: claimed!.selectedComputer })
    const first = await restarted.listQueuePage(reader.principal, f.workspaceId, { historyLimit: 3 })
    expect(first.tickets.filter(item => item.id === original.id)).toEqual([ticket])
    expect(first.tickets).toHaveLength(4)
    const second = await restarted.listQueuePage(reader.principal, f.workspaceId,
      { historyLimit: 3, historyBeforeSequence: first.nextHistoryCursor! })
    expect(second.tickets.filter(item => item.id === original.id)).toEqual([ticket])
    const listed = await client.callTool({ name: 'job_queue_list', arguments: {
      workspaceId: f.workspaceId, historyLimit: 3,
    } })
    expect(decodeMcpToolResult(listed)).toEqual(first)
    const read = await client.callTool({ name: 'job_queue_get', arguments: {
      workspaceId: f.workspaceId, ticketId: original.id,
    } })
    expect(decodeMcpToolResult(read)).toEqual({ ticket })
    const before = (await database.pool.query('select state from source_execution_materializations where execution_id=$1',
      [ticket.executionId])).rows[0]
    expect(before).toEqual({ state: 'prepared' })
    expect((await database.pool.query('select released_at from job_computer_selections where execution_id=$1',
      [ticket.executionId])).rows[0]).toEqual({ released_at: null })
    expect((await database.pool.query("select state from source_storage_reservations where owner_id=$1",
      [ticket.operationId])).rows[0]).toEqual({ state: 'owned' })
  }, 90000)
})
