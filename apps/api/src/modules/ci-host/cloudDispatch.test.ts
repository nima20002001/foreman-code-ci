import { CiRunRecordSchema, type CiHostReply, type CiHostRequest, type CiHostRun } from '@foreman-code/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
import { dispatchCloudTicket, expireCloudDispatch } from './cloudDispatch.js'
import { CLOUD_START_TIMEOUT_MS } from './cloudProviders.js'
import { CI_START_MAX_ATTEMPTS } from './dispatch.js'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'

const publishedAt = '2026-01-01T05:08:40.000Z'
const dispatchedAt = '2026-01-01T05:14:17.000Z'
const startWindowMs = CLOUD_START_TIMEOUT_MS * CI_START_MAX_ATTEMPTS

afterEach(() => vi.useRealTimers())

function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse(dispatchedAt) + 35_000)
  const computer: HostCiComputer = {
    key: 'cloud:circleci', label: 'Cloud executor', priority: 0,
    hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'circleci', slot: 0 },
  }
  const run = CiRunRecordSchema.parse({
    id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace',
    groupId: '22222222-2222-4222-8222-222222222222', suite: 'integration', part: null,
    scope: 'full', files: [], partition: null, repository: 'owner/repo', commit: 'a'.repeat(40),
    state: 'starting', computer: { hostRef: computer.hostRef, label: computer.label }, step: 'dispatch',
    exitCode: null, message: null, queuedAt: publishedAt, startedAt: publishedAt,
    finishedAt: null, dispatchAttempts: CI_START_MAX_ATTEMPTS, dispatchedAt: publishedAt,
    initiator: { principalId: 'worker', executionId: 'execution' },
    mirrorPublication: { state: 'ready', startedAt: publishedAt, finishedAt: publishedAt },
  })
  const observed: CiHostRun = {
    runId: run.id, state: 'starting', step: 'dispatch', startedAt: publishedAt,
    finishedAt: null, exitCode: null, logBytes: 0, message: null,
    mirrorPublication: run.mirrorPublication!,
  }
  const endpoint: HostCiEndpoint = {
    computers: async () => [computer],
    request: vi.fn(async (_computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply> => {
      if (request.operation === 'read') return { operation: 'read', run: observed, text: '', nextOffset: 0 }
      if (request.operation === 'cancel') return { operation: 'cancel', run: { ...observed, state: 'canceled' } }
      throw new Error('Unexpected cloud operation')
    }),
  }
  const sql: SqlQuery = {
    query: vi.fn(async () => { throw new Error('An assigned dispatch must not start another pipeline.') }),
  }
  return { computer, run, observed, endpoint, sql }
}

it.each(['observed start', 'saved start', 'saved dispatch', 'mirror finish'] as const)(
  'starts the cloud expiry window from the latest %s', async timestamp => {
    const f = fixture()
    if (timestamp === 'observed start') f.observed.startedAt = dispatchedAt
    if (timestamp === 'saved start') f.run.startedAt = dispatchedAt
    if (timestamp === 'saved dispatch') f.run.dispatchedAt = dispatchedAt
    if (timestamp === 'mirror finish') f.observed.mirrorPublication!.finishedAt = dispatchedAt
    const dispatch = () => dispatchCloudTicket(f.sql, f.endpoint, f.computer, f.run)

    await expect(dispatch()).resolves.toMatchObject({ outcome: 'settled', observed: { state: 'starting' } })
    vi.setSystemTime(Date.parse(dispatchedAt) + startWindowMs - 1)
    await expect(dispatch()).resolves.toMatchObject({ outcome: 'settled', observed: { state: 'starting' } })
    expect(vi.mocked(f.endpoint.request).mock.calls.map(([, request]) => request.operation)).toEqual(['read', 'read'])

    vi.setSystemTime(Date.parse(dispatchedAt) + startWindowMs)
    await expect(dispatch()).resolves.toMatchObject({ outcome: 'settled', observed: {
      state: 'queued', startedAt: null, finishedAt: null,
      message: expect.stringContaining('queued for another computer'),
    } })
    expect(vi.mocked(f.endpoint.request).mock.calls.map(([, request]) => request.operation))
      .toEqual(['read', 'read', 'read', 'cancel'])
    expect(f.sql.query).not.toHaveBeenCalled()
  },
)

