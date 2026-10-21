import { describe, expect, it } from 'vitest'
import { matchingDeliveryEvidence, responseValueDigest, type NativeResponseDeliveryEvidence } from '../src/modules/interactions/delivery.js'
import { deliveryFixture } from './helpers/wave25ApprovalFixture.js'

const event = (sequence: number, type: string, payload: Record<string, unknown>, connectionId = 'codex-connection') => ({
  sequence, connectionId, type, payload, occurredAt: `2026-09-21T00:00:${String(sequence).padStart(2, '0')}.000Z`,
})

function codexExecutionHistory() {
  const f = deliveryFixture()
  f.interaction.providerVersion = f.session.providerVersion = 'codex-cli 0.154.0'
  f.interaction.nativeRequestType = 'item/commandExecution/requestApproval'
  f.interaction.request = { kind: 'command', itemId: 'command-item', turnId: 'turn-worker',
    threadId: f.session.nativeSessionId, command: '/bin/bash -lc pwd', cwd: '/workspace' }
  f.history.responseDeliveries = []
  f.history.events = [
    event(1, 'interaction.pending', { nativeRequestId: f.interaction.nativeRequestId,
      nativeRequestType: f.interaction.nativeRequestType, turnId: 'turn-worker' }),
    event(2, 'interaction.submitting', { nativeRequestId: f.interaction.nativeRequestId,
      optionId: f.interaction.selectedOptionId }),
    event(3, 'interaction.submitted', { nativeRequestId: f.interaction.nativeRequestId,
      optionId: f.interaction.selectedOptionId, semantic: f.interaction.selectedSemantic,
      responseDigest: responseValueDigest(undefined) }),
    event(4, 'interaction.resolved', { nativeRequestId: f.interaction.nativeRequestId,
      submittedOptionId: f.interaction.selectedOptionId, evidence: 'serverRequest/resolved' }),
    event(5, 'item.completed', { threadId: f.session.nativeSessionId, turnId: 'turn-worker', item: {
      id: 'command-item', type: 'commandExecution', status: 'completed', command: '/bin/bash -lc pwd',
      cwd: '/workspace', exitCode: 0, aggregatedOutput: '/workspace\n',
    } }),
  ]
  return f
}

describe('Exact native approval delivery evidence', () => {
  it('accepts only the exact persisted decision and session receipt', () => {
    const f = deliveryFixture()
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toEqual(f.proof)
  })
  it('treats duplicate identical receipts as the same evidence', () => {
    const f = deliveryFixture()
    f.history.responseDeliveries = [f.proof, { ...f.proof, source: 'provider_history' }]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toEqual(f.proof)
  })
  it.each([false, true])('rejects conflicting decision receipts regardless of arrival order, reverse=%s', (reverse) => {
    const f = deliveryFixture()
    const conflict: NativeResponseDeliveryEvidence = { ...f.proof, optionId: 'reject', semantic: 'reject' }
    f.history.responseDeliveries = reverse ? [conflict, f.proof] : [f.proof, conflict]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toBeUndefined()
  })
  it('does not accept one request type over a conflicting type with the same native identity', () => {
    const f = deliveryFixture()
    f.history.responseDeliveries = [f.proof, { ...f.proof, nativeRequestType: 'other-request-type' }]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toBeUndefined()
  })
  const mismatches: Array<[string, Partial<NativeResponseDeliveryEvidence>]> = [
    ['provider', { harness: 'claude' }], ['version', { providerVersion: 'other-version' }],
    ['session', { nativeSessionId: 'other-session' }], ['request', { nativeRequestId: 'other-request' }],
    ['request type', { nativeRequestType: 'other-type' }], ['option', { optionId: 'other-option' }], ['decision', { semantic: 'reject' }],
  ]
  it.each(mismatches)('denies a mismatched %s receipt', (_name, patch) => {
    const f = deliveryFixture()
    f.history.responseDeliveries = [{ ...f.proof, ...patch }]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toBeUndefined()
  })
  it('does not equate terminal work, connection closure, or an empty pending list with delivery', () => {
    const f = deliveryFixture()
    f.history.responseDeliveries = []
    f.history.terminalResult = { outcome: 'succeeded' }
    f.history.events = [{ type: 'transport.closed', sequence: 0, occurredAt: f.interaction.createdAt, payload: {} }]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toBeUndefined()
  })
  it('retains uncertainty when the exact request is still pending', () => {
    const f = deliveryFixture()
    f.history.pendingInteractions = [{ session: f.session, turn: { nativeTurnId: 'turn-worker', nativeRequestId: f.interaction.nativeRequestId },
      nativeRequestType: f.interaction.nativeRequestType, request: {}, responseOptions: f.interaction.responseOptions }]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toBeUndefined()
  })
  it('does not conflate a different pending review with this request', () => {
    const f = deliveryFixture()
    f.history.pendingInteractions = [{ session: f.session, turn: { nativeTurnId: 'other-turn', nativeRequestId: 'different-request' },
      nativeRequestType: f.interaction.nativeRequestType, request: {}, responseOptions: f.interaction.responseOptions }]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toEqual(f.proof)
  })
  it('rejects evidence before a decision and does not mutate any durable fact', () => {
    const f = deliveryFixture()
    const before = structuredClone(f.interaction)
    matchingDeliveryEvidence(f.interaction, f.session, f.history)
    expect(f.interaction).toEqual(before)
    const pending = { ...f.interaction, status: 'pending' as const }
    delete pending.selectedOptionId
    delete pending.selectedSemantic
    delete pending.nativeResponse
    delete pending.decidedAt
    expect(matchingDeliveryEvidence(pending, f.session, f.history)).toBeUndefined()
  })
  it('qualifies the exact Codex response only after its gated command executes', () => {
    const f = codexExecutionHistory()
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toEqual({
      ...f.proof, source: 'provider_history', providerVersion: 'codex-cli 0.154.0',
      nativeRequestType: 'item/commandExecution/requestApproval',
    })
  })
  it.each(['reject', 'cancel'] as const)('never infers a positive Codex receipt for %s from command execution', (semantic) => {
    const f = codexExecutionHistory()
    f.interaction.selectedSemantic = semantic
    f.interaction.selectedOptionId = `codex-${semantic}`
    f.history.events[1]!.payload.optionId = f.interaction.selectedOptionId
    f.history.events[2]!.payload.semantic = semantic
    f.history.events[2]!.payload.optionId = f.interaction.selectedOptionId
    f.history.events[3]!.payload.submittedOptionId = f.interaction.selectedOptionId
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toBeUndefined()
  })
  it.each([
    ['missing provider resolution', (f: ReturnType<typeof codexExecutionHistory>) => { f.history.events = f.history.events.filter((e) => e.type !== 'interaction.resolved') }],
    ['cleared without execution', (f: ReturnType<typeof codexExecutionHistory>) => { f.history.events = f.history.events.filter((e) => e.type !== 'item.completed') }],
    ['different option', (f: ReturnType<typeof codexExecutionHistory>) => { f.history.events[2]!.payload.optionId = 'other-option' }],
    ['different connection', (f: ReturnType<typeof codexExecutionHistory>) => { f.history.events[4]!.connectionId = 'other-connection' }],
    ['non-executed item', (f: ReturnType<typeof codexExecutionHistory>) => { (f.history.events[4]!.payload.item as Record<string, unknown>).exitCode = null }],
  ])('does not qualify Codex history with %s', (_name, change) => {
    const f = codexExecutionHistory(); change(f)
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toBeUndefined()
  })
})
