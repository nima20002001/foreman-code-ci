import { journalRequest, journalIntent } from './nim2644Journal.fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inFollowupTab, nim2644FollowupCases } from './nim2644Followup.cases'

import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { repairFixture } from './nim2644State.cases'
import { newNextDraft, nextDraftKey } from './state'
import { removeNode } from './model'
import { acknowledgeEditIntentSnapshot } from './useGraphEditIntent'
import { acknowledgeEditOutbox, editSnapshotAcknowledged, readEditOutbox, readEditSnapshot, readEditSubmission,
  reserveEditOutbox, storeEditSnapshot, type EditIntentOutbox } from './editIntentStorage'

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear() })
describe('NIM-2644 follow-up exact-command and independent-tab acknowledgement', () => {
  for (const { name, run } of nim2644FollowupCases) it(name, run)
})

// Storage failures must not mark an unmerged in-memory form as consumed.
// These cases use the real Storage and shared Zod boundaries in Vitest.

const scope = nextDraftKey('workspace', 'workflow')
function retainedDiscard() {
  const current = newNextDraft(repairFixture(3), 'storage-cut')
  current.graph = removeNode(current.graph, 'node-2')
  const outbox: EditIntentOutbox = { request: journalRequest(current, 'stage-storage'), target: current.graph }
  const intent = { ...journalIntent(outbox.request, current.context), state: 'discarded' as const }

  storeEditSnapshot(scope, current)
  return { current, outbox, intent }
}
describe('NIM-2644 follow-up storage failure cuts', () => {
  it.each(['snapshot', 'latest'] as const)('does not consume a form when the %s write fails; exact retry restores it', (cut) => {
    inFollowupTab('A', () => {
      const { current, outbox, intent } = retainedDiscard()
      reserveEditOutbox(scope, outbox)
      const before = readEditSnapshot(scope)
      const name = cut === 'snapshot' ? protectedKey('draft', `graph-edit-intent:${scope}:A`)
        : protectedKey('ui', `graph-edit-intent:${scope}:latest`)
      const original = Storage.prototype.setItem
      const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (key === name) throw new Error('Synthetic durable write failure')
        original.call(this, key, value)
      })
      expect(() => acknowledgeEditIntentSnapshot(scope, current, intent)).toThrow('Durable edit storage')
      expect(editSnapshotAcknowledged(scope, current, intent.stageCommandId)).toBe(false)
      expect(readEditSnapshot(scope)).toEqual(before); expect(readEditOutbox(scope)).toEqual(outbox)
      write.mockRestore()
      const acknowledged = acknowledgeEditIntentSnapshot(scope, current, intent)
      expect(acknowledged.graph.nodes).toEqual(current.context.draft.graph.nodes)
      expect(editSnapshotAcknowledged(scope, acknowledged, intent.stageCommandId)).toBe(true)
    })
  })
  it('refuses to consume an older outbox if its only submission copy cannot be retained', () => {
    inFollowupTab('A', () => {
      const { current, outbox, intent } = retainedDiscard()
      localStorage.setItem(protectedKey('outbox', `graph-edit-intent:${scope}`), JSON.stringify(outbox))
      const before = readEditSnapshot(scope)
      const original = Storage.prototype.setItem
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (key.includes(encodeURIComponent('graph-edit-intent:submission:'))) throw new Error('Submission archive unavailable')
        original.call(this, key, value)
      })
      expect(() => acknowledgeEditIntentSnapshot(scope, current, intent)).toThrow('Durable edit storage')
      expect(() => acknowledgeEditOutbox(scope, intent.stageCommandId)).toThrow('Durable edit storage')
      expect(readEditOutbox(scope)).toEqual(outbox); expect(readEditSnapshot(scope)).toEqual(before)
    })
  })
  it('does not reserve an outgoing Stage without durable submission evidence', () => {
    inFollowupTab('A', () => {
      const { outbox } = retainedDiscard(), before = readEditSnapshot(scope)
      const original = Storage.prototype.setItem
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (key.includes(encodeURIComponent('graph-edit-intent:submission:'))) throw new Error('Submission archive unavailable')
        original.call(this, key, value)
      })
      expect(() => reserveEditOutbox(scope, outbox)).toThrow('Durable edit storage')
      expect(readEditOutbox(scope)).toBeUndefined(); expect(readEditSnapshot(scope)).toEqual(before)
    })
  })
  it('keeps malformed submission evidence rather than falling back to an unrelated local form', () => {
    inFollowupTab('A', () => {
      const { current, outbox, intent } = retainedDiscard()
      reserveEditOutbox(scope, outbox)
      const name = protectedKey('ui', `graph-edit-intent:submission:${JSON.stringify([scope, outbox.request.commandId])}`)
      localStorage.setItem(name, '{malformed')
      expect(() => readEditSubmission(scope, intent)).toThrow('not been deleted')
      expect(() => acknowledgeEditIntentSnapshot(scope, current, intent)).toThrow('not been deleted')
      expect(readEditOutbox(scope)).toEqual(outbox); expect(localStorage.getItem(name)).toBe('{malformed')
    })
  })
})
