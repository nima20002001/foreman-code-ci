import { describe, expect, it, vi } from 'vitest'
import type { Message } from '@foreman-code/contracts'
import type { ConversationAttachments, AttachmentSendSnapshot } from '../attachments'
import { messageAttachmentRefs, prepareChatAttachments, sameAttachmentRefs } from './chatAttachmentAttempt'

function draft(snapshot: AttachmentSendSnapshot | null, acknowledgeSent = vi.fn()): ConversationAttachments {
  return { items: [], readyRefs: [], hasAttachments: true, hasBlockingAttachments: snapshot === null,
    isUploading: snapshot === null, available: true, canAdd: true,
    addFiles() {}, remove() {}, retry() {}, prepareSend: () => snapshot, acknowledgeSent }
}

describe('FIL-13 command attachment capture', () => {
  it('treats omitted and empty pins alike, but compares revision and order', () => {
    const a = { fileId: 'a', revisionId: 'r1' }, b = { fileId: 'b', revisionId: 'r2' }
    expect(sameAttachmentRefs(undefined, [])).toBe(true)
    expect(sameAttachmentRefs([a], [{ ...a }])).toBe(true)
    expect(sameAttachmentRefs([a], [{ ...a, revisionId: 'r3' }])).toBe(false)
    expect(sameAttachmentRefs([a, b], [b, a])).toBe(false)
    expect(sameAttachmentRefs([a], [])).toBe(false)
  })

  it('uses the persisted historical revision, never currentRevisionId', () => {
    const message = { attachments: [{ file: { currentRevisionId: 'new-head' },
      revision: { fileId: 'a', revisionId: 'old-pin' } }] } as Pick<Message, 'attachments'>
    expect(messageAttachmentRefs(message)).toEqual([{ fileId: 'a', revisionId: 'old-pin' }])
    expect(messageAttachmentRefs({})).toEqual([])
  })

  it('cannot capture a pending upload and does not clear merely by preparing a send', () => {
    const ack = vi.fn()
    expect(prepareChatAttachments(draft(null, ack))).toBeNull()
    expect(ack).not.toHaveBeenCalled()
    const captured = prepareChatAttachments(draft({ attachments: [{ fileId: 'a', revisionId: 'r1' }] }, ack))
    expect(captured?.attachments).toEqual([{ fileId: 'a', revisionId: 'r1' }])
    expect(ack).not.toHaveBeenCalled()
  })

  it('acknowledges the exact opaque snapshot from A after the caller switches to B', () => {
    const a = { attachments: [{ fileId: 'a', revisionId: 'r1' }] }
    const ackA = vi.fn(), ackB = vi.fn()
    const captured = prepareChatAttachments(draft(a, ackA))!
    prepareChatAttachments(draft({ attachments: [{ fileId: 'b', revisionId: 'r2' }] }, ackB))
    captured.acknowledge?.()
    expect(ackA).toHaveBeenCalledWith(a)
    expect(ackA.mock.calls[0][0]).toBe(a) // FIL-11 uses a WeakMap; a cloned snapshot cannot clear it.
    expect(ackB).not.toHaveBeenCalled()
  })

  it('rejects a same-frame stale attachment-only handler after its receipt clears the selection', () => {
    let current: AttachmentSendSnapshot = { attachments: [{ fileId: 'a', revisionId: 'r1' }] }
    const local = { ...draft(current), prepareSend: () => current }
    const captured = prepareChatAttachments(local)!
    expect(captured.isCurrent?.()).toBe(true)
    current = { attachments: [] }
    expect(captured.isCurrent?.()).toBe(false)
    // A pre-paint hook still reports hasAttachments, but it cannot capture the empty current draft.
    expect(prepareChatAttachments(local)).toBeNull()
  })

  it('leaves first-message conversation creation available for text-only input', () => {
    const prepare = vi.fn(() => null)
    const empty = { ...draft(null), available: false, hasAttachments: false, prepareSend: prepare }
    expect(prepareChatAttachments(empty)).toEqual({ attachments: [] })
    expect(prepare).not.toHaveBeenCalled()
  })
})
