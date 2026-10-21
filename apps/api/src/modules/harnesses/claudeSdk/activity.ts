import type { ActivityChangeEnvelopeV1, ActivityOwner } from '@foreman-code/contracts'
import type { ActivityItem, ActivityNativeIdentity, ActivitySource, WorkRef } from '@foreman-code/contracts/activity'
import type { ClaudeDecodedEvent, ClaudeEventOwner } from './normalization.js'

export interface ClaudeActivityContext {
  owner: ActivityOwner
  /** Captured by admission; a stale decoder cannot mutate a newer attempt. */
  fence: ClaudeEventOwner
  /** Item order/revision come from the existing durable writer. */
  revision: string
  order: string
}
const toolTitles: Record<string, string> = { Read: 'Read file', Glob: 'Find files', Grep: 'Search files', Write: 'Write file', Edit: 'Edit file', Bash: 'Run command', Agent: 'Run subagent', Task: 'Run subagent', WebSearch: 'Search web', WebFetch: 'Read webpage' }
export const claudeToolTitle = (name: string | undefined): string => toolTitles[name ?? ''] ?? 'Use tool'

/** Supplies provider facts to W05, never changes a receipt or a Run outcome.
 * No local arrival counter is passed off as a native source sequence. */
export function claudeActivityChange(event: ClaudeDecodedEvent, context: ClaudeActivityContext): ActivityChangeEnvelopeV1 | undefined {
  const evidence = event.evidence
  if (evidence.owner.ownerId !== context.fence.ownerId || evidence.owner.attemptId !== context.fence.attemptId
    || evidence.owner.generation !== context.fence.generation) return undefined
  const change = event.change
  const source: ActivitySource = { schemaVersion: 1, system: 'claude-sdk', observedAt: evidence.observedAt,
    ...(evidence.eventId ? { eventId: evidence.eventId } : {}),
    ...(event.change.kind === 'result' && event.change.resultIndex !== undefined ? { sequence: String(event.change.resultIndex) } : {}) }
  const itemId = 'itemId' in change ? change.itemId : change.kind === 'task' ? `claude:task:${change.taskId}`
    : evidence.eventId ? `claude:event:${evidence.eventId}` : change.kind === 'diagnostic'
      ? `claude:diagnostic:${context.fence.ownerId}:${context.fence.attemptId}:${change.code}` : undefined
  const nativeItemId = change.kind === 'tool' ? evidence.toolUseId : change.kind === 'task' ? change.taskId
    : change.kind === 'text' && change.operation === 'replace' ? evidence.messageUuid
      : change.kind === 'result' ? evidence.eventId : undefined
  const native: ActivityNativeIdentity | undefined = evidence.nativeSessionId ? {
    harness: 'claude', sessionId: evidence.nativeSessionId, generation: String(evidence.owner.generation),
    ...(nativeItemId ? { itemId: nativeItemId } : {}),
  } : undefined
  const owner: WorkRef = context.owner
  const parentToolUseId = evidence.parentToolUseId ?? (change.kind === 'task' ? evidence.toolUseId : undefined)
  const parent: WorkRef = parentToolUseId ? { kind: 'tool', itemId: `claude:tool:${parentToolUseId}`,
    ...(native ? { native: { ...native, itemId: parentToolUseId } } : {}) } : owner
  const envelope = { schemaVersion: 1 as const, owner: context.owner, source, ...(native ? { native } : {}) }
  if (change.kind === 'text' && !evidence.parentToolUseId) return { ...envelope, change: change.operation === 'append'
    ? { kind: 'text.append', itemId: change.itemId, text: change.text, finality: 'provisional' }
    : { kind: 'text.replace', itemId: change.itemId, text: change.text, finality: change.final ? 'authoritative_final' : 'provisional' } }
  if (!itemId) return undefined
  const itemBase = { id: itemId, revision: context.revision, order: context.order, owner, parent, source,
    ...(native ? { native } : {}), evidence: 'confirmed' as const }
  let item: ActivityItem
  if (change.kind === 'tool') item = { ...itemBase, kind: 'tool', title: claudeToolTitle(change.name), status: change.status }
  else if (change.kind === 'task') item = { ...itemBase, kind: 'subagent', title: 'Subagent activity', status: change.status }
  else if (change.kind === 'text') {
    // Complete child output remains a linked activity, not the parent's answer.
    item = { ...itemBase, kind: 'text', text: change.text, finality: change.final ? 'authoritative_final' : 'provisional' }
  } else if (change.kind === 'diagnostic') item = { ...itemBase, evidence: 'unknown', kind: 'diagnostic', code: change.code, message: 'Claude provider evidence requires reconciliation.' }
  else if (change.kind === 'result' && native) {
    // Provider terminal observation is independent of admitted Foreman Code request
    // settlement, delivery, and descendants. W05 must not flatten those owners.
    return { ...envelope, change: { kind: 'provider-turn.observed', work: {
      ref: { kind: 'native_turn', native }, native, phase: 'terminal', outcome: change.outcome,
      delivery: null, evidence: 'confirmed', startedAt: null,
    } } }
  } else return undefined
  return { ...envelope, change: { kind: 'item.upsert', item } }
}
