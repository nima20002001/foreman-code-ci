import { ActivityChangeEnvelopeV1Schema, type ActivityChangeEnvelopeV1 } from '@foreman-code/contracts'
import type { ActivityTextOperation } from '@foreman-code/contracts/activity-text'

/** Shared Operator/Agent/execution adapter. Transport arrival counters never become native provenance. */
export function activityTextEnvelope(operation: ActivityTextOperation, harness: 'codex' | 'claude'): ActivityChangeEnvelopeV1 {
  const { identity, source } = operation
  if (identity.scope.kind === 'workflow_run') throw new Error('An aggregate Run cannot own native text.')
  const requestId = identity.requestId ?? ('requestId' in identity.scope ? identity.scope.requestId : undefined)
  if (identity.scope.kind !== 'workflow_execution' && !requestId) throw new Error('Text has no admitted request owner.')
  if (!operation.observedAt) throw new Error('Text has no observed source time.')
  const owner = identity.scope.kind === 'workflow_execution'
    ? { ...identity.scope, kind: 'execution' }
    : { kind: 'chat_request', conversationId: identity.scope.conversationId, requestId }
  const scope = { ...identity.scope }
  if ('requestId' in scope) delete scope.requestId
  return ActivityChangeEnvelopeV1Schema.parse({ schemaVersion: 1, owner, scope,
    native: { harness, sessionId: identity.sessionId, itemId: identity.itemId, ...(identity.partId ? { partId: identity.partId } : {}), ...(identity.parentId ? { parentItemId: identity.parentId } : {}), ...(identity.generation ? { generation: identity.generation } : {}), ...(identity.turnId ? { turnId: identity.turnId } : {}) },
    source: { schemaVersion: 1, system: harness, observedAt: operation.observedAt,
      ...(source?.eventId ? { eventId: source.eventId } : {}), ...(source?.nativeSequence ? { sequence: source.nativeSequence } : {}) },
    change: { kind: operation.mode === 'append' ? 'text.append' : 'text.replace', itemId: identity.itemId,
      ...(identity.partId ? { partId: identity.partId } : {}), ...(identity.parentId ? { parentItemId: identity.parentId } : {}),
      channel: identity.channel, text: operation.text,
      ...(operation.truncation ? { truncation: operation.truncation } : {}), finality: operation.final ? 'authoritative_final' : 'provisional' },
  })
}
