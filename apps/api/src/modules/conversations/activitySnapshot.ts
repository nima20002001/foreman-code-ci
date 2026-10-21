import { ActivitySnapshotV1Schema, projectActivityStatus, type ActivitySnapshotV1, type WorkRef, type WorkSummary } from '@foreman-code/contracts'
import { conversationActivityId, conversationActivityKey, publicActivityProvenance } from './activityIdentity.js'
import { chatInteractionSummary, conversationPublicationItems, conversationTextItems, messageSourceRevisions } from './activityItems.js'
import { agentActivityScope, type PostgresAgentChatRepository } from './agentChatRepository.js'

type State = NonNullable<Awaited<ReturnType<PostgresAgentChatRepository['state']>>>
/** Adapt existing receipt ownership; neither latest message nor provider session confers ownership. */
export function agentActivitySnapshot(loaded: State): ActivitySnapshotV1 {
  const { row, turns } = loaded
  const ref = (requestId: string): WorkRef => ({ kind: 'chat_request', conversationId: row.id, requestId })
  const owner = row.active_request_id ? ref(row.active_request_id) : null
  const native = row.native_session_id ? { harness: row.harness, sessionId: row.native_session_id,
    ...(row.active_native_turn_id ? { turnId: row.active_native_turn_id } : {}) } : undefined
  const scope = agentActivityScope(loaded)
  const work: WorkSummary[] = owner ? [{ ref: owner,
    phase: row.cancel_requested ? 'interrupting' : row.pending_interaction ? 'waiting' : row.turn_state === 'starting' ? 'preparing' : 'active',
    outcome: null, delivery: turns.find((turn) => turn.requestId === row.active_request_id)?.delivery ?? 'unknown',
    evidence: row.turn_state === 'uncertain' ? 'reconciling' : 'confirmed', startedAt: loaded.activeStartedAt?.toISOString() ?? null,
    ...(native ? { native } : {}) }] : []
  for (const activity of loaded.unfinishedActivities) {
    if (activity.kind === 'thinking' || !['pending', 'running', 'unknown'].includes(activity.status)) continue
    work.push({ ref: { kind: activity.kind === 'subagent' ? 'subagent' : 'tool', itemId: conversationActivityId(row.id, activity.requestId, activity.id) },
      phase: 'active', outcome: null, delivery: null, evidence: activity.status === 'unknown' ? 'unknown' : 'confirmed', startedAt: null })
  }
  return ActivitySnapshotV1Schema.parse({ schemaVersion: 1, scope, revision: String(row.revision),
    sourceRevisions: [{ source: 'scope', id: row.id, revision: String(row.revision) }, ...(loaded.commandActivity?.sourceRevisions ?? []), ...messageSourceRevisions(loaded.messages), ...(loaded.fileSourceRevisions ?? []),
      ...(loaded.publicationReceipts ?? []).flatMap((receipt) => [{ source: 'publication', id: receipt.receiptId, revision: '0' },
        { source: 'file', id: receipt.fileId, revision: receipt.fileActivityRevision }])],
    ...projectActivityStatus({ work, queued: turns.filter((turn) => turn.delivery === 'queued').map((turn) => ref(turn.requestId)),
      latest: loaded.latestRequestId ? ref(loaded.latestRequestId) : null }),
    ...(loaded.hasMoreActivities ? { hasMoreActiveWork: true } : {}),
    // Native callback availability is qualified separately by C; a pending callback is not a durable interaction receipt.
    ...(loaded.commandActivity?.hasMore ? { hasMorePendingInteractions: true } : {}),
    pendingInteractions: [...new Map([...chatInteractionSummary({ conversationId: row.id, requestId: row.active_request_id, revision: String(row.revision), pending: row.pending_interaction }),
      ...(loaded.commandActivity?.summaries ?? [])].map((summary) => [summary.id, summary])).values()].filter((summary) => summary.delivery !== 'delivered'),
    activities: [...(loaded.commandActivity?.summaries ?? []).map((summary) => ({ kind: 'interaction', id: summary.id, revision: summary.revision,
      order: '0', owner: summary.owner, source: { schemaVersion: 1, system: 'management_command_receipt', observedAt: null },
      evidence: summary.delivery === 'uncertain' ? 'reconciling' : 'confirmed', interaction: summary })), ...conversationPublicationItems(row.id, loaded.messages, loaded.publicationReceipts ?? []), ...conversationTextItems(row.id, loaded.messages, { harness: row.harness, sessionId: row.native_session_id,
      turnIdFor: (requestId) => turns.find((turn) => turn.requestId === requestId)?.nativeTurnId }), ...loaded.activityPage.activities.map((activity) => ({
      id: conversationActivityId(row.id, activity.requestId, activity.id), ...publicActivityProvenance(loaded.activityPage.itemProvenance?.[conversationActivityKey(activity.requestId, activity.id)]), orderSource: 'conversation_activity', revision: loaded.activityPage.itemRevisions[conversationActivityKey(activity.requestId, activity.id)] ?? String(activity.revision), order: activity.sequence, owner: ref(activity.requestId),
      source: { schemaVersion: 1, system: 'conversation_record', observedAt: null },
      evidence: activity.status === 'unknown' ? 'unknown' : 'confirmed',
      ...(activity.kind === 'thinking' ? { kind: 'reasoning_summary', summary: activity.title }
        : { kind: activity.kind === 'subagent' ? 'subagent' : 'tool', toolKind: activity.kind, title: activity.title, status: activity.status }),
    }))],
    page: { before: null, nextCursor: loaded.activityPage.nextCursor, hasMore: loaded.activityPage.nextCursor !== null },
  })
}
