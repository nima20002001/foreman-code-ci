import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SOURCE_AGGREGATE_LIMITS, PostgresSourceReservations } from '../src/modules/sources/reservations.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { setupJobAdmissionQueue } from './helpers/jobAdmissionQueue.js'

describe.skipIf(!postgresEnabled)('durable build admission queue: policy', () => {
  const queue = setupJobAdmissionQueue()
  const { services, fixture, admissionTicketId, command, submit } = queue

  it('terminates admission after principal revocation rather than reporting busy', async () => {
    const { database, access, writer, reader } = queue
    const authority = await access.issue({ name: 'Revocable queue writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: writer.principal.grants })
    const f = await buildQueueFixture(database.pool, authority.principal)
    services.push(f.jobs)
    const definition = await f.save()
    const result = await f.jobs.enqueue(authority.principal, 'http', f.workspaceId, command(definition))
    const id = admissionTicketId(result)
    await f.jobs.wakeQueue()
    await access.revoke(authority.principal.id)
    f.online()
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, id))
      .toMatchObject({ state: 'terminal', terminalReason: 'authorization_revoked' })
    expect(f.accept).not.toHaveBeenCalled()
  })
  it('terminates a request that exceeds empty storage capacity and reports expired qualification as blocked', async () => {
    const { reader } = queue
    const f = await fixture()
    const first = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    f.computers[0]!.candidate.sourceReservation.reservedBytes = SOURCE_AGGREGATE_LIMITS.bytes + 1
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, first.id))
      .toMatchObject({ state: 'terminal', terminalReason: 'request_exceeds_maximum' })
    f.computers[0]!.candidate.sourceReservation.reservedBytes = 2097152
    f.computers[0]!.candidate.reasons = ['qualification_expired']
    const second = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, second.id))
      .toMatchObject({ state: 'blocked', waitingReasons: ['qualification_expired'] })
    expect(f.accept).not.toHaveBeenCalled()
  })
  it('keeps Auto waiting for an authorized computer when another matching profile is revoked', async () => {
    const { reader } = queue
    const f = await fixture({ computerCount: 2 })
    f.computers[0]!.candidate.reasons = ['authorization_revoked']
    const ticket = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id))
      .toMatchObject({ state: 'waiting', waitingReasons: ['offline'] })
    f.online(1)
    await f.jobs.wakeQueue()
    const execution = await f.jobs.getExecution(reader.principal, f.workspaceId, ticket.executionId)
    expect(execution.acceptedSpec.target).toEqual(f.computers[1]!.candidate.spec.target)
    expect(f.accept).toHaveBeenCalledOnce()
  })
  it('bounds backfill of an older storage-constrained Job while allowing unrelated computers', async () => {
    const { database, reader } = queue
    const f = await fixture({ maxBackfillClaims: 1 })
    const oldSpec = { ...f.computers[0]!.auto, argv: ['node', 'large-build.mjs'] }
    const older = await submit(f, await f.save(oldSpec))
    const smaller = await f.save()
    const firstSmall = await submit(f, smaller)
    const secondSmall = await submit(f, smaller)
    await f.jobs.wakeQueue()
    const reservations = new PostgresSourceReservations(async () => sourceStorageCapacityFixture({
      totalBytes: 256 * 2 ** 30, availableBytes: 256 * 2 ** 30,
    }))
    const retained = await reservations.reserve(database.pool, { ownerKind: 'capture', ownerId: randomUUID(),
      scopeId: f.computers[0]!.candidate.sourceReservation.scopeId, reservedBytes: SOURCE_AGGREGATE_LIMITS.bytes / 2 })
    await reservations.retain(database.pool, retained, 'retained')
    f.inventory.candidates.mockImplementation(async (_sql, _principal, _workspace, spec) => ({ candidates: [{
      ...f.computers[0]!.candidate, spec: { ...f.computers[0]!.candidate.spec, argv: spec.argv },
      sourceReservation: { ...f.computers[0]!.candidate.sourceReservation,
        reservedBytes: spec.argv[1] === 'large-build.mjs' ? SOURCE_AGGREGATE_LIMITS.bytes * 0.75 : 2097152 },
    }], diagnosticCodes: [] }))
    f.online()
    await f.jobs.wakeQueue()
    expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, firstSmall.id)).state).toBe('accepted')
    await f.complete(firstSmall.executionId)
    await f.jobs.wakeQueue()
    expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, secondSmall.id)).state).toBe('waiting')
    expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, older.id)).state).toBe('waiting')
    await reservations.reclaimed(database.pool, retained, async () => true)
    await f.jobs.wakeQueue()
    expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, older.id)).state).toBe('accepted')
  })
})
