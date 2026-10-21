import { CiRunRecordSchema } from '@foreman-code/contracts'
import { expect, expectTypeOf, it, vi } from 'vitest'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
import { cancelAssignedCiTicket } from './assignedCancellation.js'
import { dispatchCloudTicket, expireCloudDispatch } from './cloudDispatch.js'
import type { HostCiComputer, HostCiEndpoint } from './service.js'

function fixture(provider: 'github' | 'circleci') {
  const computer: HostCiComputer = {
    key: `cloud:${provider}`, label: 'Cloud executor', priority: 0,
    hostRef: { kind: 'cloud', mainId: 'fixture-main', provider, slot: 0 },
  }
  const run = CiRunRecordSchema.parse({
    id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace',
    groupId: '22222222-2222-4222-8222-222222222222', suite: 'lint', part: null,
    scope: 'full', files: [], partition: null, repository: 'owner/repo', commit: 'a'.repeat(40),
    state: 'starting', computer: { hostRef: computer.hostRef, label: computer.label }, step: 'dispatch',
    exitCode: null, message: null, queuedAt: new Date(Date.now() - 75_100).toISOString(),
    startedAt: null, finishedAt: null, dispatchAttempts: 3,
    initiator: { principalId: 'worker', executionId: 'execution' },
  })
  const endpoint: HostCiEndpoint = {
    computers: async () => [computer],
    request: vi.fn(async () => { throw new DomainError('CI_RUN_UNKNOWN', 'No provider run exists.', 404) }),
  }
  return { computer, run, endpoint }
}

it.each(['github', 'circleci'] as const)(
  'returns a nullable start time when canceling an unstarted %s ticket', async provider => {
    const f = fixture(provider)
    const result = await cancelAssignedCiTicket(f.endpoint, f.computer, f.run)

    expectTypeOf(result.startedAt).toEqualTypeOf<string | null>()
    expect(result).toMatchObject({ state: 'canceled', startedAt: null, finishedAt: expect.any(String) })
    expect(f.endpoint.request).toHaveBeenCalledExactlyOnceWith(f.computer,
      { operation: 'cancel', runId: f.run.id })
  })

it.each(['github', 'circleci'] as const)(
  'returns a nullable start time when exhausted %s dispatches are requeued', async provider => {
    const f = fixture(provider)
    const sql: SqlQuery = {
      query: vi.fn(async () => { throw new Error('An exhausted dispatch must not write another start.') }),
    }
    const result = await dispatchCloudTicket(sql, f.endpoint, f.computer, f.run)
    if (result.outcome !== 'settled') throw new Error('Expected the dispatch to settle.')

    expectTypeOf(result.observed.startedAt).toEqualTypeOf<string | null>()
    expect(result.observed).toMatchObject({ state: 'queued', startedAt: null, finishedAt: null })
    expect(f.endpoint.request).toHaveBeenCalledExactlyOnceWith(f.computer,
      { operation: 'read', runId: f.run.id, afterOffset: 0, maxBytes: 1 })
  })

it.each(['github', 'circleci'] as const)(
  'returns a nullable start time when an unstarted %s dispatch expires', async provider => {
    const f = fixture(provider)
    vi.mocked(f.endpoint.request).mockResolvedValue({ operation: 'cancel', run: {
      runId: f.run.id, state: 'canceled', step: null, exitCode: null, startedAt: f.run.queuedAt,
      finishedAt: new Date().toISOString(), message: 'Canceled.', logBytes: 0,
    } })
    const run = { ...f.run, dispatchedAt: new Date(Date.now() - 225_100).toISOString() }
    const result = await expireCloudDispatch(f.endpoint, f.computer, run)
    if (!result) throw new Error('Expected the expired dispatch to settle.')

    expectTypeOf(result.startedAt).toEqualTypeOf<string | null>()
    expect(result).toMatchObject({ state: 'queued', startedAt: null, finishedAt: null,
      message: expect.stringContaining('queued for another computer') })
    expect(f.endpoint.request).toHaveBeenCalledExactlyOnceWith(f.computer,
      { operation: 'cancel', runId: f.run.id })
  })

it.each(['github', 'circleci'] as const)(
  'retains expired %s dispatch ownership when provider cancellation is unconfirmed', async provider => {
    const f = fixture(provider)
    const run = { ...f.run, dispatchedAt: new Date(Date.now() - 225_100).toISOString() }
    await expect(expireCloudDispatch(f.endpoint, f.computer, run))
      .rejects.toMatchObject({ code: 'CI_CLOUD_CLEANUP_PENDING',
        message: 'Cloud cancellation failed; ownership retained.' })
    expect(f.endpoint.request).toHaveBeenCalledExactlyOnceWith(f.computer,
      { operation: 'cancel', runId: f.run.id })
  })
