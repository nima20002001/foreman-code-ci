import { describe, expect, it } from 'vitest'
import { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { setupJobAdmissionQueue } from './helpers/jobAdmissionQueue.js'

describe.skipIf(!postgresEnabled)('durable build admission queue: scheduling', () => {
  const queue = setupJobAdmissionQueue()
  const { fixture, admissionTicketId, command, submit, ordered } = queue

  it('serializes five concurrent requests on one heavy slot and advances only after closure and publication', async () => {
    const { reader } = queue
    const f = await fixture()
    const definition = await f.save()
    await Promise.all(Array.from({ length: 5 }, () => submit(f, definition)))
    await f.jobs.wakeQueue()
    const original = await ordered(f)
    expect(original).toHaveLength(5)
    expect(f.accept).not.toHaveBeenCalled()
    f.online()
    for (let index = 0; index < original.length; index++) {
      await f.jobs.wakeQueue()
      const tickets = await ordered(f)
      expect(tickets.filter(ticket => ticket.state === 'accepted')).toHaveLength(1)
      expect(tickets.filter(ticket => ticket.terminalReason === 'completed')).toHaveLength(index)
      expect(tickets[index]!.executionId).toBe(original[index]!.executionId)
      expect(tickets.slice(index + 1).every(ticket => ticket.state === 'waiting')).toBe(true)
      const execution = await f.jobs.getExecution(reader.principal, f.workspaceId, tickets[index]!.executionId)
      expect(execution.operationId).toBe(original[index]!.operationId)
      expect(execution.attemptId).toBe(original[index]!.attemptId)
      if (index === 0) {
        await f.worker.settleProcess(f.workspaceId, execution.id, { attemptId: execution.attemptId, owner: execution.owner }, {
          process: { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true },
          startedAt: execution.createdAt, finishedAt: new Date().toISOString(),
        })
        await f.jobs.wakeQueue()
        expect(f.accept).toHaveBeenCalledTimes(1)
      }
      await f.complete(execution.id)
    }
    expect(f.accept).toHaveBeenCalledTimes(5)
    await f.jobs.wakeQueue()
    expect((await ordered(f)).every(ticket => ticket.state === 'terminal' && ticket.terminalReason === 'completed')).toBe(true)
    expect(new Set(f.accept.mock.calls.map(call => call[4].operationId)).size).toBe(5)
  })
  it('replays concurrent duplicate submissions as one ticket and rejects conflicting payloads', async () => {
    const { reader } = queue
    const f = await fixture()
    const definition = await f.save()
    const input = command(definition)
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      f.jobs.enqueue(f.principal, 'mcp', f.workspaceId, input)))
    expect(new Set(results.map(result => admissionTicketId(result))).size).toBe(1)
    await expect(f.jobs.enqueue(f.principal, 'http', f.workspaceId, { ...input, expectedRevision: 2 }))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    expect(await ordered(f)).toHaveLength(1)
    f.online()
    await f.jobs.wakeQueue()
    await f.jobs.enqueue(f.principal, 'mcp', f.workspaceId, input)
    expect(f.accept).toHaveBeenCalledTimes(1)
    expect(await f.jobs.listExecutions(reader.principal, f.workspaceId)).toHaveLength(1)
  })
  it('uses the existing dispatch wake path for waiting admission without contacting a worker', async () => {
    const { database, reader } = queue
    const f = await fixture()
    const ticket = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    const unavailable = async () => { throw new Error('Waiting admission must not contact the carrier') }
    const dispatch = new PostgresJobDispatch(database.pool,
      { deliver: unavailable, reconcile: unavailable, control: unavailable },
      { revalidate: async () => {}, authorizeControl: async () => {}, observe: async () => {},
        prepareWaiting: () => f.jobs.wakeQueue() })
    try {
      await dispatch.wake(ticket.executionId)
      expect(f.accept).not.toHaveBeenCalled()
      f.online()
      await dispatch.wake(ticket.executionId)
      expect(f.accept).toHaveBeenCalledTimes(1)
      expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id)).state).toBe('accepted')
    } finally { await dispatch.close() }
  })
  it('expires waiting from the original enqueue time and enforces pending limits', async () => {
    const { reader } = queue
    let now = new Date()
    const f = await fixture({ maxPendingPerPrincipal: 1, clock: () => now })
    const definition = await f.save()
    const ticket = await submit(f, definition)
    await f.jobs.wakeQueue()
    await expect(submit(f, definition)).rejects.toMatchObject({ code: 'JOB_QUEUE_LIMIT' })
    now = new Date(Date.parse(ticket.deadlineAt))
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id))
      .toMatchObject({ state: 'terminal', terminalReason: 'timed_out', deadlineAt: ticket.deadlineAt })
    expect(f.accept).not.toHaveBeenCalled()
    expect((await submit(f, definition)).id).not.toBe(ticket.id)
  })
})
