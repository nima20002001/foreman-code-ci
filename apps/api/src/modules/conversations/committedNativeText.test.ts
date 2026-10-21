import { describe, expect, it, vi } from 'vitest'
import type { Message, NativeHarnessEvent } from '@foreman-code/contracts'
import type { ActivityTextOperation } from '@foreman-code/contracts/activity-text'
import type { PostgresOperatorConversationRepository } from './operatorChatRepository.js'
import { committedNativeText } from './committedNativeText.js'

const native = { harness: 'codex' as const, sessionId: 'session-a', turnId: 'turn-a', itemId: 'native-item-a' }
const owner = () => ({ scope: { kind: 'operator_chat' as const, conversationId: 'chat-a', requestId: 'request-a' },
  requestId: 'request-a', sessionId: native.sessionId, turnId: native.turnId })
const event = (sequence: number, text: string): NativeHarnessEvent => ({ connectionId: 'connection-a', sequence,
  occurredAt: '2026-10-01T00:00:00Z', type: 'assistant.delta', payload: { itemId: native.itemId, text } })
const saved = { id: 'durable-native-row', conversationId: 'chat-a', requestId: 'request-a', role: 'assistant',
  content: 'Committed text', nativeMessageId: native.itemId, activityNative: native, activityChannel: 'assistant',
  nativeMessageComplete: false, revision: '17', sequence: '9' } satisfies Message

describe('committed native text publisher boundary', () => {
  it('exposes only the durable replacement and keeps original native/message revisions after commit', async () => {
    let release!: () => void, observed: ActivityTextOperation | undefined
    const persisted = new Promise<void>(resolve => { release = resolve })
    const append: PostgresOperatorConversationRepository['appendAssistantTextOperation'] = async (conversationId, requestId, operation, fence) => {
      expect(conversationId).toBe('chat-a'); expect(requestId).toBe('request-a')
      expect(fence).toMatchObject({ nativeSessionId: native.sessionId, nativeTurnId: native.turnId })
      observed = operation; await persisted
      return { status: 'committed', revision: '31', messageRevision: saved.revision, message: saved }
    }
    const publisher = committedNativeText({ id: 'chat-a', requestId: 'request-a', repository: { appendAssistantTextOperation: append },
      harness: 'codex', session: { harness: 'codex', providerVersion: 'test', nativeSessionId: native.sessionId }, owner, reconcile: vi.fn() })
    const recording = publisher.record(event(1, 'uncommitted fragment'), native.turnId)
    expect(observed).toBeDefined(); expect(publisher.message(observed!)).toBeUndefined()
    release(); await expect(recording).resolves.toEqual({ allowed: true, handled: true, final: false })
    expect(publisher.message(observed!)).toEqual(saved)
    expect(publisher.revision()).toBe('31')
  })

  it('publishes a bounded explicit preview of a large final row, retaining exact identity for full readback', async () => {
    let observed: ActivityTextOperation | undefined
    const content = '😀'.repeat(20_000), message = { ...saved, content, nativeMessageComplete: true }
    const append: PostgresOperatorConversationRepository['appendAssistantTextOperation'] = async (_id, _request, operation) => {
      observed = operation; return { status: 'committed', revision: '32', messageRevision: message.revision, message }
    }
    const publisher = committedNativeText({ id: 'chat-a', requestId: 'request-a', repository: { appendAssistantTextOperation: append },
      harness: 'codex', session: { harness: 'codex', providerVersion: 'test', nativeSessionId: native.sessionId }, owner, reconcile: vi.fn() })
    await publisher.record({ ...event(2, ''), type: 'item.completed', payload: { item: { id: native.itemId, type: 'agentMessage', text: content } } }, native.turnId)
    const preview = publisher.message(observed!)!
    expect(preview).toMatchObject({ id: saved.id, nativeMessageId: saved.nativeMessageId, activityNative: native,
      revision: saved.revision, sequence: saved.sequence, nativeMessageComplete: true,
      truncation: { truncated: true, originalBytes: Buffer.byteLength(content) } })
    expect(Buffer.byteLength(preview.content)).toBeLessThanOrEqual(24 * 1024)
    expect(content.startsWith(preview.content)).toBe(true)
    expect(preview.content.endsWith('\ud83d')).toBe(false)
  })

  it('requests reconciliation without publishing uncommitted or ownerless text', async () => {
    let observed: ActivityTextOperation | undefined
    const append: PostgresOperatorConversationRepository['appendAssistantTextOperation'] = async (_id, _request, operation) => {
      observed = operation; return { status: 'reconciliation_required', revision: '30' }
    }
    const reconcile = vi.fn(), publisher = committedNativeText({ id: 'chat-a', requestId: 'request-a', repository: { appendAssistantTextOperation: append },
      harness: 'codex', session: { harness: 'codex', providerVersion: 'test', nativeSessionId: native.sessionId }, owner, reconcile })
    await expect(publisher.record(event(1, 'unproven append'), native.turnId)).resolves.toMatchObject({ allowed: false, handled: true })
    expect(publisher.message(observed!)).toBeUndefined(); expect(publisher.revision()).toBeUndefined()
    expect(reconcile).toHaveBeenCalledOnce()
    await publisher.record(event(2, 'missing turn'), null)
    expect(reconcile).toHaveBeenCalledTimes(2)
  })
})
