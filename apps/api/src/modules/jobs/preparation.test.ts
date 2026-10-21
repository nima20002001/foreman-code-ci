import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { JobQueueTicketSchema } from '@foreman-code/contracts/job-admission'
import { JobExecutionRecordSchema } from '@foreman-code/contracts/job-verification'
import { ciFixture } from '../../../test/helpers/ciFixture.js'
import { ciPreparationMemory } from '../../../test/helpers/ciPreparationMemory.js'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { verificationFixture } from '../../../test/helpers/jobVerificationFixture.js'
import { JobOwnership } from './ownership.js'
import { JobQueuePreparation } from './preparation.js'

afterEach(() => vi.restoreAllMocks())

async function fixture(publication: 'complete' | 'failed' | 'expired' | 'collecting' = 'complete', stopped = true) {
  const ci = ciFixture()
  const definition = await ci.jobs.saveDefinition(ci.operator, 'mcp', ci.workspaceId, {
    commandId: 'save-queue-completion', expectedRevision: null,
    name: 'Queue completion', spec: verificationFixture().spec,
  })
  await ci.jobs.enqueue(ci.operator, 'mcp', ci.workspaceId, {
    commandId: 'queue-completion', definitionId: definition.id, expectedRevision: definition.revision,
  })
  let ticket = JobQueueTicketSchema.parse({ ...ci.ticket(), state: 'accepted', reservationId: ci.ticket().id,
    waitingReasons: [], revision: 2 })
  const execution = JobExecutionRecordSchema.parse({ ...jobExecution(), id: ticket.executionId,
    workspaceId: ticket.workspaceId, operationId: ticket.operationId, attemptId: ticket.attemptId,
    publication, process: { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: stopped },
    finishedAt: new Date().toISOString() })
  const query = async (text: string, values?: unknown[]) => {
    let rows: unknown[] = []
    let rowCount = 0
    if (text.startsWith('with completed as')) {
      const closed = execution.process.phase === 'terminal' && execution.process.processStopped
        && !['pending', 'collecting'].includes(execution.publication) && execution.finishedAt
      if (ticket.state === 'accepted' && closed) {
        ticket = JobQueueTicketSchema.parse({ ...ticket, state: 'terminal', terminalReason: 'completed',
          finishedAt: execution.finishedAt, waitingReasons: [], queuePosition: null, estimatedStartAt: null,
          revision: ticket.revision + 1 })
        rowCount = 1
      }
    } else if (text.startsWith('select e.record')) {
      if (publication === 'collecting' || !stopped) rows = [{ record: execution }]
    } else if (text.startsWith('select record from job_admission_queue where workspace_id')) {
      rows = [{ record: structuredClone(ticket) }]
    } else if (text.startsWith('update job_admission_queue set record=')) {
      ticket = JobQueueTicketSchema.parse(JSON.parse(String(values![2])))
      rowCount = 1
    }
    return { rows, rowCount }
  }
  const pool = { query } as unknown as pg.Pool
  const memory = ciPreparationMemory()
  vi.spyOn(JobOwnership, 'acquire').mockImplementation(memory.acquire)
  const wake = vi.fn(async () => {})
  const unexpected = async (): Promise<never> => { throw new Error('Completed tickets cannot prepare or admit again') }
  const queue = new JobQueuePreparation(pool, {
    configuration: { revision: 1,
      review: { reviewedByPrincipalId: ci.operator.id, reviewedAt: ticket.enqueuedAt, decisionDigest: 'a'.repeat(64) },
      limits: { maxPendingPerPrincipal: 10, maxPendingPerWorkspace: 20, maxBackfillClaims: 0 },
      resources: async () => ticket.resources },
    placement: { claim: unexpected } as never,
    prepare: unexpected, admit: unexpected, wake,
  }, () => new Date())
  return { queue, ticket: () => structuredClone(ticket), execution, wake, memory }
}

it.each(['complete', 'failed', 'expired'] as const)(
  'persists terminal queue history after stopped execution and %s publication', async publication => {
    const f = await fixture(publication)
    const original = f.ticket()
    await f.queue.waitForWork(await f.queue.scan())
    expect(f.ticket()).toMatchObject({ state: 'terminal', terminalReason: 'completed',
      executionId: original.executionId, reservationId: original.reservationId, finishedAt: f.execution.finishedAt,
      definition: original.definition, revision: original.revision + 1 })
    await f.queue.waitForWork(await f.queue.scan())
    expect(f.ticket().revision).toBe(original.revision + 1)
    expect(f.memory.owners.size).toBe(0)
  })

it('keeps the ticket accepted while publication or physical process closure is pending', async () => {
  for (const [publication, stopped] of [['collecting', true], ['complete', false]] as const) {
    const f = await fixture(publication, stopped)
    await f.queue.waitForWork(await f.queue.scan())
    expect(f.ticket().state).toBe('accepted')
    expect(f.wake).toHaveBeenCalledWith(f.execution)
  }
})
