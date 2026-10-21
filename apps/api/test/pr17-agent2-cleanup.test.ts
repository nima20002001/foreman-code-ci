import assert from 'node:assert/strict'

import { PendingNativeInteractionSchema, type NativeHarnessEvent, type NativeSessionReference, type ReviewCleanup, type ReviewJob } from '@foreman-code/contracts'
import { describe, it } from 'vitest'

import type { NativeHistory } from '../src/modules/harnesses/port.js'
import { reviewOwnsPermission, settleReviewCleanup, type ReviewCleanupAttempt } from '../src/modules/interactions/reviewerCleanup.js'

const time = '2026-09-17T00:00:00.000Z'
const session: NativeSessionReference = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'review-session' }
const failure = { code: 'REVIEWER_NATIVE_APPROVAL_UNSUPPORTED', message: 'Original business failure.' }
function event(type: string, payload: Record<string, unknown>): NativeHarnessEvent {
  return { type, payload, sequence: 0, occurredAt: time }
}
function job(): ReviewJob {
  return { id: 'review-job', interactionId: 'interaction', reviewerAgentId: 'reviewer', attempt: 1,
    state: 'failed', provider: 'codex', nativeSessionId: session.nativeSessionId, correlationId: 'correlation',
    providerTurnOrMessageId: 'review-turn', submittedAt: time, createdAt: time, updatedAt: time, error: failure,
    cleanup: { nativeState: 'pending', credentialState: 'pending', credentialPrincipalId: 'original-principal', interruptState: 'not_sent' } }
}
function history(status = 'inProgress'): NativeHistory {
  return { events: [event('thread.reconciled', { thread: { id: session.nativeSessionId,
    status: status === 'inProgress' ? 'active' : 'idle',
    turns: [{ id: 'review-turn', clientUserMessageId: 'correlation', status, items: [] }] } })], pendingInteractions: [] }
}
function harness(initial = job()) {
  let current = initial
  const persisted: ReviewJob[] = []
  const calls: string[] = []
  const input: ReviewCleanupAttempt = {
    job: current, session, ownsTurn: true, check: async () => {}, observe: async () => history(),
    cancel: async (id) => { calls.push(`cancel:${id}`); return true },
    revoke: async (id) => { calls.push(`revoke:${id}`) },
    persist: async (cleanup: ReviewCleanup, release: boolean, providerId?: string) => {
      current = { ...current, cleanup: structuredClone(cleanup), ...(providerId ? { providerTurnOrMessageId: providerId } : {}) }
      if (release) { delete current.leaseToken; delete current.leaseOwner; delete current.leaseExpiresAt }
      persisted.push(structuredClone(current))
      return current
    },
  }
  const run = async () => { input.job = current; return settleReviewCleanup(input) }
  return { input, run, calls, persisted }
}

describe('PR17 #2: durable failure cleanup', () => {
  it('keeps an acknowledged interrupt nonterminal and later settles exact native history', async () => {
    const h = harness()
    const failed = await h.run()
    assert.equal(failed.state, 'failed')
    assert.deepEqual(failed.error, failure)
    assert.equal(failed.cleanup?.nativeState, 'pending')
    assert.equal(failed.cleanup?.interruptState, 'acknowledged')
    assert.equal(failed.cleanup?.credentialState, 'revoked')
    assert.equal(failed.cleanup?.completedAt, undefined)
    assert.equal(h.persisted[0]?.cleanup?.interruptState, 'submitted')
    await h.run()
    assert.deepEqual(h.calls, ['cancel:review-turn', 'revoke:original-principal'])
    h.input.observe = async () => history('interrupted')
    const settled = await h.run()
    assert.equal(settled.state, 'failed')
    assert.deepEqual(settled.error, failure)
    assert.equal(settled.cleanup?.nativeState, 'terminal')
    assert.ok(settled.cleanup?.completedAt)
    assert.deepEqual(h.calls, ['cancel:review-turn', 'revoke:original-principal'])
  })

  for (const mode of ['false', 'throw'] as const) {
    it(`keeps ${mode} cancellation recoverable without replaying an uncertain mutation`, async () => {
      const h = harness()
      h.input.cancel = async () => { h.calls.push('cancel'); if (mode === 'throw') throw new Error('lost response'); return false }
      assert.equal((await h.run()).cleanup?.nativeState, 'pending')
      await h.run()
      assert.equal(h.calls.filter((call) => call === 'cancel').length, 1)
      h.input.observe = async () => history('interrupted')
      assert.ok((await h.run()).cleanup?.completedAt)
    })
  }

  it('persists terminal native proof before retrying failed exact-principal revocation', async () => {
    const h = harness()
    h.input.observe = async () => history('completed')
    h.input.revoke = async () => { throw new Error('database unavailable') }
    const failed = await h.run()
    assert.equal(failed.cleanup?.nativeState, 'terminal')
    assert.equal(failed.cleanup?.credentialState, 'pending')
    assert.equal(failed.cleanup?.completedAt, undefined)
    h.input.observe = async () => { throw new Error('must not need native work again') }
    h.input.revoke = async (id) => { h.calls.push(`revoke:${id}`) }
    assert.ok((await h.run()).cleanup?.completedAt)
    assert.deepEqual(h.calls, ['revoke:original-principal'])
  })

  it('does not cancel a successor or infer closure from missing local state', async () => {
    const h = harness()
    h.input.ownsTurn = false
    h.input.confirmClosed = async () => { throw new Error('must not close successor') }
    await h.run()
    assert.deepEqual(h.calls, ['revoke:original-principal'])
    delete h.input.observe
    assert.equal((await h.run()).cleanup?.nativeState, 'pending')
    h.input.closed = true // positive evidence, not an absent manager
    assert.equal((await h.run()).cleanup?.nativeState, 'closed')
  })

  it('requires actual closure success for nonresident cleanup', async () => {
    const h = harness()
    delete h.input.observe
    h.input.confirmClosed = async () => false
    assert.equal((await h.run()).cleanup?.nativeState, 'pending')
    h.input.confirmClosed = async () => true
    assert.equal((await h.run()).cleanup?.nativeState, 'closed')
  })

  it('does not interpret empty history or generic terminalResult as terminal proof', async () => {
    const h = harness()
    h.input.observe = async () => ({ events: [], pendingInteractions: [], terminalResult: { outcome: 'canceled' } })
    assert.equal((await h.run()).cleanup?.nativeState, 'pending')
  })

  it('stops all cleanup side effects when the writer/job fence is lost', async () => {
    const h = harness()
    h.input.check = async () => { throw new Error('lease lost') }
    await assert.rejects(h.run, /lease lost/)
    assert.deepEqual(h.calls, [])
    assert.deepEqual(h.persisted, [])
  })
})

