import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { JobOwnership } from '../src/modules/jobs/ownership.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { setupJobAdmissionQueue } from './helpers/jobAdmissionQueue.js'

describe.skipIf(!postgresEnabled)('durable build admission queue: preparation', () => {
  const queue = setupJobAdmissionQueue()
  const { services, fixture, submit } = queue

  it('cancels an unclaimed ticket without source preparation or worker contact', async () => {
    const { writer, reader } = queue
    const f = await fixture()
    const ticket = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    const current = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id)
    const input = { commandId: randomUUID(), ticketId: ticket.id, expectedRevision: current.revision }
    const cancelled = await f.jobs.cancelQueued(writer.principal, 'mcp', f.workspaceId, input)
    expect(cancelled).toMatchObject({ state: 'terminal', terminalReason: 'cancelled', reservationId: null })
    expect(await f.jobs.cancelQueued(writer.principal, 'http', f.workspaceId, input)).toEqual(cancelled)
    f.online()
    await f.jobs.wakeQueue()
    expect(f.accept).not.toHaveBeenCalled()
    expect(f.cancel).not.toHaveBeenCalled()
    expect(f.wake).not.toHaveBeenCalled()
  })
  it('fences multi-owner claim/cancel races so one attempt is admitted at most once', async () => {
    const { writer, reader } = queue
    const f = await fixture()
    const ticket = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    const current = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id)
    const second = f.createService()
    services.push(second)
    f.online()
    const results = await Promise.allSettled([f.jobs.wakeQueue(), second.wakeQueue(),
      f.jobs.cancelQueued(writer.principal, 'mcp', f.workspaceId,
        { commandId: randomUUID(), ticketId: ticket.id, expectedRevision: current.revision })])
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'REVISION_CONFLICT' })
    }
    await second.wakeQueue()
    const persisted = await second.getQueueTicket(reader.principal, f.workspaceId, ticket.id)
    expect(f.accept.mock.calls.length).toBeLessThanOrEqual(1)
    expect((await second.listExecutions(reader.principal, f.workspaceId)).length).toBeLessThanOrEqual(1)
    expect(persisted.executionId).toBe(ticket.executionId)
    if (persisted.state === 'terminal') expect(persisted.terminalReason).toBe('cancelled')
    else expect(persisted.state).toBe('accepted')
  })
  it('retains one preparation owner during cancellation and never accepts a cancelled claimed attempt', async () => {
    const { database, writer, reader } = queue
    const f = await fixture()
    const ticket = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    const prepare = f.accept.getMockImplementation()!
    let resume!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { resume = resolve })
    const preparing = new Promise<void>(resolve => { entered = resolve })
    f.accept.mockImplementationOnce(async (...args) => {
      entered()
      await waiting
      return prepare(...args)
    })
    f.online()
    const pending = f.jobs.wakeQueue()
    await preparing
    try {
      const otherOwner = await JobOwnership.acquire(database.pool, ticket.executionId, () => {})
      expect(otherOwner).toBeUndefined()
      await otherOwner?.release()
      const second = f.createService()
      services.push(second)
      await second.wakeQueue()
      const claimed = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id)
      expect(claimed.state).toBe('claimed')
      await f.jobs.cancelQueued(writer.principal, 'mcp', f.workspaceId,
        { commandId: randomUUID(), ticketId: ticket.id, expectedRevision: claimed.revision })
    } finally {
      resume()
      await pending
    }
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id))
      .toMatchObject({ state: 'terminal', terminalReason: 'cancelled' })
    expect(await f.jobs.listExecutions(reader.principal, f.workspaceId)).toHaveLength(0)
    expect(f.accept).toHaveBeenCalledTimes(1)
    expect(f.wake).not.toHaveBeenCalled()
  })
  it('recovers interrupted preparation on the original reservation without rerouting', async () => {
    const { reader } = queue
    const f = await fixture({ computerCount: 2 })
    const ticket = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    f.online(0)
    f.accept.mockRejectedValueOnce(new DomainError('SOURCE_TRANSFER_PENDING', 'Transfer interrupted', 503))
    await expect(f.jobs.wakeQueue()).rejects.toMatchObject({ code: 'SOURCE_TRANSFER_PENDING' })
    await f.jobs.closeQueue()
    const original = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id)
    expect(original.state).toBe('claimed')
    f.online(1)
    const restarted = f.createService()
    services.push(restarted)
    await restarted.wakeQueue()
    const execution = await restarted.getExecution(reader.principal, f.workspaceId, ticket.executionId)
    expect(execution).toMatchObject({ id: ticket.executionId, attemptId: ticket.attemptId, operationId: ticket.operationId })
    expect(execution.acceptedSpec.target).toEqual(f.computers[0]!.candidate.spec.target)
    expect(new Set(f.accept.mock.calls.map(call => call[4].operationId)).size).toBe(1)
  })
  it('admits another computer while preparation is pending and waits for that preparation on shutdown', async () => {
    const { reader } = queue
    const f = await fixture({ computerCount: 2 })
    const first = await submit(f, await f.save(f.computers[0]!.candidate.spec))
    await f.jobs.wakeQueue()
    const prepare = f.accept.getMockImplementation()!
    let resume!: () => void
    let entered!: () => void
    const paused = new Promise<void>(resolve => { resume = resolve })
    const preparing = new Promise<void>(resolve => { entered = resolve })
    f.accept.mockImplementationOnce(async (...args) => {
      entered()
      await paused
      return prepare(...args)
    })
    f.online(0)
    f.online(1)
    const pending = f.jobs.wakeQueue()
    await preparing
    let closed = false
    let closing: Promise<void> | undefined
    try {
      const second = await submit(f, await f.save(f.computers[1]!.candidate.spec))
      await vi.waitFor(async () => {
        expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, second.id)).state).toBe('accepted')
      })
      expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, first.id)).state).toBe('claimed')
      expect(f.accept).toHaveBeenCalledTimes(2)
      closing = f.jobs.closeQueue().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
    } finally {
      resume()
      await pending
      await closing
    }
    expect(closed).toBe(true)
    expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, first.id)).state).toBe('accepted')
  })
})
