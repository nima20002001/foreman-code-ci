import type { OperatorConversationState } from '@foreman-code/contracts'
import {
  activityScopeKey, applyCanonicalActivityItems, reconcileActivitySnapshot,
  sourceVectorIsStale, sourceVectorHasAdvance,
} from '../conversations/agentChat/activityMerge'
import { mergeChatMessages } from '../conversations/agentChat/model'
import { boundedNativeWindow } from '../conversations/delivery/nativeMessageWindow'
import { mergeOperatorActivity, retainRecentOperatorActivity } from '../../shared/api/operatorActivity'

export function newerOperatorConversationState(current: OperatorConversationState | undefined,
  next: OperatorConversationState, source: 'read' | 'receipt' = 'receipt'): OperatorConversationState {
  if (current?.activitySnapshot && next.activitySnapshot
    && (activityScopeKey(current.activitySnapshot.scope) !== activityScopeKey(next.activitySnapshot.scope)
      || sourceVectorIsStale(current.activitySnapshot, next.activitySnapshot))) return current
  const currentRevision = current?.activitySnapshot?.revision ?? String(current?.revision ?? 0)
  const nextRevision = next.activitySnapshot?.revision ?? String(next.revision)
  const stale = BigInt(nextRevision) < BigInt(currentRevision)
  const keepCurrent = current && (current.activitySnapshot && !next.activitySnapshot
    || BigInt(currentRevision) >= BigInt(nextRevision))
  const accepted = current && keepCurrent ? current : next
  const activitySnapshot = next.activitySnapshot ? reconcileActivitySnapshot(current?.activitySnapshot,
    next.activitySnapshot, current?.activitySnapshot?.scope ?? next.activitySnapshot.scope) : current?.activitySnapshot
  const qualification = source === 'read' ? next : current ?? next
  const metadataFresh = source === 'read' || !!current?.activitySnapshot && !!next.activitySnapshot
    && sourceVectorHasAdvance(current.activitySnapshot, next.activitySnapshot)
  const incoming = stale ? [] : next.activities ?? []
  const previous = current?.activities ?? []
  const overlaps = incoming.some(entry => previous.some(known =>
    known.id === entry.id && known.requestId === entry.requestId))
  const disconnected = !stale && !!next.activityNextCursor && incoming.length > 0 && !overlaps
  const retained = retainRecentOperatorActivity(applyCanonicalActivityItems(
    mergeOperatorActivity(disconnected ? [] : previous, incoming), activitySnapshot))
  let activityNextCursor = current?.activityNextCursor ?? next.activityNextCursor
  if (retained.removed || disconnected) {
    activityNextCursor = retained.activities[0]?.sequence ?? next.activityNextCursor
  }
  const messages = stale || !metadataFresh && accepted === current ? accepted.messages : next.messages
  const window = boundedNativeWindow(mergeChatMessages(current?.messages ?? [], messages))
  return {
    ...accepted,
    ...(activitySnapshot ? { activitySnapshot } : {}),
    qualificationKey: qualification.qualificationKey,
    responseAvailability: qualification.responseAvailability,
    messages: window?.messages ?? accepted.messages,
    hasEarlierMessages: accepted.hasEarlierMessages || window?.omitted,
    activities: retained.activities,
    activityNextCursor,
  }
}
