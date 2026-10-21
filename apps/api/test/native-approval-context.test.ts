import assert from 'node:assert/strict'
import { it } from 'vitest'
import type { NativeHarnessEvent, PendingNativeInteraction } from '@foreman-code/contracts'
import { nativeApprovalContext } from '../src/modules/interactions/nativeApprovalContext.js'

const pending: PendingNativeInteraction = {
  session: { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'session-a' },
  turn: { nativeTurnId: 'turn-a', nativeRequestId: 'request-a' },
  nativeRequestType: 'item/fileChange/requestApproval', request: { turnId: 'turn-a', itemId: 'item-a' },
  responseOptions: [{ optionId: 'approve', semantic: 'approve_once', label: 'Approve once', persistence: 'request',
    affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
}
const event: NativeHarnessEvent = { sequence: 49, type: 'item.started', occurredAt: '2026-09-19T00:00:00.000Z', payload: {
  threadId: 'session-a', turnId: 'turn-a', item: { id: 'item-a', type: 'fileChange', changes: [{
    path: '/workspace/source.ts', diff: '--- a/source.ts\n+++ b/source.ts\n@@ -1 +1 @@\n-old\n+new secret value',
  }] },
} }

it('shows structural context from the exact file-change item without storing patch values', () => {
  assert.deepEqual(nativeApprovalContext(pending, [event]), {
    target: '/workspace/source.ts', changeSummary: '1 file; 1 added, 1 removed lines. Patch contents are not shown here.',
  })
})

it('does not borrow an item from another native session, turn, or item', () => {
  for (const payload of [
    { ...event.payload, threadId: 'session-b' },
    { ...event.payload, turnId: 'turn-b' },
    { ...event.payload, item: { ...(event.payload.item as object), id: 'item-b' } },
  ]) assert.equal(nativeApprovalContext(pending, [{ ...event, payload }]), undefined)
})

it('leaves missing or ambiguous context unknown', () => {
  assert.equal(nativeApprovalContext(pending, []), undefined)
  assert.equal(nativeApprovalContext(pending, [event, { ...event, sequence: 50 }]), undefined)
  assert.equal(nativeApprovalContext({ ...pending, request: {} }, [event]), undefined)
})

it('does not report false zero line counts for a plain-content native add', () => {
  const plainAdd = { ...event, payload: { ...event.payload, item: { id: 'item-a', type: 'fileChange',
    changes: [{ path: '/workspace/new.txt', kind: { type: 'add' }, diff: 'approval recheck\n' }],
  } } }
  assert.deepEqual(nativeApprovalContext(pending, [plainAdd]), {
    target: '/workspace/new.txt',
    changeSummary: '1 file; line counts unavailable (native diff format). Patch contents are not shown here.',
  })
})

it('keeps the target while bounding oversized patches and change lists', () => {
  const baseItem = event.payload.item as { id: string; type: string; changes: { path: string; diff: string }[] }
  const oversized = { ...event, payload: { ...event.payload, item: { ...baseItem,
    changes: [{ path: '/workspace/large.ts', diff: `+${'x'.repeat(65_537)}` }],
  } } }
  assert.deepEqual(nativeApprovalContext(pending, [oversized]), {
    target: '/workspace/large.ts',
    changeSummary: '1 file; line counts unavailable (summary limit). Patch contents are not shown here.',
  })
  const many = { ...event, payload: { ...event.payload, item: { ...baseItem,
    changes: Array.from({ length: 101 }, (_, index) => ({ path: `/workspace/${index}.ts`, diff: '+value' })),
  } } }
  assert.deepEqual(nativeApprovalContext(pending, [many]), {
    target: '/workspace/0.ts, /workspace/1.ts, /workspace/2.ts, /workspace/3.ts, /workspace/4.ts, and 96 more change entries',
    changeSummary: '101 change entries; line counts unavailable (summary limit). Patch contents are not shown here.',
  })
})
