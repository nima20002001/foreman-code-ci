import { ActivitySnapshotV1Schema, projectActivityStatus, type ActivitySnapshotV1, type WorkRef, type WorkSummary } from './activity.js'
const a: WorkRef = { kind: 'chat_request', conversationId: 'conversation', requestId: 'A' }
const b: WorkRef = { kind: 'chat_request', conversationId: 'conversation', requestId: 'B' }
const child: WorkRef = { kind: 'subagent', itemId: 'child' }
const summary = (ref: WorkRef, phase: WorkSummary['phase'], evidence: WorkSummary['evidence'] = 'confirmed'): WorkSummary => ({
  ref, phase, outcome: null, delivery: 'accepted', evidence, startedAt: '2026-10-01T00:00:00.000Z',
})
function snapshot(work: WorkSummary[], queued: WorkRef[] = [], latest: WorkRef | null = a): ActivitySnapshotV1 {
  return ActivitySnapshotV1Schema.parse({ schemaVersion: 1, scope: { kind: 'operator_chat', conversationId: 'conversation' }, revision: '12',
    ...projectActivityStatus({ work, queued, latest }), pendingInteractions: [], activities: [], page: { before: null, nextCursor: null, hasMore: false } })
}
export const activitySnapshotFixtures = {
  idle: snapshot([], [], null),
  activeBeforeNewerQueued: snapshot([summary(a, 'active')], [b], b),
  waiting: snapshot([summary(a, 'waiting')]),
  interrupting: snapshot([summary(a, 'interrupting')]),
  uncertainDelivery: snapshot([{ ...summary(a, 'preparing', 'reconciling'), delivery: 'unknown' }]),
  terminalParentUnresolvedChild: snapshot([{ ...summary(a, 'terminal'), outcome: 'succeeded', delivery: 'completed' }, summary(child, 'active', 'unknown')]),
}
