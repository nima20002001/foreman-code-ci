import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { setupJobAdmissionQueue } from './helpers/jobAdmissionQueue.js'

describe.skipIf(!postgresEnabled)('durable build admission queue: placement', () => {
  const queue = setupJobAdmissionQueue()
  const { fixture, admissionTicketId, command, submit } = queue

  it('keeps an explicit disabled target blocked while another computer admits an Auto Job', async () => {
    const { writer, reader } = queue
    const f = await fixture({ computerCount: 2 })
    const fixed = await submit(f, await f.save(f.computers[0]!.candidate.spec))
    await f.jobs.wakeQueue()
    const current = await f.settings.read(writer.principal, { target: f.computers[0]!.target })
    await f.settings.update(writer.principal, 'http', { target: f.computers[0]!.target,
      commandId: randomUUID(), expectedRevision: current.preference.revision, buildEnabled: false, buildPriority: 100 })
    const automatic = await submit(f, await f.save())
    f.online(0)
    f.online(1)
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, fixed.id))
      .toMatchObject({ state: 'blocked', waitingReasons: ['disabled'], reservationId: null })
    expect((await f.jobs.getExecution(reader.principal, f.workspaceId, automatic.executionId)).acceptedSpec.target)
      .toEqual(f.computers[1]!.candidate.spec.target)
  })
  it.each(['fixed-to-explicit', 'fixed-to-auto', 'auto-to-explicit'] as const)(
    'places %s through the selector and retains the saved definition and idempotent request', async mode => {
      const { reader } = queue
      const f = await fixture({ computerCount: 2 })
      await f.settings.update(f.principal, 'http', { target: f.computers[0]!.target,
        commandId: randomUUID(), expectedRevision: 1, buildEnabled: true, buildPriority: 1 })
      const definition = await f.save(mode === 'auto-to-explicit' ? f.computers[0]!.auto : f.computers[0]!.candidate.spec)
      const placementOverride = mode === 'fixed-to-auto' ? { kind: 'auto' as const }
        : { kind: 'explicit' as const, target: f.computers[1]!.candidate.spec.target }
      const input = { ...command(definition), placementOverride }
      const result = await f.jobs.enqueue(f.principal, 'mcp', f.workspaceId, input)
      const id = admissionTicketId(result)
      await f.jobs.wakeQueue()
      f.online(0)
      f.online(1)
      await f.jobs.wakeQueue()
      const ticket = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, id)
      const execution = await f.jobs.getExecution(reader.principal, f.workspaceId, ticket.executionId)
      expect(ticket).toMatchObject({ state: 'accepted', definition, placement: placementOverride, placementOverride })
      expect(execution.acceptedSpec).toMatchObject({ target: f.computers[1]!.candidate.spec.target,
        definitionVersionId: definition.versionId, source: definition.spec.source,
        argv: definition.spec.argv, outputs: definition.spec.outputs,
        policy: { imageDigest: definition.spec.policy.imageDigest, network: definition.spec.policy.network } })
      expect(await f.jobs.getDefinition(f.principal, f.workspaceId, definition.id)).toEqual(definition)
      expect(await f.jobs.enqueue(f.principal, 'http', f.workspaceId, input))
        .toEqual({ kind: 'accepted', ticketId: ticket.id, executionId: ticket.executionId })
      await expect(f.jobs.enqueue(f.principal, 'mcp', f.workspaceId, { ...input,
        placementOverride: { kind: 'explicit', target: f.computers[0]!.candidate.spec.target } }))
        .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
      expect(f.accept).toHaveBeenCalledOnce()
    })
  it('keeps an override blocked when its computer does not satisfy the saved network policy', async () => {
    const { reader } = queue
    const f = await fixture({ computerCount: 2 })
    const definition = await f.save(f.computers[0]!.candidate.spec)
    f.computers[1]!.candidate.spec.policy.network = 'approved-dependency-fetch'
    f.online(0)
    f.online(1)
    const result = await f.jobs.enqueue(f.principal, 'mcp', f.workspaceId, { ...command(definition),
      placementOverride: { kind: 'explicit', target: f.computers[1]!.candidate.spec.target } })
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, admissionTicketId(result)))
      .toMatchObject({ state: 'blocked', reservationId: null, waitingReasons: ['incompatible'] })
    expect(f.accept).not.toHaveBeenCalled()
  })
})
