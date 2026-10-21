import assert from 'node:assert/strict'
import { inspect } from 'node:util'

import type pg from 'pg'
import { it, vi } from 'vitest'

import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import { WorkerCredentialService, type IssuedWorkerCredential } from '../src/modules/access/workerCredentials.js'
import { DomainError } from '../src/modules/errors.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { historicalSecret, now, providerId, reviewerFixture, secret, session, until } from './helpers/reviewerAudit.js'
import { rejectableDeferred } from './helpers/deferred.js'

it('F8: a silent 75-second review renews its one-minute credential without rotating token or native work', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now))
  try {
    const fixture = await reviewerFixture({ silent: true })
    const task = fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
    await until(() => fixture.starts.length === 1)
    await vi.advanceTimersByTimeAsync(75_000)
    assert.ok(fixture.renewed.length >= 2)
    assert.ok(fixture.renewed.every((renewal) => renewal.principalId === fixture.credential.principalId && renewal.executionId === fixture.execution.id))
    assert.equal(fixture.prepared.length, 1)
    assert.equal(fixture.starts.length, 1)
    assert.equal(fixture.attaches.length, 1)
    assert.equal(fixture.attaches[0]!.environment, fixture.credential.environment)
    assert.ok(fixture.hooks.validations > fixture.renewed.length)
    fixture.finish()
    assert.equal((await task)?.state, 'completed')
    const renewals = fixture.renewed.length
    await vi.advanceTimersByTimeAsync(120_000)
    assert.equal(fixture.renewed.length, renewals, 'terminal review must stop renewal')
  } finally { vi.useRealTimers() }
})

it('F8: renewal failure fails closed, cancels the exact turn, revokes only its principal and redacts errors', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now))
  try {
    const fixture = await reviewerFixture({ silent: true })
    const task = fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
    await until(() => fixture.starts.length === 1)
    fixture.hooks.renew = async () => { throw new Error(`Renew ${secret} ${historicalSecret}`) }
    await vi.advanceTimersByTimeAsync(1)
    const result = await task
    assert.equal(result?.state, 'failed')
    assert.equal(result.error?.code, 'REVIEWER_CREDENTIAL_LOST')
    assert.equal(fixture.prepared.length, 1)
    assert.equal(fixture.starts.length, 1)
    assert.deepEqual(fixture.revoked, [fixture.credential.principalId])
    assert.deepEqual(fixture.cancellations, [{ session, nativeTurnId: providerId }])
    assert.equal(inspect(fixture.saved, { depth: null }).includes(secret), false)
    assert.equal(inspect(result, { depth: null }).includes(historicalSecret), false)
    const count = fixture.renewed.length
    await vi.advanceTimersByTimeAsync(120_000)
    assert.equal(fixture.renewed.length, count)
  } finally { vi.useRealTimers() }
})

it('F8: authority invalidation is revalidated before renewal and stops the review without scope escalation', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now))
  try {
    const fixture = await reviewerFixture({ silent: true })
    const task = fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
    await until(() => fixture.starts.length === 1)
    await vi.advanceTimersByTimeAsync(1)
    const count = fixture.renewed.length
    fixture.run.approval.designatedOrchestratorAgentId = 'different-authority'
    await vi.advanceTimersByTimeAsync(20_000)
    assert.equal((await task)?.state, 'failed')
    assert.equal(fixture.renewed.length, count)
    assert.deepEqual(fixture.revoked, [fixture.credential.principalId])
    assert.equal(fixture.prepared.length, 1)
    assert.equal(fixture.responses, 0)
  } finally { vi.useRealTimers() }
})

it('F8: dispatcher shutdown stops renewal and never cancels a successor session or starts replacement work', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now))
  try {
    const fixture = await reviewerFixture({ silent: true })
    const errors: unknown[] = []
    await fixture.dispatcher.reconcile((error) => errors.push(error))
    await until(() => fixture.starts.length === 1)
    await vi.advanceTimersByTimeAsync(1)
    await fixture.dispatcher.shutdown()
    const count = fixture.renewed.length
    await vi.advanceTimersByTimeAsync(120_000)
    assert.equal(fixture.renewed.length, count)
    assert.equal(fixture.prepared.length, 1)
    assert.equal(fixture.starts.length, 1)
    assert.ok(errors.length <= 1)
    assert.equal(fixture.cancellations.length, 0)
    fixture.finish()
  } finally { vi.useRealTimers() }
})

