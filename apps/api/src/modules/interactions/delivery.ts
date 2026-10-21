import { withInteractionResponse, type DurableInteraction, type NativeSessionReference } from '@foreman-code/contracts'
import { createHash } from 'node:crypto'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import type { NativeHistory, NativeResponseDeliveryEvidence } from '../harnesses/port.js'

export type { NativeResponseDeliveryEvidence } from '../harnesses/port.js'

/** A lease may expire during attachment, but never authorizes another native send. */
export const INTERACTION_DELIVERY_LEASE_MS = 60_000

export interface InteractionDeliveryClaim {
  interaction: DurableInteraction
  attempt: number
  ownerToken: string
  correlationId: string
  mode: 'submit' | 'reconcile'
  /** Captured by the atomic v3 claim; mandatory for remote response admission. */
  deliveryFence?: string
  approvalConnectionGeneration?: string
}

export interface NativeDeliveryOutcome {
  state: 'delivered' | 'uncertain' | 'failed'
  error?: string
  evidence?: NativeResponseDeliveryEvidence
}

export function responseValueDigest(value: unknown): string {
  return createHash('sha256').update(canonicalGraphJson(value ?? null)).digest('hex')
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

export function selectedInteractionResponse(interaction: DurableInteraction) {
  const offered = interaction.responseOptions.find((option) => option.optionId === interaction.selectedOptionId)
  if (!offered) return undefined
  return withInteractionResponse(offered, object(interaction.nativeResponse)?.response)
}

/** Retained command history can also qualify delivery when no adapter receipt is available.
 * This path requires both the resolved submission and execution of the gated item. */
function matchingCodexCommandExecution(
  interaction: DurableInteraction,
  session: NativeSessionReference,
  history: NativeHistory,
): NativeResponseDeliveryEvidence | undefined {
  if (interaction.harness !== 'codex' || interaction.nativeRequestType !== 'item/commandExecution/requestApproval'
    || !interaction.selectedOptionId || !interaction.selectedSemantic) return undefined
  if (!['approve_once', 'allow_turn', 'allow_session', 'provider_scoped_allow', 'persistent_policy_change']
    .includes(interaction.selectedSemantic)) return undefined
  const request = object(interaction.request)
  const itemId = request?.itemId, turnId = request?.turnId, threadId = request?.threadId
  const command = request?.command, cwd = request?.cwd
  if (typeof itemId !== 'string' || typeof turnId !== 'string' || threadId !== interaction.nativeSessionId
    || typeof command !== 'string' || typeof cwd !== 'string') return undefined
  const relevant = history.events.filter((event) => event.connectionId && [
    'interaction.pending', 'interaction.submitting', 'interaction.submitted', 'interaction.resolved', 'item.completed',
  ].includes(event.type))
  const submissions = relevant.filter((event) => event.type === 'interaction.submitted'
    && event.payload.nativeRequestId === interaction.nativeRequestId)
  if (!submissions.length || submissions.some((event) => event.payload.optionId !== interaction.selectedOptionId
    || event.payload.semantic !== interaction.selectedSemantic
    || event.payload.responseDigest !== undefined
      && event.payload.responseDigest !== responseValueDigest(object(interaction.nativeResponse)?.response))) return undefined
  for (const submitted of submissions) {
    const reserved = [...relevant].reverse().find((event) => event.connectionId === submitted.connectionId
      && event.sequence < submitted.sequence && event.type === 'interaction.submitting'
      && event.payload.nativeRequestId === interaction.nativeRequestId
      && event.payload.optionId === interaction.selectedOptionId)
    // A reservation permits resolution before the write callback; submitted alone proves the ordinary ordering.
    const sentSequence = reserved?.sequence ?? submitted.sequence
    const pending = relevant.find((event) => event.connectionId === submitted.connectionId
      && event.sequence < sentSequence && event.type === 'interaction.pending'
      && event.payload.nativeRequestId === interaction.nativeRequestId
      && event.payload.nativeRequestType === interaction.nativeRequestType && event.payload.turnId === turnId)
    const resolved = relevant.find((event) => event.connectionId === submitted.connectionId
      && event.sequence > sentSequence && event.type === 'interaction.resolved'
      && event.payload.nativeRequestId === interaction.nativeRequestId
      && event.payload.submittedOptionId === interaction.selectedOptionId
      && event.payload.evidence === 'serverRequest/resolved')
    if (!pending || !resolved) continue
    const completed = relevant.find((event) => {
      const payload = event.payload, item = object(payload.item)
      return event.connectionId === submitted.connectionId && event.sequence > resolved.sequence
        && event.type === 'item.completed' && payload.threadId === threadId && payload.turnId === turnId
        && item?.id === itemId && item.type === 'commandExecution' && item.status === 'completed'
        && item.command === command && item.cwd === cwd && typeof item.exitCode === 'number'
    })
    if (completed) return {
      source: 'provider_history', harness: interaction.harness, providerVersion: interaction.providerVersion,
      nativeSessionId: session.nativeSessionId, nativeRequestId: interaction.nativeRequestId,
      nativeRequestType: interaction.nativeRequestType, optionId: interaction.selectedOptionId,
      semantic: interaction.selectedSemantic,
    }
  }
  return undefined
}

export function matchingDeliveryEvidence(
  interaction: DurableInteraction,
  session: NativeSessionReference,
  history: NativeHistory,
): NativeResponseDeliveryEvidence | undefined {
  if (session.harness !== interaction.harness || session.providerVersion !== interaction.providerVersion
    || session.nativeSessionId !== interaction.nativeSessionId) return undefined
  // Conflicting observations are uncertain even if a receipt is also present.
  const pending = history.pendingInteraction ? [...history.pendingInteractions, history.pendingInteraction] : history.pendingInteractions
  if (pending.some((item) => item.session.harness === interaction.harness
    && item.session.nativeSessionId === interaction.nativeSessionId
    && item.turn.nativeRequestId === interaction.nativeRequestId)) return undefined
  if (!interaction.selectedOptionId || !interaction.selectedSemantic || interaction.status === 'pending') return undefined
  const deliveries = history.responseDeliveries ?? []
  // Reordered or duplicated positive receipts are harmless. A contradictory
  // decision for the same native request is not resolved by picking the first hit.
  const sameRequest = deliveries.filter((proof) => proof.harness === interaction.harness
    && proof.providerVersion === interaction.providerVersion
    && proof.nativeSessionId === interaction.nativeSessionId && proof.nativeRequestId === interaction.nativeRequestId)
  const request = object(interaction.request)
  if (sameRequest.some((proof) => proof.harness === 'claude' && (proof.nativeIdentity?.kind !== 'message'
      || proof.nativeIdentity.nativeMessageId !== request?.nativeMessageId
      || proof.nativeIdentity.generation !== request?.generation)
    || proof.nativeRequestType !== interaction.nativeRequestType
    || proof.optionId !== interaction.selectedOptionId || proof.semantic !== interaction.selectedSemantic
    || proof.responseDigest !== undefined
      && proof.responseDigest !== responseValueDigest(object(interaction.nativeResponse)?.response))) return undefined
  const explicit = sameRequest.find((proof) =>
    (proof.source === 'provider_acknowledgement' || proof.source === 'provider_history')
    && proof.harness === interaction.harness && proof.providerVersion === interaction.providerVersion
    && proof.nativeSessionId === interaction.nativeSessionId && proof.nativeRequestId === interaction.nativeRequestId
    && proof.nativeRequestType === interaction.nativeRequestType
    && proof.optionId === interaction.selectedOptionId && proof.semantic === interaction.selectedSemantic)
  return explicit ?? matchingCodexCommandExecution(interaction, session, history)
}
