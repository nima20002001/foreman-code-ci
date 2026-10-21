import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type { DurableInteraction, NativeHarnessEvent, NativeSessionReference, PendingNativeInteraction } from '@foreman-code/contracts'
import type { NativeHistory } from '../src/modules/harnesses/port.js'
import { matchingDeliveryEvidence, type NativeResponseDeliveryEvidence } from '../src/modules/interactions/delivery.js'

/** Current approval records only. This unit fixture has no Run admission, fake
 * native authority, legacy workflow schema or database publication capability. */
function fixture() {
  const createdAt = '2026-09-26T00:00:00.000Z'
  const interaction: DurableInteraction = {
    id: 'eng06-interaction', revision: 1, workspaceId: 'eng06-workspace', workflowId: 'eng06-workflow',
    runId: 'eng06-run-s3', graphThreadId: 'eng06-run-s3', executionId: 'eng06-execution-1', requestingAgentId: 'eng06-worker',
    harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'eng06-native-session-1',
    nativeRequestId: 'eng06-request-1', nativeRequestType: 'item/commandExecution/requestApproval',
    request: { itemId: 'eng06-item', turnId: 'eng06-turn', threadId: 'eng06-native-session-1',
      command: 'printf eng06', cwd: '/synthetic/eng06' }, approval: { handler: 'user' },
    responseOptions: [
      { optionId: 'approve', semantic: 'approve_once', label: 'Approve once', persistence: 'request',
        affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
      { optionId: 'reject', semantic: 'reject', label: 'Reject', persistence: 'request',
        affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
    ],
    status: 'delivery_pending', deliveryState: 'uncertain', selectedOptionId: 'approve', selectedSemantic: 'approve_once',
    nativeResponse: { optionId: 'approve', semantic: 'approve_once' }, createdAt, updatedAt: createdAt, decidedAt: createdAt,
  }
  const session: NativeSessionReference = { harness: interaction.harness,
    providerVersion: interaction.providerVersion, nativeSessionId: interaction.nativeSessionId }
  const proof: NativeResponseDeliveryEvidence = { source: 'provider_acknowledgement', ...session,
    nativeRequestId: interaction.nativeRequestId, nativeRequestType: interaction.nativeRequestType,
    optionId: 'approve', semantic: 'approve_once' }
  const pending: PendingNativeInteraction = { session, turn: { nativeTurnId: 'eng06-turn', nativeRequestId: interaction.nativeRequestId },
    nativeRequestType: interaction.nativeRequestType, request: interaction.request, responseOptions: interaction.responseOptions }
  const event = (sequence: number, type: string, payload: Record<string, unknown>): NativeHarnessEvent => ({
    sequence, type, payload, connectionId: 'eng06-original-connection', occurredAt: createdAt,
  })
  const events = [
    event(0, 'interaction.pending', { nativeRequestId: interaction.nativeRequestId,
      nativeRequestType: interaction.nativeRequestType, turnId: 'eng06-turn' }),
    event(1, 'interaction.submitted', { nativeRequestId: interaction.nativeRequestId, optionId: 'approve', semantic: 'approve_once' }),
    event(2, 'interaction.resolved', { nativeRequestId: interaction.nativeRequestId,
      submittedOptionId: 'approve', evidence: 'serverRequest/resolved' }),
    event(3, 'item.completed', { threadId: session.nativeSessionId, turnId: 'eng06-turn', item: {
      id: 'eng06-item', type: 'commandExecution', status: 'completed', command: 'printf eng06', cwd: '/synthetic/eng06', exitCode: 0,
    } }),
  ]
  const history: NativeHistory = { events: [], pendingInteractions: [], responseDeliveries: [proof] }
  return { interaction, session, proof, pending, events, history, event }
}

describe('ENG06-C native response evidence after reconnect/replay', () => {
  for (const source of ['provider_acknowledgement', 'provider_history'] as const) {
    it(`accepts exact ${source}, including duplicate/reordered copies, without mutating observations`, () => {
      const f = fixture(), proof = { ...f.proof, source }
      const history: NativeHistory = { ...f.history, responseDeliveries: [
        { ...proof, nativeRequestId: 'unrelated-sibling-request' }, proof, { ...proof },
      ] }
      const before = structuredClone({ interaction: f.interaction, session: f.session, history })
      assert.deepEqual(matchingDeliveryEvidence(f.interaction, f.session, history), proof)
      assert.deepEqual(matchingDeliveryEvidence(f.interaction, f.session, {
        ...history, responseDeliveries: [...history.responseDeliveries!].reverse(),
      }), proof)
      assert.deepEqual({ interaction: f.interaction, session: f.session, history }, before)
    })
  }

  for (const [name, change] of [
    ['session', { nativeSessionId: 'different-session' }],
    ['provider version', { providerVersion: 'different-version' }],
    ['harness', { harness: 'claude' as const }],
  ] as const) {
    it(`rejects an ACK read through a mismatched ${name}`, () => {
      const f = fixture()
      assert.equal(matchingDeliveryEvidence(f.interaction, { ...f.session, ...change }, f.history), undefined)
    })
  }

  for (const [name, change] of [
    ['native session', { nativeSessionId: 'older-session' }],
    ['native request', { nativeRequestId: 'older-request' }],
    ['request type', { nativeRequestType: 'different/request' }],
    ['provider version', { providerVersion: 'different-version' }],
    ['option', { optionId: 'reject' }],
    ['semantic', { semantic: 'reject' as const }],
  ] as const) {
    it(`rejects a retained receipt for the wrong ${name}`, () => {
      const f = fixture()
      assert.equal(matchingDeliveryEvidence(f.interaction, f.session, {
        ...f.history, responseDeliveries: [{ ...f.proof, ...change }],
      }), undefined)
    })
  }

  for (const positiveFirst of [true, false]) {
    it(`retains uncertainty when contradictory decisions accompany a valid ACK (${positiveFirst ? 'positive first' : 'negative first'})`, () => {
      const f = fixture(), contradictory = { ...f.proof, optionId: 'reject', semantic: 'reject' as const }
      const proofs = positiveFirst ? [f.proof, contradictory] : [contradictory, f.proof]
      assert.equal(matchingDeliveryEvidence(f.interaction, f.session, { ...f.history, responseDeliveries: proofs }), undefined)
    })
  }

  for (const alias of ['pendingInteractions', 'pendingInteraction'] as const) {
    it(`does not acknowledge a request still present in ${alias}`, () => {
      const f = fixture(), history: NativeHistory = alias === 'pendingInteraction'
        ? { ...f.history, pendingInteraction: f.pending } : { ...f.history, pendingInteractions: [f.pending] }
      assert.equal(matchingDeliveryEvidence(f.interaction, f.session, history), undefined)
    })
  }

  it('does not turn empty pending lists or a generic terminal result into response proof', () => {
    const f = fixture()
    assert.equal(matchingDeliveryEvidence(f.interaction, f.session, { events: [], pendingInteractions: [] }), undefined)
    assert.equal(matchingDeliveryEvidence(f.interaction, f.session, { pendingInteractions: [],
      events: [f.event(9, 'turn.completed', { threadId: f.session.nativeSessionId, turnId: 'eng06-turn' })],
      terminalResult: { outcome: 'succeeded', output: { done: true } },
    }), undefined)
  })

  it('requires a durable selected response, not just a matching provider observation', () => {
    const f = fixture(), noSelection = { ...f.interaction }
    delete noSelection.selectedOptionId; delete noSelection.selectedSemantic
    assert.equal(matchingDeliveryEvidence(noSelection, f.session, f.history), undefined)
    assert.equal(matchingDeliveryEvidence({ ...f.interaction, status: 'pending' }, f.session, f.history), undefined)
  })

  it('does not reuse the previous occurrence/attempt ACK for a new execution request on the same node', () => {
    const f = fixture()
    const next = { ...f.interaction, id: 'eng06-interaction-2', executionId: 'eng06-execution-2', nativeRequestId: 'eng06-request-2' }
    assert.equal(matchingDeliveryEvidence(next, f.session, f.history), undefined)
    assert.deepEqual(matchingDeliveryEvidence(f.interaction, f.session, f.history), f.proof)
  })

  it('accepts only the ordered original-connection command history as implicit consumption proof', () => {
    const f = fixture(), history: NativeHistory = { events: f.events, pendingInteractions: [] }
    assert.deepEqual(matchingDeliveryEvidence(f.interaction, f.session, history), { ...f.proof, source: 'provider_history' })
  })

  for (const index of [0, 1, 2, 3]) {
    it(`rejects a history proof spliced across backend connection generations at event ${index}`, () => {
      const f = fixture(), events = f.events.map((event, i) => i === index
        ? { ...event, connectionId: 'eng06-successor-connection' } : event)
      assert.equal(matchingDeliveryEvidence(f.interaction, f.session, { events, pendingInteractions: [] }), undefined)
    })
  }

  for (const missingType of ['interaction.pending', 'interaction.submitted', 'interaction.resolved', 'item.completed']) {
    it(`retains uncertainty when retained history is missing ${missingType}`, () => {
      const f = fixture(), events = f.events.filter((event) => event.type !== missingType)
      assert.equal(matchingDeliveryEvidence(f.interaction, f.session, { events, pendingInteractions: [] }), undefined)
    })
  }

  it('rejects out-of-order request resolution even if the command later completed', () => {
    const f = fixture(), events = f.events.map((event) => event.type === 'interaction.resolved' ? { ...event, sequence: 0 } : event)
    assert.equal(matchingDeliveryEvidence(f.interaction, f.session, { events, pendingInteractions: [] }), undefined)
  })

  it('rejects history for a different command item or turn rather than using the session latest result', () => {
    for (const mismatch of ['item', 'turn'] as const) {
      const f = fixture(), events = f.events.map((event) => event.type !== 'item.completed' ? event : {
        ...event, payload: mismatch === 'turn' ? { ...event.payload, turnId: 'later-turn' }
          : { ...event.payload, item: { ...(event.payload.item as Record<string, unknown>), id: 'later-item' } },
      })
      assert.equal(matchingDeliveryEvidence(f.interaction, f.session, { events, pendingInteractions: [] }), undefined)
    }
  })
})
