import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { JobQueuePageSchema, type JobQueueTicket } from '@foreman-code/contracts/job-admission'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { setupJobAdmissionQueue } from './helpers/jobAdmissionQueue.js'

describe.skipIf(!postgresEnabled)('durable build admission queue: pagination', () => {
  const queue = setupJobAdmissionQueue()
  const { services, apps, clients, fixture, submit } = queue

  it('discovers old active requests alongside paginated history through HTTP and authenticated MCP', async () => {
    const { access, writer, reader } = queue
    const f = await fixture({ computerCount: 2 })
    f.computers[0]!.candidate.spec.policy.queueTimeoutMs = 600000
    f.computers[0]!.candidate.profile.policy.queueTimeoutMs = 600000
    const active = await submit(f, await f.save(f.computers[0]!.candidate.spec))
    await f.jobs.wakeQueue()
    const setting = await f.settings.read(writer.principal, { target: f.computers[0]!.target })
    await f.settings.update(writer.principal, 'http', { target: f.computers[0]!.target,
      commandId: randomUUID(), expectedRevision: setting.preference.revision,
      buildEnabled: false, buildPriority: 100 })
    const definition = await f.save(f.computers[1]!.candidate.spec)
    const ticket = await submit(f, definition)
    const target = f.computers[1]!.target
    const currentSetting = await f.settings.read(writer.principal, { target })
    await f.settings.update(writer.principal, 'http', { target,
      commandId: randomUUID(), expectedRevision: currentSetting.preference.revision,
      buildEnabled: false, buildPriority: 100 })
    await f.jobs.wakeQueue()
    const currentTicket = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id)
    expect(currentTicket.revision).toBeGreaterThan(ticket.revision)
    await expect(f.jobs.cancelQueued(writer.principal, 'http', f.workspaceId,
      { commandId: randomUUID(), ticketId: ticket.id, expectedRevision: ticket.revision }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 })
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id)).toEqual(currentTicket)
    async function cancelHistoryTicket(pending: JobQueueTicket) {
      return f.jobs.cancelQueued(writer.principal, 'http', f.workspaceId,
        { commandId: randomUUID(), ticketId: pending.id, expectedRevision: pending.revision })
    }
    const completedTickets = [await cancelHistoryTicket(currentTicket)]
    // Stop capacity scans while constructing pagination history through public commands.
    await f.jobs.closeQueue()
    for (let index = 1; index < 105; index += 8) {
      const batch = await Promise.all(Array.from({ length: Math.min(8, 105 - index) }, async () => {
        const admission = await f.jobs.enqueue(f.principal, 'http', f.workspaceId, queue.command(definition))
        if (admission.kind !== 'pending-admission') throw new Error('Offline history requests must remain queued')
        return cancelHistoryTicket(admission.ticket)
      }))
      completedTickets.push(...batch)
    }
    completedTickets.sort((a, b) => Number(BigInt(a.enqueueSequence) - BigInt(b.enqueueSequence)))
    const completed = completedTickets.map(item => item.id)
    const cancelledById = new Map(completedTickets.map(item => [item.id, item]))
    const jobs = f.createService()
    services.push(jobs)
    await jobs.wakeQueue()
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { jobs, commands: f.commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const client = new Client({ name: 'queue-history-tests', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${writer.token}` } } }))
    const foreign = await access.issue({ name: 'Foreign history reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['jobs:read'],
        scope: { workspaceIds: [randomUUID()] } }] })
    const deniedClient = new Client({ name: 'queue-history-denied', version: '1' })
    clients.push(deniedClient)
    await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${foreign.token}` } } }))
    const denied = await deniedClient.callTool({ name: 'job_queue_list', arguments: { workspaceId: f.workspaceId } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const deniedHttp = await app.inject({ method: 'GET',
      url: `/api/management/workspaces/${f.workspaceId}/jobs/queue`,
      headers: { authorization: `Bearer ${foreign.token}` } })
    expect(deniedHttp.statusCode).toBe(403)
    const defaultPage = await client.callTool({ name: 'job_queue_list', arguments: { workspaceId: f.workspaceId } })
    expect(defaultPage.isError).not.toBe(true)
    const defaultHistory = JobQueuePageSchema.parse(decodeMcpToolResult(defaultPage))
    expect(defaultHistory.tickets.filter(ticket => ticket.id !== active.id).map(ticket => ticket.id))
      .toEqual(completed.toReversed().slice(0, 100))
    expect(defaultHistory.nextHistoryCursor).not.toBeNull()
    const found: string[] = []
    let pageCount = 0
    let cursor: string | null = null
    do {
      const input = { workspaceId: f.workspaceId, historyLimit: 10,
        ...(cursor ? { historyBeforeSequence: cursor } : {}) }
      const response = await client.callTool({ name: 'job_queue_list', arguments: input })
      expect(response.isError).not.toBe(true)
      const page = JobQueuePageSchema.parse(decodeMcpToolResult(response))
      expect(page.tickets.find(ticket => ticket.id === active.id)).toMatchObject({ state: 'blocked' })
      const history = page.tickets.filter(ticket => ticket.id !== active.id)
      expect(history.length).toBeLessThanOrEqual(10)
      for (const ticket of history) {
        expect(ticket).toMatchObject({ state: 'terminal', terminalReason: 'cancelled' })
        expect(ticket).toEqual(cancelledById.get(ticket.id))
        if (cursor) expect(BigInt(ticket.enqueueSequence)).toBeLessThan(BigInt(cursor))
      }
      if (page.nextHistoryCursor) expect(page.nextHistoryCursor).toBe(history.at(-1)!.enqueueSequence)
      const query = new URLSearchParams({ historyLimit: '10' })
      if (cursor) query.set('historyBeforeSequence', cursor)
      const http = await app.inject({ method: 'GET',
        url: `/api/management/workspaces/${f.workspaceId}/jobs/queue?${query}`,
        headers: { authorization: `Bearer ${reader.token}` } })
      expect(http.statusCode).toBe(200)
      expect(http.json()).toEqual(page)
      found.push(...page.tickets.filter(ticket => ticket.id !== active.id).map(ticket => ticket.id))
      pageCount++
      cursor = page.nextHistoryCursor
    } while (cursor)
    expect(pageCount).toBe(11)
    expect(new Set(found).size).toBe(105)
    expect(found).toEqual(completed.toReversed())
    const current = await jobs.getQueueTicket(reader.principal, f.workspaceId, active.id)
    const cancelled = await client.callTool({ name: 'job_queue_cancel', arguments: {
      workspaceId: f.workspaceId, ticketId: current.id, expectedRevision: current.revision,
      commandId: randomUUID(),
    } })
    expect(cancelled.isError).not.toBe(true)
    expect(decodeMcpToolResult(cancelled)).toEqual({ ticket:
      await jobs.getQueueTicket(reader.principal, f.workspaceId, active.id) })
    expect((await jobs.getQueueTicket(reader.principal, f.workspaceId, active.id)).terminalReason).toBe('cancelled')
  }, 60000)
})
