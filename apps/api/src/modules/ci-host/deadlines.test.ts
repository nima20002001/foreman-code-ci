import { CiRunRecordSchema, type CiHostReply, type CiHostRequest, type CiRunRecord } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { DomainError } from '../errors.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { expireCiRun, expireOverdueCiRuns } from './deadlines.js'
import { HostCiService, type CiCommits, type HostCiComputer } from './service.js'
import { ticketStore } from './ciTicketStore.testSupport.js'

const computer: HostCiComputer = { key: 'main:builder', hostRef: { kind: 'main', mainId: 'main' }, label: 'Builder', priority: 0 }
const now = new Date()
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()
const hours = 60 * 60_000
const id = { queuedRetry: uuid(1), queuedFresh: uuid(2), collecting: uuid(3), stuck: uuid(4), next: uuid(5) }
function uuid(n: number) { return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` }

function ticket(id: string, fields: Partial<CiRunRecord>): CiRunRecord {
  return CiRunRecordSchema.parse({ id, workspaceId: 'workspace', groupId: id, suite: 'lint', part: null, scope: 'full',
    files: [], partition: null, repository: 'owner/repo', commit: 'a'.repeat(40), state: 'queued', computer: null,
    step: null, exitCode: null, message: null, queuedAt: now.toISOString(), startedAt: null, finishedAt: null,
    initiator: { principalId: 'worker', executionId: null }, ...fields })
}

it('fails each overdue phase from its saved entry time with the cause, and leaves fresh tickets alone', async () => {
  const blocked = 'No ready computer for lint; Builder: all CI slots in use (1/1)'
  const store = ticketStore([
    // A ticket returned to the queue by start retries keeps its original queue time and so its deadline.
    ticket(id.queuedRetry, { queuedAt: ago(7 * hours), dispatchAttempts: 2, message: blocked }),
    ticket(id.queuedFresh, { queuedAt: ago(hours) }),
    ticket(id.collecting, { state: 'passed', queuedAt: ago(2 * hours), startedAt: ago(2 * hours), finishedAt: ago(hours),
      exitCode: 0, collection: 'pending', computer: { hostRef: computer.hostRef, label: computer.label } }),
  ])

  expect(await expireOverdueCiRuns(store.pool, now)).toBe(2)

  expect(store.read(id.queuedRetry).record).toMatchObject({ state: 'failed', deadlineExceeded: {
    code: 'CI_QUEUE_DEADLINE_EXCEEDED', phase: 'queued', enteredAt: ago(7 * hours), deadlineAt: ago(hours),
    cause: blocked, executor: 'none' } })
  expect(store.read(id.queuedRetry).record.message).toMatch(/^CI_QUEUE_DEADLINE_EXCEEDED: the queued phase lasted 420 min/u)
  expect(store.read(id.queuedFresh).record).toMatchObject({ state: 'queued' })
  expect(store.read(id.queuedFresh).record.deadlineExceeded).toBeUndefined()
  expect(store.read(id.collecting).record).toMatchObject({ state: 'passed', collection: 'failed',
    observation: { status: 'available' }, deadlineExceeded: { code: 'CI_COLLECTION_DEADLINE_EXCEEDED', phase: 'collection' } })
  expect(await expireOverdueCiRuns(store.pool, now)).toBe(0)
})

it('keeps an overdue running ticket\'s slot until its computer confirms the run stopped', async () => {
  const store = ticketStore([
    ticket(id.stuck, { state: 'running', step: 'lint', queuedAt: ago(5 * hours), startedAt: ago(4 * hours),
      computer: { hostRef: computer.hostRef, label: computer.label } }),
    ticket(id.next, {}),
  ], { [id.stuck]: computer.key })
  await expireOverdueCiRuns(store.pool, now, async run => run)
  expect(store.read(id.stuck)).toMatchObject({ state: 'failed', hostKey: computer.key, record: {
    deadlineExceeded: { code: 'CI_RUN_DEADLINE_EXCEEDED', phase: 'running', executor: 'retained' } } })
  expect(store.read(id.stuck).record.message).toContain('Executor cleanup is unconfirmed')

  let stopped = false
  const cancels: string[] = []
  const endpoint = {
    computers: async () => [computer],
    request: async (_computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply> => {
      if (request.operation === 'status') {
        return { operation: 'status', ready: true, reasons: [], cpuCount: 4, memoryBytes: 2 ** 33,
          slotsUsed: 0, slotsTotal: 1, runs: [] }
      }
      if (request.operation !== 'cancel') throw new Error(`Unexpected ${request.operation}`)
      cancels.push(request.runId)
      return { operation: 'cancel', run: { runId: request.runId, state: stopped ? 'canceled' : 'running', step: null,
        exitCode: null, startedAt: ago(4 * hours), finishedAt: stopped ? now.toISOString() : null, logBytes: 0, message: null } }
    },
  }
  const authority: CiAuthority = { resolve: async principal => ({ principal, workspaceId: 'workspace' }) }
  const service = new HostCiService(store.pool, new PostgresCommandCoordinator(store.pool), authority, {} as CiCommits, endpoint)

  // The computer reports the run still active: the slot stays reserved and new work waits for it.
  await service.dispatch()
  expect(cancels).toEqual([id.stuck])
  expect(store.read(id.stuck)).toMatchObject({ hostKey: computer.key, record: { deadlineExceeded: { executor: 'retained' },
    observation: { status: 'unavailable' } } })
  expect(store.read(id.stuck).record.message).toContain('CI_RUN_DEADLINE_EXCEEDED')
  expect(store.read(id.next).record).toMatchObject({ state: 'queued' })
  expect(store.read(id.next).record.message).toContain('all CI slots in use (1/1)')

  // After the observation backoff, a confirmed stop releases the slot and the queued ticket starts there.
  await new Promise(resolve => setTimeout(resolve, 1100))
  stopped = true
  await service.dispatch()
  expect(store.read(id.stuck)).toMatchObject({ state: 'failed', hostKey: null, record: {
    deadlineExceeded: { executor: 'released' }, observation: { status: 'available' } } })
  expect(store.read(id.next)).toMatchObject({ state: 'starting', hostKey: computer.key })
  await service.close()
})

it('reconciles a completed executor result before expiring a stale assigned ticket', async () => {
  const run = ticket(uuid(6), { state: 'running', queuedAt: ago(5 * hours), startedAt: ago(4 * hours),
    computer: { hostRef: computer.hostRef, label: computer.label } })
  const store = ticketStore([run], { [run.id]: computer.key })
  const finishedAt = ago(3 * hours)
  const requests: string[] = []
  const endpoint = { computers: async () => [computer],
    request: async (_computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply> => {
      requests.push(request.operation)
      if (request.operation === 'status') {
        return { operation: 'status', ready: true, reasons: [], cpuCount: 4, memoryBytes: 2 ** 33,
          slotsUsed: 0, slotsTotal: 1, runs: [] }
      }
      if (request.operation !== 'read') throw new Error(`Unexpected ${request.operation}`)
      return { operation: 'read', run: { runId: run.id, state: 'passed', step: null, exitCode: 0,
        startedAt: run.startedAt!, finishedAt, logBytes: 0, message: null }, text: '', nextOffset: 0 }
    } }
  const authority: CiAuthority = { resolve: async principal => ({ principal, workspaceId: 'workspace' }) }
  const service = new HostCiService(store.pool, new PostgresCommandCoordinator(store.pool), authority, {} as CiCommits, endpoint)
  try {
    await expireOverdueCiRuns(store.pool, now, async observed => {
      await service.dispatch()
      return store.read(observed.id).record
    })
    expect(store.read(run.id)).toMatchObject({ state: 'passed', hostKey: null,
      record: { state: 'passed', exitCode: 0, finishedAt } })
    expect(store.read(run.id).record.deadlineExceeded).toBeUndefined()
    expect([...requests].sort()).toEqual(['read', 'status'])
  } finally {
    await service.close()
  }
})

it('keeps the starting phase deadline after repeated acknowledgements with a started timestamp', async () => {
  const dispatchedAt = ago(31 * 60_000)
  const run = ticket(uuid(7), { state: 'starting', queuedAt: ago(2 * hours), dispatchedAt, startedAt: dispatchedAt,
    computer: { hostRef: computer.hostRef, label: computer.label } })
  const store = ticketStore([run], { [run.id]: computer.key })
  const endpoint = { computers: async () => [computer],
    request: async (_computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply> => {
      if (request.operation !== 'read') throw new Error(`Unexpected ${request.operation}`)
      return { operation: 'read', run: { runId: run.id, state: 'starting', step: 'publishing', exitCode: null,
        startedAt: run.startedAt!, finishedAt: null, logBytes: 0, message: null }, text: '', nextOffset: 0 }
    } }
  const authority: CiAuthority = { resolve: async principal => ({ principal, workspaceId: 'workspace' }) }
  const service = new HostCiService(store.pool, new PostgresCommandCoordinator(store.pool), authority, {} as CiCommits, endpoint)
  try {
    await service.dispatch()
    await service.dispatch()
    const observed = store.read(run.id).record
    expect(expireCiRun(observed, now)).toMatchObject({ state: 'failed', deadlineExceeded: {
      code: 'CI_START_DEADLINE_EXCEEDED', phase: 'starting', enteredAt: dispatchedAt,
      deadlineAt: new Date(Date.parse(dispatchedAt) + 30 * 60_000).toISOString() } })
    expect(observed.dispatchedAt).toBe(dispatchedAt)
  } finally {
    await service.close()
  }
})

it.each(['stopped', 'unknown'] as const)(
  'clears pending executor cleanup when a deadline-retained executor is confirmed %s', async confirmation => {
    const executor: HostCiComputer = { key: 'fixture-main:cloud:circleci:0', label: 'CircleCI fixture', priority: 0,
      hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'circleci', slot: 0 } }
    const running = ticket(uuid(8), { state: 'running', queuedAt: ago(5 * hours), startedAt: ago(4 * hours),
      executorCleanupPending: true, computer: { hostRef: executor.hostRef, label: executor.label } })
    const store = ticketStore([running], { [running.id]: executor.key })
    expect(await expireOverdueCiRuns(store.pool, now, async run => run)).toBe(1)
    const expired = store.read(running.id).record
    expect(store.read(running.id)).toMatchObject({ hostKey: executor.key, record: {
      executorCleanupPending: true, deadlineExceeded: { executor: 'retained' },
    } })
    const operations: string[] = []
    const endpoint = { computers: async () => [executor],
      request: async (_computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply> => {
        if (request.operation === 'status') {
          return { operation: 'status', ready: true, reasons: [], cpuCount: 4, memoryBytes: 2 ** 33, runs: [] }
        }
        operations.push(request.operation)
        if (request.operation !== 'cancel') throw new Error(`Unexpected ${request.operation}`)
        if (confirmation === 'unknown') throw new DomainError('CI_RUN_UNKNOWN', 'The executor has no such run.', 404)
        return { operation: 'cancel', run: { runId: request.runId, state: 'canceled', step: null,
          startedAt: expired.startedAt!, finishedAt: now.toISOString(), exitCode: null, logBytes: 0,
          executorCleanupPending: false, message: 'Canceled.' } }
      } }
    const authority: CiAuthority = { resolve: async principal => ({ principal, workspaceId: 'workspace' }) }
    const reopen = () => new HostCiService(store.pool, new PostgresCommandCoordinator(store.pool),
      authority, {} as CiCommits, endpoint)
    const service = reopen()
    try {
      await service.dispatch()
      await service.drain()
      expect(store.read(expired.id)).toMatchObject({ state: 'failed', hostKey: null, record: {
        executorCleanupPending: false, deadlineExceeded: { executor: 'released' },
        observation: { status: 'available', consecutiveFailures: 0, nextAttemptAt: null },
        finishedAt: expired.finishedAt, message: expired.message, collection: 'failed',
      } })
      expect(operations).toEqual(['cancel'])
    } finally { await service.close() }
    const restarted = reopen()
    try {
      await restarted.dispatch()
      await restarted.drain()
      expect(operations).toEqual(['cancel'])
      expect(store.read(expired.id)).toMatchObject({ hostKey: null, record: { executorCleanupPending: false } })
    } finally { await restarted.close() }
  },
)
