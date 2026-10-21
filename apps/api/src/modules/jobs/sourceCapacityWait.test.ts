import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { JobQueueTicketSchema } from '@foreman-code/contracts/job-admission'
import { ciFixture } from '../../../test/helpers/ciFixture.js'
import { ciPreparationMemory } from '../../../test/helpers/ciPreparationMemory.js'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { verificationFixture } from '../../../test/helpers/jobVerificationFixture.js'
import * as diagnostics from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'
import { JobOwnership } from './ownership.js'
import { JobQueuePreparation } from './preparation.js'

afterEach(() => vi.restoreAllMocks())

async function fixture(code = 'SOURCE_CAPACITY') {
  const ci = ciFixture()
  const definition = await ci.jobs.saveDefinition(ci.operator, 'mcp', ci.workspaceId, {
    commandId: 'save-capacity-test', expectedRevision: null,
    name: 'Source capacity', spec: verificationFixture().spec,
  })
  await ci.jobs.enqueue(ci.operator, 'mcp', ci.workspaceId, {
    commandId: 'capacity-test', definitionId: definition.id, expectedRevision: definition.revision,
  })
  let ticket = JobQueueTicketSchema.parse({ ...ci.ticket(), state: 'claimed', reservationId: ci.ticket().id,
    waitingReasons: [], deadlineAt: new Date(Date.parse(ci.ticket().enqueuedAt) + 600_000).toISOString(),
    definition: { ...ci.ticket().definition, spec: { ...ci.ticket().definition.spec,
      policy: { ...ci.ticket().definition.spec.policy, queueTimeoutMs: 600_000 } } } })
  let now = Date.parse(ticket.enqueuedAt)
  const createdAt = new Date(now)
  const query = async (text: string, values?: unknown[]) => {
    let rows: unknown[] = []
    let rowCount = 0
    if (text.startsWith('select record from job_admission_queue where workspace_id')) {
      rows = [{ record: structuredClone(ticket) }]
    } else if (text.startsWith('select record from job_admission_queue')) {
      if (ticket.state !== 'terminal' && ticket.state !== 'accepted') rows = [{ record: structuredClone(ticket) }]
    } else if (text.startsWith('update job_admission_queue set record=')) {
      ticket = JobQueueTicketSchema.parse(JSON.parse(String(values![2])))
      rowCount = 1
    } else if (text.startsWith('select id,name,audience')) {
      rows = [{ ...ci.operator, expires_at: new Date(ci.operator.expiresAt), revoked_at: null, delegated_from: null }]
    } else if (text.startsWith('select created_at')) rows = [{ created_at: createdAt }]
    else if (text.startsWith('select archived_at')) rows = [{ archived_at: null }]
    return { rows, rowCount }
  }
  const pool = { query } as unknown as pg.Pool
  const memory = ciPreparationMemory()
  vi.spyOn(JobOwnership, 'acquire').mockImplementation(memory.acquire)
  const info = vi.fn()
  const error = vi.fn()
  vi.spyOn(diagnostics, 'componentLogger').mockReturnValue({ info, error } as never)
  const prepare = vi.fn(async () => { throw new DomainError(code, 'Source storage is full', 409) })
  const execution = { ...jobExecution(), id: ticket.executionId, workspaceId: ticket.workspaceId,
    attemptId: ticket.attemptId, operationId: ticket.operationId }
  const admit = vi.fn(async () => execution)
  const wake = vi.fn(async () => {})
  const create = () => new JobQueuePreparation(pool, {
    configuration: { revision: 1,
      review: { reviewedByPrincipalId: ci.operator.id, reviewedAt: ticket.enqueuedAt, decisionDigest: 'a'.repeat(64) },
      limits: { maxPendingPerPrincipal: 10, maxPendingPerWorkspace: 20, maxBackfillClaims: 0 },
      resources: async () => ticket.resources },
    placement: { claim: async () => { throw new Error('Retained reservations must not be reclaimed') } } as never,
    prepare, admit, wake,
  }, () => new Date(now))
  return { queue: create(), create, ticket: () => structuredClone(ticket), prepare, admit, wake, info, error, memory,
    advance: (ms: number) => { now += ms },
    cancel: () => { ticket.cancelRequestedAt = new Date(now).toISOString() } }
}

