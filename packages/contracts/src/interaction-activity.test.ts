import { describe, expect, it } from 'vitest'
import { AcceptedChatResponseControlSchema, ChatResponseAcknowledgmentSchema, matchingChatResponseAcknowledgment } from './interaction-activity.js'

const control = {
  schemaVersion: 1, kind: 'respond', conversationId: 'conversation', modelRequestId: 'request',
  scope: { kind: 'operator_chat', conversationId: 'conversation' },
  native: { harness: 'codex', providerVersion: 'pinned', sessionId: 'session', turnId: 'turn', requestId: 'native-request', requestType: 'approval' },
  choice: { optionId: 'allow', semantic: 'approve_once' },
}
describe('accepted native response identity', () => {
  it('requires an observed Codex turn', () => {
    expect(AcceptedChatResponseControlSchema.safeParse(control).success).toBe(true)
    expect(AcceptedChatResponseControlSchema.safeParse({ ...control, native: { ...control.native, turnId: undefined } }).success).toBe(false)
    expect(AcceptedChatResponseControlSchema.safeParse({ ...control, native: { ...control.native, turnId: undefined, messageId: 'message', generation: 'callback' } }).success).toBe(false)
  })
  it('retains Claude message and callback generation without inventing a turn', () => {
    const native = { ...control.native, harness: 'claude', turnId: undefined, messageId: 'actual-message', generation: 'actual-callback' }
    expect(AcceptedChatResponseControlSchema.parse({ ...control, native }).native).toMatchObject({ messageId: 'actual-message', generation: 'actual-callback' })
    for (const missing of ['messageId', 'generation']) {
      expect(AcceptedChatResponseControlSchema.safeParse({ ...control, native: { ...native, [missing]: undefined } }).success).toBe(false)
    }
    expect(AcceptedChatResponseControlSchema.safeParse({ ...control, native: { ...native, turnId: 'actual-message' } }).success).toBe(false)
  })
  it('rejects a receipt from another conversation scope', () => {
    expect(AcceptedChatResponseControlSchema.safeParse({ ...control, scope: { ...control.scope, conversationId: 'other' } }).success).toBe(false)
  })
  it('matches Claude delivery to the accepted message and callback generation', () => {
    const accepted = AcceptedChatResponseControlSchema.parse({ ...control, native: { ...control.native, harness: 'claude',
      turnId: undefined, messageId: 'message', generation: 'generation' } })
    const proof = { source: 'provider_history', harness: 'claude', providerVersion: 'pinned', nativeSessionId: 'session',
      nativeRequestId: 'native-request', nativeRequestType: 'approval', optionId: 'allow', semantic: 'approve_once',
      nativeIdentity: { kind: 'message', nativeMessageId: 'message', generation: 'generation' } }
    expect(matchingChatResponseAcknowledgment(accepted, proof)).toEqual(proof)
    expect(ChatResponseAcknowledgmentSchema.safeParse({ ...proof, nativeIdentity: undefined }).success).toBe(false)
    for (const identity of [{ kind: 'turn', nativeTurnId: 'message' },
      { ...proof.nativeIdentity, nativeMessageId: 'other' }, { ...proof.nativeIdentity, generation: 'other' }]) {
      expect(matchingChatResponseAcknowledgment(accepted, { ...proof, nativeIdentity: identity })).toBeUndefined()
    }
  })
})
