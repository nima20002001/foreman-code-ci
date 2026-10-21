import assert from 'node:assert/strict'

import type { NativeSessionReference, PendingNativeInteraction } from '@foreman-code/contracts'
import { describe, it } from 'vitest'

import type { NativeHarnessSessionManager, NativeHistory } from '../src/modules/harnesses/port.js'
import { ReviewerDispatcher } from '../src/modules/interactions/reviewer.js'
import type { ReviewerNativeRuntime } from '../src/modules/interactions/reviewerRuntime.js'
import { reviewCoordination, reviewJob, reviewSession } from './pr17-agent2-fixtures.js'

function fixture(coordination = reviewCoordination()) {
  const calls = { attach: 0, maintain: 0, cancel: 0, revoke: 0, recover: 0, starts: 0 }
  const request: PendingNativeInteraction = { session: reviewSession,
    turn: { nativeTurnId: 'review-turn', nativeRequestId: 'permission' }, nativeRequestType: 'item/commandExecution/requestApproval',
    request: { command: ['pwd'] }, responseOptions: [{ optionId: 'reject', semantic: 'reject', label: 'Reject',
      persistence: 'request', affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }] }
  let terminal = false
  const history = (): NativeHistory => ({ correlationId: 'review-correlation', nativeTurnId: 'review-turn',
    events: [{ type: 'thread.reconciled', sequence: 0, occurredAt: new Date().toISOString(), payload: { thread: {
      id: reviewSession.nativeSessionId, status: terminal ? 'idle' : 'active', turns: [{ id: 'review-turn',
        clientUserMessageId: 'review-correlation', status: terminal ? 'interrupted' : 'inProgress', items: [] }],
    } } }], pendingInteractions: terminal ? [] : [request] })
  const manager = { harness: 'codex', reconcile: async () => history(), pending: async () => terminal ? undefined : request,
    cancel: async (_session: NativeSessionReference, _signal?: AbortSignal, target?: string) => {
      assert.equal(target, 'review-turn'); calls.cancel++; return true
    },
    startTurn: async function* () { calls.starts++; yield* []; throw new Error('must never replay') },
  } as unknown as NativeHarnessSessionManager
  const runtime = {
    captureReviewNative: coordination.captureReviewNative,
    attachOwnedSession: async () => { calls.attach++; return { manager, session: reviewSession } },
    reviewCredentialIdentity: () => ({ required: true, principalId: 'captured-principal' }),
    maintainReviewCredential: async (_id: string, _session: unknown, signal: AbortSignal) => {
      calls.maintain++; return { signal, principalId: 'captured-principal', stop: async () => {},
        invalidate: async () => { calls.revoke++ } }
    },
    revokeReviewCredential: async (id: string) => { assert.equal(id, 'captured-principal'); calls.revoke++ },
    recoverReviewCleanup: async () => { calls.recover++; return { manager, resident: true, closed: false } },
  } as unknown as ReviewerNativeRuntime
  const dispatcher = new ReviewerDispatcher(coordination.repository, runtime)
  return { coordination, calls, runtime, dispatcher, finish: () => { terminal = true } }
}

describe('PR17 #2: dispatcher failure recovery', () => {
  it('persists failure, keeps the lane nonterminal after ACK, and settles without reattaching or renewing', async () => {
    const f = fixture()
    const failed = await f.dispatcher.dispatchNext('reviewer', 'worker')
    assert.equal(failed?.state, 'failed')
    assert.equal(failed?.error?.code, 'REVIEWER_NATIVE_APPROVAL_UNSUPPORTED')
    assert.equal(failed?.cleanup?.nativeState, 'pending')
    assert.equal(failed?.cleanup?.interruptState, 'acknowledged')
    assert.notEqual(f.coordination.lane.observedStatus, 'idle')
    assert.ok(f.coordination.lane.correlationId)
    assert.equal(f.coordination.transitions.find((value) => value.cleanup)?.state, 'failed')
    await f.dispatcher.dispatchNext('reviewer', 'worker')
    assert.deepEqual(f.calls, { attach: 1, maintain: 1, cancel: 1, revoke: 1, recover: 1, starts: 0 })
    f.finish()
    const settled = await f.dispatcher.dispatchNext('reviewer', 'worker')
    assert.equal(settled?.state, 'failed')
    assert.deepEqual(settled?.error, failed?.error)
    assert.ok(settled?.cleanup?.completedAt)
    assert.equal(f.coordination.lane.observedStatus, 'idle')
    assert.equal(await f.dispatcher.dispatchNext('reviewer', 'worker'), undefined)
    await f.dispatcher.shutdown()
  })

  it('does not release a successor lane or target its turn during old-job cleanup', async () => {
    const f = fixture()
    await f.dispatcher.dispatchNext('reviewer', 'worker')
    f.coordination.successor()
    f.finish()
    await f.dispatcher.dispatchNext('reviewer', 'worker')
    assert.equal(f.calls.cancel, 1)
    assert.equal(f.coordination.lane.observedStatus, 'busy')
    assert.equal(f.coordination.lane.currentTurnOrMessageId, 'successor-turn')
    assert.equal(f.coordination.lane.correlationId, 'successor-correlation')
    await f.dispatcher.shutdown()
  })

  it('does not replace the original failure on cleanup-runtime failure', async () => {
    const f = fixture()
    const failed = await f.dispatcher.dispatchNext('reviewer', 'worker')
    f.runtime.recoverReviewCleanup = async () => { throw new Error('recovery unavailable') }
    const retry = await f.dispatcher.dispatchNext('reviewer', 'worker')
    assert.equal(retry?.state, 'failed')
    assert.deepEqual(retry?.error, failed?.error)
    assert.equal(retry?.cleanup?.nativeState, 'pending')
    assert.equal(f.calls.attach, 1)
    await f.dispatcher.shutdown()
  })

  it('supports a previously persisted failed job without going through the normal attach path', async () => {
    const initial = { ...reviewJob(), state: 'failed' as const, error: { code: 'REVIEWER_CREDENTIAL_LOST', message: 'original failure' },
      cleanup: { nativeState: 'pending' as const, credentialState: 'revoked' as const, interruptState: 'acknowledged' as const } }
    const coordination = reviewCoordination(initial)
    const f = fixture(coordination)
    const dispatcher = new ReviewerDispatcher(coordination.repository, f.runtime)
    await dispatcher.dispatchNext('reviewer', 'worker')
    assert.equal(f.calls.attach, 0)
    assert.equal(f.calls.maintain, 0)
    assert.equal(f.calls.cancel, 0)
    assert.equal(f.calls.recover, 1)
    await dispatcher.shutdown()
    await f.dispatcher.shutdown()
  })
})