it.each(['SOURCE_CAPACITY', 'SOURCE_DISK_CAPACITY', 'SOURCE_CAPACITY_UNAVAILABLE'])(
  'waits quietly with bounded backoff for %s', async code => {
  const f = await fixture(code)
  const identity = f.ticket()
  await f.queue.waitForWork(await f.queue.scan())
  expect(f.ticket()).toMatchObject({ state: 'waiting', waitingReasons: ['busy'], reservationId: identity.reservationId,
    executionId: identity.executionId, attemptId: identity.attemptId, operationId: identity.operationId,
    sourceCapacityWait: { attempts: 1, waitedMs: 0 } })
  for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
    expect(Date.parse(f.ticket().sourceCapacityWait!.retryAt) - Date.parse(f.ticket().sourceCapacityWait!.startedAt))
      .toBe(delay)
    f.advance(delay - 1)
    const calls = f.prepare.mock.calls.length
    await f.queue.waitForWork(await f.queue.scan())
    expect(f.prepare).toHaveBeenCalledTimes(calls)
    f.advance(1)
    await f.queue.waitForWork(await f.queue.scan())
    expect(f.prepare).toHaveBeenCalledTimes(calls + 1)
  }
  expect(f.info.mock.calls.filter(([, message]) => message === 'Queued Job waiting for source capacity')).toHaveLength(1)
  expect(f.error).not.toHaveBeenCalled()
  expect(f.memory.owners.size).toBe(0)
})

it('retains retry timing across recovery and resumes the original attempt when capacity is available', async () => {
  const f = await fixture()
  await f.queue.waitForWork(await f.queue.scan())
  const recovered = f.create()
  await recovered.waitForWork(await recovered.scan())
  expect(f.prepare).toHaveBeenCalledTimes(1)
  // Waiting longer than the preparation budget still permits source I/O once capacity returns.
  f.advance(f.ticket().definition.spec.policy.preparationTimeoutMs + 1)
  f.prepare.mockResolvedValueOnce({} as never)
  await recovered.waitForWork(await recovered.scan())
  expect(f.ticket().state).toBe('accepted')
  expect(f.ticket().sourceCapacityWait).toBeUndefined()
  expect(f.admit).toHaveBeenCalledTimes(1)
  expect(f.wake).toHaveBeenCalledTimes(1)
})

it.each(['cancelled', 'timed_out'] as const)('handles %s while a retry is deferred', async reason => {
  const f = await fixture()
  await f.queue.waitForWork(await f.queue.scan())
  if (reason === 'cancelled') f.cancel()
  else f.advance(Date.parse(f.ticket().deadlineAt) - Date.parse(f.ticket().enqueuedAt))
  await f.queue.waitForWork(await f.queue.scan())
  expect(f.ticket()).toMatchObject({ state: 'terminal', terminalReason: reason })
  expect(f.ticket().sourceCapacityWait).toBeUndefined()
  expect(f.prepare).toHaveBeenCalledTimes(1)
})

it('keeps unexpected preparation failures visible to callers', async () => {
  const f = await fixture('SOURCE_CORRUPT')
  await expect(f.queue.waitForWork(await f.queue.scan())).rejects.toMatchObject({ code: 'SOURCE_CORRUPT' })
  expect(f.error).toHaveBeenCalled()
  expect(f.ticket().sourceCapacityWait).toBeUndefined()
})

it('still enforces the source preparation budget after capacity waiting', async () => {
  const f = await fixture()
  await f.queue.waitForWork(await f.queue.scan())
  f.advance(5_000)
  f.prepare.mockImplementationOnce(async () => {
    f.advance(f.ticket().definition.spec.policy.preparationTimeoutMs + 1)
    return {} as never
  })
  await expect(f.queue.waitForWork(await f.queue.scan())).rejects.toMatchObject({ code: 'JOB_PREPARATION_TIMEOUT' })
  expect(f.ticket()).toMatchObject({ state: 'terminal', terminalReason: 'timed_out' })
  expect(f.admit).not.toHaveBeenCalled()
})

it('reports an unexpected failure on retry and clears the capacity waiting label', async () => {
  const f = await fixture()
  await f.queue.waitForWork(await f.queue.scan())
  f.advance(5_000)
  f.prepare.mockRejectedValueOnce(new DomainError('SOURCE_CORRUPT', 'Source contents changed', 409))
  await expect(f.queue.waitForWork(await f.queue.scan())).rejects.toMatchObject({ code: 'SOURCE_CORRUPT' })
  expect(f.ticket().state).toBe('claimed')
  expect(f.ticket().sourceCapacityWait).toBeUndefined()
  expect(f.error).toHaveBeenCalled()
  expect(f.memory.owners.size).toBe(0)
})