it('F8: Run cancellation stops the reviewer heartbeat and retains the no-replay submission marker', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now))
  try {
    const fixture = await reviewerFixture({ silent: true })
    const task = fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker').catch(() => undefined)
    await until(() => fixture.starts.length === 1)
    await vi.advanceTimersByTimeAsync(1)
    fixture.stopFence()
  await fixture.runtime.cancelRun(fixture.run.id)
    await task
    const count = fixture.renewed.length
    await vi.advanceTimersByTimeAsync(120_000)
    assert.equal(fixture.renewed.length, count)
    assert.equal(fixture.starts.length, 1)
    assert.ok(fixture.job.submittedAt)
  } finally { vi.useRealTimers() }
})

it('F8: lost job lease stops renewal without revoking or canceling a possible successor', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now))
  try {
    const fixture = await reviewerFixture({ silent: true })
    let error: unknown
    const task = fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker').catch((value: unknown) => { error = value })
    await until(() => fixture.starts.length === 1)
    await vi.advanceTimersByTimeAsync(1)
    const count = fixture.renewed.length
    fixture.hooks.lostJob = true
    await vi.advanceTimersByTimeAsync(10_000)
    await task
    assert.ok(error instanceof DomainError)
    assert.equal(error.code, 'REVIEW_JOB_LEASE_LOST')
    assert.equal(fixture.cancellations.length, 0)
    assert.equal(fixture.revoked.length, 0)
    await vi.advanceTimersByTimeAsync(120_000)
    assert.equal(fixture.renewed.length, count)
    fixture.finish()
  } finally { vi.useRealTimers() }
})

it('F8: Run terminal state prevents further renewal and replacement work', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now))
  try {
    const fixture = await reviewerFixture({ silent: true })
    const task = fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
    await until(() => fixture.starts.length === 1)
    await vi.advanceTimersByTimeAsync(1)
    const count = fixture.renewed.length
    fixture.run.executionState = 'completed'; fixture.run.outcome = 'failed'
    await vi.advanceTimersByTimeAsync(20_000)
    assert.equal((await task)?.state, 'failed')
    await vi.advanceTimersByTimeAsync(120_000)
    assert.equal(fixture.renewed.length, count)
    assert.equal(fixture.starts.length, 1)
    assert.equal(fixture.prepared.length, 1)
  } finally { vi.useRealTimers() }
})

it('F8: a delayed renewal cannot update the local credential after maintenance stops', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now))
  try {
    const fixture = await reviewerFixture()
    const attached = await fixture.attach()
    const renewal = rejectableDeferred<string>()
    fixture.hooks.renew = () => renewal.promise
    const maintenance = await fixture.runtime.maintainReviewCredential(fixture.execution.id, session, new AbortController().signal, async () => {})
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(fixture.renewed.length, 1)
    const registry = (fixture.runtime as unknown as { managerCredentials: WeakMap<NativeHarnessSessionManager, IssuedWorkerCredential> }).managerCredentials
    const before = registry.get(attached.manager)
    const stopped = maintenance.stop()
    await vi.advanceTimersByTimeAsync(1_001)
    await stopped
    renewal.resolve(new Date(Date.now() + 60_000).toISOString())
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(registry.get(attached.manager), before)
    assert.equal(fixture.renewed.length, 1)
    assert.equal(fixture.prepared.length, 1)
  } finally { vi.useRealTimers() }
})

it('F8: owner replacement during renewal cannot be overwritten or have its credential revoked', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now))
  try {
    const fixture = await reviewerFixture()
    const attached = await fixture.attach()
    const registry = (fixture.runtime as unknown as { managerCredentials: WeakMap<NativeHarnessSessionManager, IssuedWorkerCredential> }).managerCredentials
    const replacement: IssuedWorkerCredential = { ...fixture.credential, principalId: 'principal-successor',
      environment: { agentId: fixture.execution.agentId, variables: { GRAPHQL_MCP_TOKEN: 'replacement-token' } } }
    fixture.hooks.renew = async () => { registry.set(attached.manager, replacement); return new Date(Date.now() + 60_000).toISOString() }
    const maintenance = await fixture.runtime.maintainReviewCredential(fixture.execution.id, session, new AbortController().signal, async () => {})
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(maintenance.signal.aborted, true)
    assert.equal(registry.get(attached.manager), replacement)
    await maintenance.invalidate()
    assert.deepEqual(fixture.revoked, [fixture.credential.principalId])
    await maintenance.stop()
  } finally { vi.useRealTimers() }
})