describe('Claude review cleanup uses actual SDK message and callback ownership', () => {
  const claude: NativeSessionReference = { harness: 'claude', providerVersion: '0.3.284', nativeSessionId: 'claude-review' }
  const messageId = 'accepted-sdk-input-message'
  function callback() {
    const request = PendingNativeInteractionSchema.parse({ session: claude,
      turn: { nativeMessageId: messageId, nativeRequestId: 'sdk-control-request' }, nativeRequestType: 'can_use_tool',
      request: { nativeMessageId: messageId, generation: 'actual-sdk-generation', attemptId: 'review-attempt',
        toolUseId: 'actual-tool-use', toolName: 'Read', input: {} },
      responseOptions: [{ optionId: 'cancel', semantic: 'cancel', label: 'Cancel', persistence: 'request',
        affectsOtherPendingRequests: false, interruptsCurrentTurn: true, mutatesPersistentPolicy: false }] })
    const native: NativeHistory = { events: [], pendingInteractions: [request], correlationId: 'correlation',
      nativeSubmission: { kind: 'message', nativeSessionId: claude.nativeSessionId,
        nativeMessageId: messageId, clientCorrelationId: 'correlation' } }
    return { request, native }
  }

  it('owns a callback only through the accepted input receipt, without inventing a native turn ID', () => {
    const { request, native } = callback()
    assert.equal(request.turn.nativeTurnId, undefined)
    assert.equal(reviewOwnsPermission(claude, messageId, request, native), true)
    assert.equal(reviewOwnsPermission(claude, 'assistant-output-id', request, native), false)
    const missing = { ...native }; delete missing.nativeSubmission
    assert.equal(reviewOwnsPermission(claude, messageId, request, missing), false)
    assert.equal(reviewOwnsPermission(claude, messageId, request, { ...native, correlationId: 'another-review' }), false)
    assert.equal(reviewOwnsPermission(claude, messageId, { ...request, nativeRequestType: 'permission.asked' }, native), false)
    assert.equal(reviewOwnsPermission(claude, messageId, { ...request, session: { ...claude, nativeSessionId: 'foreign-session' } }, native), false)
  })

  for (const field of ['nativeMessageId', 'generation', 'attemptId', 'toolUseId'] as const) {
    it(`refuses cleanup with missing callback ${field}`, () => {
      const { request, native } = callback()
      const changed = { ...request, request: { ...request.request as Record<string, string>, [field]: '' } }
      assert.equal(reviewOwnsPermission(claude, messageId, changed, native), false)
    })
  }

  it('journals one exact SDK message cancel and waits for terminal evidence before cleanup completion', async () => {
    const h = harness({ ...job(), provider: 'claude', nativeSessionId: claude.nativeSessionId, providerTurnOrMessageId: messageId })
    const { native } = callback()
    h.input.session = claude
    h.input.observe = async () => native
    const interrupted = await h.run()
    assert.deepEqual(h.calls, [`cancel:${messageId}`, 'revoke:original-principal'])
    assert.equal(interrupted.cleanup?.nativeState, 'pending')
    assert.equal(h.persisted[0]?.cleanup?.interruptState, 'submitted')
    await h.run()
    assert.equal(h.calls.filter((call) => call.startsWith('cancel:')).length, 1)
    h.input.observe = async () => ({ ...native, pendingInteractions: [],
      terminalTurn: { correlationId: 'correlation', providerId: messageId, result: { outcome: 'canceled' } } })
    assert.ok((await h.run()).cleanup?.completedAt)
  })
})

it('cleans up an owned permission whose saved Codex version is absent from release records', async () => {
  const saved = { ...session, providerVersion: 'codex-cli 0.158.0' }
  const h = harness()
  const pending = PendingNativeInteractionSchema.parse({ session: saved,
    turn: { nativeTurnId: 'review-turn', nativeRequestId: 'saved-version-permission' },
    nativeRequestType: 'item/commandExecution/requestApproval', request: {}, responseOptions: [{
      optionId: 'reject-owned', semantic: 'reject', label: 'Reject', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false,
    }],
  })
  h.input.session = saved
  h.input.pending = [pending]
  assert.equal(reviewOwnsPermission(saved, 'review-turn', pending, history()), true)
  const result = await h.run()
  assert.equal(result.cleanup?.interruptState, 'acknowledged')
  assert(h.calls.includes('cancel:review-turn'))
  assert.equal(result.cleanup?.nativeState, 'pending')
})