it.each(['CI_RUN_UNKNOWN', 'CI_CLOUD_RUN_UNREADABLE'])(
  'waits from the saved provider start after a read fails with %s', async code => {
    const f = fixture()
    f.run.startedAt = dispatchedAt
    vi.mocked(f.endpoint.request).mockImplementation(async (_computer, request) => {
      if (request.operation === 'read') throw new DomainError(code, 'Provider lookup failed.', 502)
      return { operation: 'cancel', run: { ...f.observed, state: 'canceled' } }
    })
    const dispatch = () => dispatchCloudTicket(f.sql, f.endpoint, f.computer, f.run)

    await expect(dispatch()).resolves.toEqual({ outcome: 'pending' })
    const timeoutMs = code === 'CI_RUN_UNKNOWN' ? CLOUD_START_TIMEOUT_MS : startWindowMs
    vi.setSystemTime(Date.parse(dispatchedAt) + timeoutMs - 1)
    await expect(dispatch()).resolves.toEqual({ outcome: 'pending' })
    expect(vi.mocked(f.endpoint.request).mock.calls.map(([, request]) => request.operation)).toEqual(['read', 'read'])

    vi.setSystemTime(Date.parse(dispatchedAt) + timeoutMs)
    await expect(dispatch()).resolves.toMatchObject({ outcome: 'settled', observed: { state: 'queued' } })
    expect(f.sql.query).not.toHaveBeenCalled()
  },
)

const computer: HostCiComputer = {
  key: 'cloud:github:0', label: 'GitHub Actions', priority: 0,
  hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 0 },
}
const run = CiRunRecordSchema.parse({
  id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace',
  groupId: '22222222-2222-4222-8222-222222222222', suite: 'lint', part: null,
  scope: 'full', files: [], partition: null, repository: 'fixture/project', commit: 'a'.repeat(40),
  state: 'starting', computer: { hostRef: computer.hostRef, label: computer.label }, step: null,
  exitCode: null, message: null, queuedAt: '2020-01-01T00:00:00.000Z', startedAt: null, finishedAt: null,
  initiator: { principalId: 'operator', executionId: null },
})

it('retains expired cloud ownership when cancellation fails', async () => {
  const failure = new Error('Provider cancellation unavailable')
  const endpoint: HostCiEndpoint = { computers: async () => [computer], request: vi.fn(async () => { throw failure }) }
  await expect(expireCloudDispatch(endpoint, computer, run)).rejects.toMatchObject({
    code: 'CI_CLOUD_CLEANUP_PENDING', message: expect.stringContaining('ownership retained'),
  })
  expect(endpoint.request).toHaveBeenCalledWith(computer, { operation: 'cancel', runId: run.id })
  expect(run.state).toBe('starting')
})

it('does not claim release when cancellation returns a running attempt', async () => {
  const endpoint: HostCiEndpoint = { computers: async () => [computer], request: async () => ({
    operation: 'cancel', run: { runId: run.id, state: 'running', step: null, startedAt: run.queuedAt,
      finishedAt: null, exitCode: null, message: null, logBytes: 0 },
  }) }
  await expect(expireCloudDispatch(endpoint, computer, run)).rejects.toMatchObject({ code: 'CI_CLOUD_CLEANUP_PENDING' })
})

it('releases an expired dispatch only after confirmed terminal cancellation', async () => {
  const endpoint: HostCiEndpoint = { computers: async () => [computer], request: async () => ({
    operation: 'cancel', run: { runId: run.id, state: 'canceled', step: null, startedAt: run.queuedAt,
      finishedAt: new Date().toISOString(), exitCode: null, message: null, logBytes: 0 },
  }) }
  await expect(expireCloudDispatch(endpoint, computer, run)).resolves.toMatchObject({
    state: 'queued', finishedAt: null, message: expect.stringContaining('queued for another computer'),
  })
})


it('preserves a terminal result discovered during expiry cancellation', async () => {
  const endpoint: HostCiEndpoint = { computers: async () => [computer], request: async () => ({
    operation: 'cancel', run: { runId: run.id, state: 'passed', step: 'lint', startedAt: run.queuedAt,
      finishedAt: new Date().toISOString(), exitCode: 0, message: 'Completed before cancellation', logBytes: 10 },
  }) }
  await expect(expireCloudDispatch(endpoint, computer, run)).resolves.toMatchObject({ state: 'passed', exitCode: 0 })
})
