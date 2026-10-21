import { InteractionSummarySchema, type InteractionSummary, type WorkRef } from '@foreman-code/contracts/activity'
import type { DurableInteraction } from '@foreman-code/contracts'
import { InteractionActivityProjectionSchema, type InteractionActivityProjection } from '@foreman-code/contracts/interaction-activity'

/** Supplied by the owning runtime after checking the exact callback/recovery binding.
 * Qualification is never inferred from a persisted pending interaction. */
export interface InteractionResponseAvailability {
  authorized: boolean
  qualified: boolean
  path: 'live_callback' | 'qualified_recovery' | 'workflow_decision' | null
  usable: boolean
  identity?: { interactionId: string; revision: number; sessionId: string; requestId: string; executionId: string }
}
export interface InteractionActivityEvidence {
  response: InteractionResponseAvailability
  /** Only persisted native turn correlation is accepted; arrival time is not identity. */
  nativeTurnId?: string
  /** Independent persisted worker acknowledgment, not callback completion or graph resume. */
  workerAcknowledgmentId?: string
}

export function projectInteractionActivity(interaction: DurableInteraction,
  evidence: InteractionActivityEvidence): InteractionActivityProjection {
  const { response } = evidence, identity = response.identity
  const matches = identity?.interactionId === interaction.id && identity.revision === interaction.revision
    && identity.sessionId === interaction.nativeSessionId && identity.requestId === interaction.nativeRequestId
    && identity.executionId === interaction.executionId
  const reason: InteractionActivityProjection['response']['reason'] = interaction.status !== 'pending' ? 'not_pending'
    : !response.authorized ? 'unauthorized' : !response.qualified ? 'unqualified'
      : !matches ? 'identity_mismatch' : !response.usable || !response.path ? 'callback_unavailable' : 'available'
  const phase: InteractionActivityProjection['phase'] = interaction.status === 'canceled' ? 'canceled'
    : interaction.deliveryState === 'uncertain' ? 'uncertain'
      : interaction.status === 'pending' ? 'needs_answer' : interaction.status === 'decided' ? 'answer_recorded'
        : interaction.status === 'delivered' ? 'delivered' : interaction.status === 'delivery_failed' ? 'failed' : 'delivery_pending'
  return InteractionActivityProjectionSchema.parse({ interactionId: interaction.id, revision: String(interaction.revision),
    owner: { workspaceId: interaction.workspaceId, workflowId: interaction.workflowId, runId: interaction.runId,
      executionId: interaction.executionId, agentId: interaction.requestingAgentId },
    native: { harness: interaction.harness, sessionId: interaction.nativeSessionId, requestId: interaction.nativeRequestId,
      ...(evidence.nativeTurnId ? { turnId: evidence.nativeTurnId } : {}) }, phase,
    answerRecorded: interaction.decidedAt !== undefined, nativeDelivery: interaction.deliveryState,
    workerAcknowledgment: interaction.deliveryState === 'delivered' && evidence.workerAcknowledgmentId ? 'confirmed' : 'unknown',
    response: { available: reason === 'available', path: reason === 'available' ? response.path : null, reason } })
}

/** The owner comes from the pinned execution read, never from the current graph. */
export function projectInteractionSummary(interaction: DurableInteraction, owner: WorkRef,
  evidence: InteractionActivityEvidence): InteractionSummary {
  if (owner.kind !== 'execution' || owner.executionId !== interaction.executionId
    || owner.workspaceId !== interaction.workspaceId || owner.workflowId !== interaction.workflowId
    || owner.runId !== interaction.runId) throw new Error('Interaction activity owner does not match its durable execution.')
  const projection = projectInteractionActivity(interaction, evidence)
  return InteractionSummarySchema.parse({ id: projection.interactionId, revision: projection.revision, owner,
    native: { harness: projection.native.harness, sessionId: projection.native.sessionId,
      ...(projection.native.turnId ? { turnId: projection.native.turnId } : {}) },
    delivery: projection.phase === 'needs_answer' ? 'pending' : projection.phase,
    answerRecorded: projection.answerRecorded, providerAcknowledged: projection.nativeDelivery === 'delivered',
    workerAcknowledged: projection.workerAcknowledgment === 'confirmed',
    responseAvailability: projection.response.available ? 'available'
      : projection.response.reason === 'callback_unavailable' ? 'recovery_required' : 'unavailable' })
}
