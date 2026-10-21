import { describe, expect, it } from 'vitest'
import type { ActivityItem, ActivitySnapshotV1 } from '@foreman-code/contracts/activity'
import { activityScopeKey, reconcileActivityScopes, reconcileActivitySnapshot } from './activityMerge'
const scope = { kind: 'operator_chat' as const, conversationId: 'chat-a' }
const text = (id: string, revision: string, content: string, final = false): ActivityItem => ({ id, revision, order: id === 'old' ? '1' : '2', owner: { kind: 'chat_request', conversationId: 'chat-a', requestId: 'request-a' }, source: { schemaVersion: 1, system: 'test', observedAt: '2026-10-01T00:00:00Z' }, evidence: 'confirmed', kind: 'text', text: content, finality: final ? 'authoritative_final' : 'provisional' })
const snapshot = (revision: string, activities: ActivityItem[] = []): ActivitySnapshotV1 => ({ schemaVersion: 1, scope, revision, active: [], queued: [], latest: null, pendingInteractions: [], activities, page: { before: null, nextCursor: null, hasMore: false } })
describe('scope and entity revision reconciliation', () => {
  it('stale history fills absent entries while preserving active A/newer queued B and current page', () => {
    const current = snapshot('12', [text('live', '8', 'final', true)])
    current.active = [{ ref: { kind: 'chat_request', conversationId: 'chat-a', requestId: 'A' }, phase: 'active', outcome: null, delivery: 'accepted', evidence: 'confirmed', startedAt: null }]
    current.queued = [{ kind: 'chat_request', conversationId: 'chat-a', requestId: 'B' }]; current.latest = current.queued[0]!
    const merged = reconcileActivitySnapshot(current, snapshot('11', [text('old', '1', 'historical'), text('live', '7', 'partial')]), scope)!
    expect(merged.active).toEqual(current.active); expect(merged.queued).toEqual(current.queued); expect(merged.latest).toEqual(current.latest)
    expect(merged.revision).toBe('12'); expect(merged.activities.map((item) => item.id)).toEqual(['old', 'live'])
    expect(merged.activities[1]).toEqual(current.activities[0])
  })
  it('accepts shorter/empty finals but refuses lower item revisions and late provisional text', () => {
    let current = snapshot('1', [text('live', '1', 'long provisional')])
    current = reconcileActivitySnapshot(current, snapshot('2', [text('live', '2', '', true)]), scope)!
    current = reconcileActivitySnapshot(current, snapshot('3', [text('live', '3', 'late')]), scope)!
    expect(current.activities[0]).toEqual(text('live', '2', '', true))
    current = reconcileActivitySnapshot(current, snapshot('4', [text('live', '1', 'old', true)]), scope)!
    expect(current.activities[0]).toEqual(text('live', '2', '', true))
  })
  it('rejects old selection scopes and bounds history without comparing board counters', () => {
    const current = snapshot('100', [text('live', '1', 'a')])
    const other = { ...snapshot('1'), scope: { ...scope, conversationId: 'chat-b' } }
    expect(reconcileActivitySnapshot(current, other, scope)).toBe(current)
    const vector = reconcileActivityScopes(new Map([[activityScopeKey(scope), current]]), other)
    expect(vector.size).toBe(2); expect(vector.get(activityScopeKey(scope))!.revision).toBe('100')
    const bounded = reconcileActivitySnapshot(current, snapshot('101', [text('old', '1', 'b')]), scope, 1)!
    expect(bounded.activities.map((item) => item.id)).toEqual(['live'])
  })
  it('equal revisions retain canonical entity content and work state', () => {
    const current = snapshot('4', [text('live', '2', 'same', true)])
    expect(reconcileActivitySnapshot(current, snapshot('4', [text('live', '2', 'different', true)]), scope)!.activities).toEqual(current.activities)
  })
})

describe('live tool and large revision history', () => {
  it('keeps live tool updates when older history pages arrive and compares decimal revisions exactly', () => {
    const base = text('live', '9007199254740993', '')
    const tool: ActivityItem = { id: base.id, revision: base.revision, order: base.order, owner: base.owner, source: base.source, evidence: base.evidence, kind: 'tool', title: 'Read file', status: 'running' }
    const current = snapshot('9007199254740993', [tool])
    const older: ActivityItem = { ...tool, revision: '9007199254740992', status: 'pending' }
    const merged = reconcileActivitySnapshot(current, snapshot('9007199254740992', [older, text('old', '1', 'past')]), scope)!
    expect(merged.revision).toBe(current.revision)
    expect(merged.activities.find((item) => item.id === 'live')).toEqual(tool)
  })
  it('treats the same structural scope as one revision-vector entry regardless of property insertion order', () => {
    const current = snapshot('4')
    const incoming = { ...snapshot('5'), scope: { conversationId: scope.conversationId, kind: scope.kind } }
    const merged = reconcileActivityScopes(new Map([[activityScopeKey(scope), current]]), incoming)
    expect(merged.size).toBe(1); expect(merged.get(activityScopeKey(scope))!.revision).toBe('5')
  })
})