it('F8: invalid authority during initial maintenance still returns a captured revocation handle', async () => {
  const fixture = await reviewerFixture()
  await fixture.attach()
  fixture.run.approval.designatedOrchestratorAgentId = 'different-authority'
  const maintenance = await fixture.runtime.maintainReviewCredential(fixture.execution.id, session, new AbortController().signal, async () => {})
  assert.equal(maintenance.signal.aborted, true)
  await maintenance.invalidate(); await maintenance.stop()
  assert.deepEqual(fixture.revoked, [fixture.credential.principalId])
  assert.equal(fixture.renewed.length, 0)
})

it('F8: an expired resident reviewer token is never renewed or replaced in a still-owned native process', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now))
  try {
    const fixture = await reviewerFixture()
    await fixture.attach()
    vi.setSystemTime(new Date(Date.now() + 61_000))
    await assert.rejects(fixture.attach())
    assert.equal(fixture.prepared.length, 1)
    assert.equal(fixture.renewed.length, 0)
    assert.equal(fixture.starts.length, 0)
  } finally { vi.useRealTimers() }
})

it('credential renewal returns database expiry and a monotonic deadline despite API clock skew', async () => {
  const databaseNow = new Date('2026-10-01T00:00:00.000Z')
  const expiresAt = new Date(databaseNow.getTime() + 60_000)
  const pool = { query: async () => ({ rows: [{ expires_at: expiresAt, database_now: databaseNow }] }) } as unknown as pg.Pool
  const service = new WorkerCredentialService(pool, {} as PostgresAccessService, 60_000)
  const credential: Pick<IssuedWorkerCredential, 'principalId' | 'renewalDeadline'> = {
    principalId: 'principal-reviewer',
  }
  const monotonic = vi.spyOn(performance, 'now').mockReturnValue(1_000)
  const wallClock = vi.spyOn(Date, 'now').mockReturnValue(databaseNow.getTime() + 120_000)
  try {
    assert.equal(await service.renewForExecution('execution-reviewer', credential), expiresAt.toISOString())
    assert.equal(credential.renewalDeadline, 61_000)
  } finally {
    monotonic.mockRestore()
    wallClock.mockRestore()
  }
})

it('credential renewal returns the database expiry and a monotonic deadline', async () => {
  const databaseNow = new Date('2026-09-16T00:00:00.000Z')
  const expiresAt = new Date(databaseNow.getTime() + 60_000)
  const pool = {
    async query() {
      return { rows: [{ expires_at: expiresAt, database_now: databaseNow }] }
    },
  } as unknown as pg.Pool
  const service = new WorkerCredentialService(pool, {} as PostgresAccessService, 60_000)
  const credential: Pick<IssuedWorkerCredential, 'principalId' | 'renewalDeadline'> = {
    principalId: 'principal-reviewer',
  }
  const requestedAt = performance.now()
  assert.equal(await service.renewForExecution('execution-reviewer', credential), expiresAt.toISOString())
  assert.ok(credential.renewalDeadline! >= requestedAt + 59_999)
  assert.ok(credential.renewalDeadline! <= performance.now() + 60_000)
})

it('F8: hung initial authority validation fails before credential expiry instead of waiting forever', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now))
  try {
    const fixture = await reviewerFixture()
    await fixture.attach()
    const blocked = rejectableDeferred()
    fixture.hooks.validate = () => blocked.promise
    const task = fixture.runtime.maintainReviewCredential(fixture.execution.id, session, new AbortController().signal, async () => {})
    await vi.advanceTimersByTimeAsync(55_001)
    const maintenance = await task
    assert.equal(maintenance.signal.aborted, true)
    assert.equal(fixture.renewed.length, 0)
    assert.ok(Date.now() < Date.parse(fixture.credential.expiresAt))
    await maintenance.invalidate(); await maintenance.stop()
    blocked.resolve()
    assert.deepEqual(fixture.revoked, [fixture.credential.principalId])
  } finally { vi.useRealTimers() }
})
