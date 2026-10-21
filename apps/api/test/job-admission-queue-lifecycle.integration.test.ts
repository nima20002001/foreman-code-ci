import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { jobComputerHasCapacity } from '../src/modules/jobs/computerSelection.js'
import { jobExecution } from './helpers/jobFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { setupJobAdmissionQueue } from './helpers/jobAdmissionQueue.js'

describe.skipIf(!postgresEnabled)('durable build admission queue: lifecycle', () => {
  const queue = setupJobAdmissionQueue()
  const { services, fixture, submit, ordered } = queue

  it('requires stopped process and settled publication before completing the original queue ticket', async () => {
    const { database } = queue
    const f = await fixture()
    f.online()
    const ticket = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    const accepted = await f.jobs.getQueueTicket(f.principal, f.workspaceId, ticket.id)
    const execution = await f.jobs.getExecution(f.principal, f.workspaceId, accepted.executionId)
    const finishedAt = new Date().toISOString()
    const finish = async () => {
      const sql = await database.pool.connect()
      try {
        await sql.query('begin')
        const current = await f.jobs.repository.queueTicket(sql, f.workspaceId, accepted.id, true)
        await f.jobs.repository.finishQueueTicket(sql, current, 'completed', finishedAt)
        await sql.query('commit')
      } finally {
        await sql.query('rollback')
        sql.release()
      }
    }
    await expect(finish()).rejects.toMatchObject({ message: 'JOB_QUEUE_COMPLETION_UNCONFIRMED' })
    const fence = { attemptId: execution.attemptId, owner: execution.owner }
    await f.worker.settleProcess(f.workspaceId, execution.id, fence, {
      process: { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true },
      startedAt: execution.createdAt, finishedAt,
    })
    await expect(finish()).rejects.toMatchObject({ message: 'JOB_QUEUE_COMPLETION_UNCONFIRMED' })
    await f.worker.publication(f.workspaceId, execution.id, fence, { state: 'complete', issue: null })
    await f.jobs.wakeQueue()
    const completed = await f.jobs.getQueueTicket(f.principal, f.workspaceId, accepted.id)
    expect(completed).toMatchObject({ state: 'terminal', terminalReason: 'completed', finishedAt,
      cleanupStatus: 'pending', executionId: execution.id, definition: accepted.definition })
    await f.complete(execution.id)
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(f.principal, f.workspaceId, accepted.id))
      .toMatchObject({ revision: completed.revision, state: 'terminal', cleanupStatus: 'complete' })
    expect((await f.jobs.getExecution(f.principal, f.workspaceId, execution.id)).acceptedSpec)
      .toEqual(execution.acceptedSpec)
  })
  it('preserves queued order, identity, saved versions and deadlines after service restart', async () => {
    const { writer, reader } = queue
    const f = await fixture()
    const definition = await f.save()
    await Promise.all(Array.from({ length: 3 }, () => submit(f, definition)))
    await f.jobs.closeQueue()
    const before = await ordered(f)
    await f.jobs.saveDefinition(writer.principal, 'http', f.workspaceId, { commandId: randomUUID(),
      id: definition.id, expectedRevision: definition.revision, name: 'Edited build', spec: definition.spec })
    const restarted = f.createService()
    services.push(restarted)
    expect((await ordered(f, restarted)).map(ticket => [ticket.id, ticket.executionId, ticket.attemptId,
      ticket.operationId, ticket.enqueueSequence, ticket.deadlineAt, ticket.definition.versionId]))
      .toEqual(before.map(ticket => [ticket.id, ticket.executionId, ticket.attemptId, ticket.operationId,
        ticket.enqueueSequence, ticket.deadlineAt, ticket.definition.versionId]))
    f.online()
    await restarted.wakeQueue()
    const first = await restarted.getExecution(reader.principal, f.workspaceId, before[0]!.executionId)
    expect(first.acceptedSpec.definitionVersionId).toBe(definition.versionId)
    expect((await ordered(f, restarted)).slice(1).every(ticket => ticket.state === 'waiting')).toBe(true)
  })
  it('never frees an accepted but uncertain execution on service restart or elapsed queue deadline', async () => {
    const { reader } = queue
    let now = new Date()
    const f = await fixture({ clock: () => now })
    const definition = await f.save()
    const first = await submit(f, definition)
    const second = await submit(f, definition)
    f.online()
    await f.jobs.wakeQueue()
    await f.jobs.closeQueue()
    now = new Date(Date.parse(second.deadlineAt) - 1)
    const restarted = f.createService()
    services.push(restarted)
    await restarted.wakeQueue()
    expect((await restarted.getQueueTicket(reader.principal, f.workspaceId, second.id)).state).toBe('waiting')
    expect((await restarted.getExecution(reader.principal, f.workspaceId, first.executionId)).transport).toBe('unknown')
    expect(f.accept).toHaveBeenCalledTimes(1)
  })
  it('counts a historical execution until publication and source cleanup finish without a selection record', async () => {
    const { database } = queue
    const f = await fixture()
    const computer = f.computers[0]!
    const definition = await f.save(computer.candidate.spec)
    const identity = { executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID() }
    const prepared = await f.accept(database.pool, f.principal, f.workspaceId, computer.candidate.spec, identity)
    const execution = { ...jobExecution(), id: identity.executionId, workspaceId: f.workspaceId,
      attemptId: identity.attemptId, operationId: identity.operationId,
      acceptedSpec: { ...jobExecution().acceptedSpec, ...prepared,
        definitionId: definition.id, definitionVersionId: definition.versionId } }
    await database.pool.query(`insert into job_executions
      (id,workspace_id,definition_version_id,operation_id,attempt_id,record,accepted_spec,accepted_by)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`, [execution.id, f.workspaceId,
      definition.versionId, execution.operationId, execution.attemptId, JSON.stringify(execution),
      JSON.stringify(execution.acceptedSpec), f.principal.id])
    const capacity = () => jobComputerHasCapacity(database.pool, computer.candidate.spec.target, computer.candidate.profile)
    expect(await capacity()).toBe(false)
    const fence = { attemptId: execution.attemptId, owner: execution.owner }
    await f.worker.settleProcess(f.workspaceId, execution.id, fence, {
      process: { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true },
      startedAt: execution.createdAt, finishedAt: new Date().toISOString(),
    })
    expect(await capacity()).toBe(false)
    await f.worker.publication(f.workspaceId, execution.id, fence, { state: 'complete', issue: null })
    expect(await capacity()).toBe(false)
    await f.complete(execution.id)
    expect(await capacity()).toBe(true)
    expect((await database.pool.query('select 1 from job_computer_selections where execution_id=$1',
      [execution.id])).rowCount).toBe(0)
  })
})