it('independent source revisions cannot lower current owners when an unrelated counter increases', () => {
  const current = snapshot('10'); current.sourceRevisions = [{ source: 'execution', id: 'attempt-A', revision: '7' }]
  const olderDependency = snapshot('11'); olderDependency.sourceRevisions = [{ source: 'execution', id: 'attempt-A', revision: '6' }]
  expect(reconcileActivitySnapshot(current, olderDependency, scope)!.revision).toBe('10')
})

for (const source of ['execution', 'native_events', 'file', 'command'] as const) it(`accepts independently advanced ${source} at equal scope revision`, () => {
  const current = snapshot('4')
  current.active = [{ ref: { kind: 'chat_request', conversationId: 'chat-a', requestId: 'A' }, phase: 'active', outcome: null, delivery: 'accepted', evidence: 'confirmed', startedAt: null }]
  current.sourceRevisions = [{ source, id: 'independent', revision: '1' }]
  const incoming = snapshot('4'); incoming.sourceRevisions = [{ source, id: 'independent', revision: '2' }]
  const merged = reconcileActivitySnapshot(current, incoming, scope)!
  expect(merged.active).toEqual([]); expect(merged.sourceRevisions).toEqual(incoming.sourceRevisions)
})
it('advances command interaction delivery using its own vector even when scope/item revisions stay equal', () => {
  const summary = { id: 'approval', revision: '4', owner: { kind: 'chat_request' as const, conversationId: 'chat-a', requestId: 'A' },
    sourceRevisions: [{ source: 'command' as const, id: 'receipt', revision: '1' }], delivery: 'uncertain' as const,
    answerRecorded: true, providerAcknowledged: false, workerAcknowledged: false, responseAvailability: 'unknown' as const }
  const item: ActivityItem = { id: summary.id, revision: '4', order: '0', owner: summary.owner,
    source: { schemaVersion: 1, system: 'management_command_receipt', observedAt: null }, evidence: 'reconciling', kind: 'interaction', interaction: summary }
  const current = snapshot('4', [item]); current.sourceRevisions = summary.sourceRevisions; current.pendingInteractions = [summary]
  const delivered = { ...summary, sourceRevisions: [{ ...summary.sourceRevisions[0]!, revision: '2' }], delivery: 'delivered' as const, providerAcknowledged: true }
  const incoming = snapshot('4', [{ ...item, evidence: 'confirmed', interaction: delivered }]); incoming.sourceRevisions = delivered.sourceRevisions
  expect(reconcileActivitySnapshot(current, incoming, scope)!.activities[0]).toMatchObject({ interaction: { delivery: 'delivered', providerAcknowledged: true } })
  expect(reconcileActivitySnapshot(current, incoming, scope)!.pendingInteractions).toEqual([])
  const mixed = { ...incoming, sourceRevisions: [...delivered.sourceRevisions, { source: 'file' as const, id: 'file', revision: '1' }] }
  current.sourceRevisions = [...summary.sourceRevisions, { source: 'file', id: 'file', revision: '2' }]
  const reconciled = reconcileActivitySnapshot(current, mixed, scope)!
  expect(reconciled.sourceRevisions).toEqual(current.sourceRevisions)
  expect(reconciled.pendingInteractions).toEqual([])
  expect(reconciled.activities[0]).toMatchObject({ interaction: { delivery: 'delivered' } })
})

it('accepts file state changes at equal scope using the immutable file source revision', () => {
  const base = text('publication:receipt', '7', '')
  const item: ActivityItem = { id: base.id, revision: '7', order: '2', owner: base.owner, source: base.source, evidence: 'confirmed',
    kind: 'file_publication', receiptId: 'receipt', fileId: 'file', status: 'ready' }
  const current = snapshot('4', [item]); current.sourceRevisions = [{ source: 'file', id: 'file', revision: '7' }]
  const incoming = snapshot('4', [{ ...item, revision: '8', status: 'unknown' }]); incoming.sourceRevisions = [{ source: 'file', id: 'file', revision: '8' }]
  expect(reconcileActivitySnapshot(current, incoming, scope)!.activities[0]).toMatchObject({ revision: '8', status: 'unknown' })
  expect(reconcileActivitySnapshot(incoming, current, scope)!.activities[0]).toMatchObject({ revision: '8', status: 'unknown' })
})
