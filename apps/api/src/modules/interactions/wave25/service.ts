import { componentLogger } from '../../diagnostics/logger.js'
import { withInteractionDeliveryReconciliation, withOriginalInteractionDeliveryClaim } from '../originalDeliveryClaim.js'
import { randomUUID } from 'node:crypto'
import { withInteractionResponse, type DurableInteraction, type InteractionResponseValue } from '@foreman-code/contracts'
import { requireAuthorization } from '../../access/policy.js'
import type { NativeResponseJournal } from '../../harnesses/recovery/responseJournal.js'
import type { InteractionNativeRuntime } from '../runtimePorts.js'
import type { InteractionResponder } from '../responder.js'
import type { GraphResumeClaim } from '../deliveryPostgres.js'
import { INTERACTION_DELIVERY_LEASE_MS, matchingDeliveryEvidence, selectedInteractionResponse,
  type InteractionDeliveryClaim, type NativeDeliveryOutcome } from '../delivery.js'
import type { Wave25InteractionRepository } from './repository.js'
import { fail } from './context.js'
import { holdResumeClaims } from './resume.js'
import { SingleWriterSessionManager } from '../sessionWriter.js'
import { canUserInteract } from '../../access/userPolicy.js'
import { requireRespondableInteraction } from '../../access/appPolicy.js'
import { assertInteractionResponseActive, type InteractionResponseOptions } from '../cancellation.js'

/** Consumer must call consumeApprovalGraphResume in the existing Run/checkpoint
 * transaction. A callback that starts native work or returns void without that
 * receipt is not a qualified implementation. */
export type AtomicApprovalResumeConsumer = (claim: GraphResumeClaim) => Promise<void>
export interface ApprovalRuntimeDependencies {
  repository: Wave25InteractionRepository
  nativeRuntime: InteractionNativeRuntime
  journal?: NativeResponseJournal
  atomicResume?: AtomicApprovalResumeConsumer
  prepareRequester?: (interaction: DurableInteraction) => Promise<void>
}

async function read(deps: ApprovalRuntimeDependencies, id: string): Promise<DurableInteraction> {
  const current = await deps.repository.get(id)
  return current ?? fail('INTERACTION_NOT_FOUND')
}
export async function deliverApproval(deps: ApprovalRuntimeDependencies, id: string, reconcileOnly = false): Promise<DurableInteraction> {
  const current = await read(deps, id)
  if (current.status === 'canceled' || current.deliveryState === 'delivered') return current
  const claim = await deps.repository.delivery.claim(id, randomUUID(), reconcileOnly)
  if (!claim) return read(deps, id)
  const signal = AbortSignal.timeout(INTERACTION_DELIVERY_LEASE_MS)
  return deps.nativeRuntime.withInteractionOwner(current, signal,
    ownedSignal => deliverClaim(deps, current, claim, ownedSignal))
}

async function deliverClaim(deps: ApprovalRuntimeDependencies, current: DurableInteraction,
  claim: InteractionDeliveryClaim, signal: AbortSignal): Promise<DurableInteraction> {
  const option = selectedInteractionResponse(current)
  if (!option) return fail('INTERACTION_OPTION_INVALID')
  const expectedSession = { harness: current.harness, providerVersion: current.providerVersion, nativeSessionId: current.nativeSessionId }
  if (claim.mode === 'reconcile') {
    let result: NativeDeliveryOutcome = { state: 'uncertain' }
    try {
      const persisted = await deps.repository.delivery.persistedResponseEvidence(current)
      const cached = persisted ?? deps.journal?.read(expectedSession, {
        nativeRequestId: current.nativeRequestId, nativeRequestType: current.nativeRequestType, option,
      })
      if (cached) result = { state: 'delivered', evidence: cached }
      else {
        const attached = await deps.nativeRuntime.attachInteraction(current, signal)
        if (attached.manager.harness !== current.harness || attached.session.harness !== current.harness
          || attached.session.nativeSessionId !== current.nativeSessionId || attached.session.providerVersion !== current.providerVersion) return fail('APPROVAL_SESSION_MISMATCH')
        const history = await withInteractionDeliveryReconciliation(claim, () => attached.manager.reconcileResponse
          ? attached.manager.reconcileResponse(attached.session, { nativeRequestId: current.nativeRequestId, nativeRequestType: current.nativeRequestType, option }, signal)
          : attached.manager.history(attached.session, signal))
        const proof = matchingDeliveryEvidence(current, attached.session, history)
        if (proof) result = { state: 'delivered', evidence: proof }
      }
    } catch { result = { state: 'uncertain', error: 'APPROVAL_RECONCILIATION_UNCERTAIN' } }
    return deps.repository.delivery.finish(claim, result)
  }
  if (!deps.nativeRuntime.validateInteraction) return fail('APPROVAL_NATIVE_QUALIFICATION_REQUIRED')
  let attached: Awaited<ReturnType<InteractionNativeRuntime['attachInteraction']>>
  try {
    await deps.nativeRuntime.validateInteraction(current, signal)
    attached = await deps.nativeRuntime.attachInteraction(current, signal)
    if (attached.manager.harness !== current.harness || attached.session.harness !== current.harness
      || attached.session.nativeSessionId !== current.nativeSessionId || attached.session.providerVersion !== current.providerVersion) return fail('APPROVAL_SESSION_MISMATCH')
    await deps.nativeRuntime.validateInteraction(current, signal)
  } catch {
    return deps.repository.delivery.finish(claim, { state: 'failed', error: 'APPROVAL_NATIVE_QUALIFICATION_FAILED' })
  }
  if (!(attached.manager instanceof SingleWriterSessionManager)) {
    return deps.repository.delivery.finish(claim, { state: 'failed', error: 'APPROVAL_NATIVE_QUALIFICATION_REQUIRED' })
  }
  const writer = attached.manager
  const dispatchSignal = attached.signal ? AbortSignal.any([signal, attached.signal]) : signal
  return deps.repository.delivery.finish(claim, (interaction, writeSignal) => withOriginalInteractionDeliveryClaim<NativeDeliveryOutcome>({ ...claim, interaction }, async () => {
    let phase = 'respond'
    try {
      // Revalidate permission/location AFTER the writer's control queue, using
      // its owned cancellation signal. The final SQL fence check commits before
      // provider dispatch; no Run/head lock covers filesystem or native I/O.
      writeSignal.throwIfAborted()
      await writer.respondQualified(attached.session, interaction.nativeRequestId, option, async (ownedSignal) => {
        await deps.nativeRuntime.validateInteraction!(interaction, ownedSignal)
        await deps.repository.delivery.assertNativeDispatch(claim)
      }, writeSignal)
      phase = 'read-receipt'
      const cached = deps.journal?.read(expectedSession, { nativeRequestId: interaction.nativeRequestId, nativeRequestType: interaction.nativeRequestType, option })
      if (cached) return { state: 'delivered', evidence: cached }
      const history = attached.manager.reconcileResponse
        ? await attached.manager.reconcileResponse(attached.session, { nativeRequestId: interaction.nativeRequestId, nativeRequestType: interaction.nativeRequestType, option }, writeSignal)
        : await attached.manager.history(attached.session, writeSignal)
      const proof = matchingDeliveryEvidence(interaction, attached.session, history)
      return proof ? { state: 'delivered', evidence: proof } : { state: 'uncertain', error: 'APPROVAL_DELIVERY_RECEIPT_MISSING' }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      componentLogger('engine').warn({ runId: interaction.runId,
        code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(code) ? code : 'APPROVAL_NATIVE_DELIVERY_UNCERTAIN',
        phase, errorType: error instanceof Error ? error.name : 'UnknownError',
        errorLocation: error instanceof Error ? error.stack?.split('\n')[1]?.trim() : undefined }, 'Native approval delivery is uncertain.')
      return { state: 'uncertain', error: 'APPROVAL_NATIVE_DELIVERY_UNCERTAIN' }
    }
  }), dispatchSignal)
}

export async function resumeApproval(deps: ApprovalRuntimeDependencies, interaction: DurableInteraction): Promise<void> {
  if (interaction.deliveryState !== 'delivered' || interaction.status === 'canceled') return
  if (!deps.atomicResume) return fail('GRAPH_RESUME_ATOMIC_CONSUMER_REQUIRED',
    'The current checkpoint consumer is not attached. Delivery is persisted; no native response or graph callback was replayed.')
  const claimedAt = Date.now()
  const claim = await deps.repository.delivery.claimAtomicGraphResume(interaction.id, randomUUID())
  if (!claim) return
  // The response is already delivered; keep its claim while the Run owner finishes earlier work.
  const [held] = holdResumeClaims(deps.repository.delivery, [claim], claimedAt)
  let error: string | undefined
  try { await deps.atomicResume(held!) } catch { error = 'GRAPH_RESUME_CHECKPOINT_UNCERTAIN' }
  finally { await held!.release!() }
  await deps.repository.delivery.finishGraphResume(claim, error)
}
export async function respondToApproval(deps: ApprovalRuntimeDependencies, responder: InteractionResponder,
  input: { interactionId: string; optionId: string; expectedRevision: number; response?: InteractionResponseValue | undefined },
  options: InteractionResponseOptions = {}) {
  const current = await read(deps, input.interactionId)
  if (!responder.principal || (current.approval.handler === 'user') !== (responder.kind !== 'orchestrator')) {
    return fail('INTERACTION_ACCESS_DENIED')
  }
  if (responder.kind === 'orchestrator') {
    if (responder.beforeCommit) return fail('APPROVAL_RAW_AUDIT_CALLBACK_REJECTED')
    if (responder.authority.agentId !== responder.principal.agentId || responder.authority.workspaceId !== current.workspaceId
      || responder.authority.workflowId !== current.workflowId) return fail('INTERACTION_ACCESS_DENIED')
  }
  const option = current.responseOptions.find((item) => item.optionId === input.optionId)
  if (!option) return fail('INTERACTION_OPTION_INVALID')
  if (current.status === 'pending') {
    if (responder.kind === 'user') {
      if (!canUserInteract(responder.principal, 'interactions:respond', current)) return fail('INTERACTION_ACCESS_DENIED')
    } else if (responder.kind === 'operator') {
      if (responder.principal.audience !== 'operator') return fail('INTERACTION_ACCESS_DENIED')
      requireAuthorization(responder.principal, 'interactions:read', current)
      requireAuthorization(responder.principal, 'interactions:respond', current)
    } else requireRespondableInteraction(responder.principal, current)
    if (!deps.nativeRuntime.validateInteraction) return fail('APPROVAL_NATIVE_QUALIFICATION_REQUIRED')
    assertInteractionResponseActive(options.signal)
    try {
      await deps.prepareRequester?.(current)
      await deps.nativeRuntime.validateInteraction(current, options.signal)
    } catch (error) {
      assertInteractionResponseActive(options.signal)
      throw error
    }
    assertInteractionResponseActive(options.signal)
  }
  const selected = withInteractionResponse(option, input.response)
  const decided = await deps.repository.decide({ id: current.id, optionId: input.optionId, expectedRevision: input.expectedRevision,
    principal: responder.principal, nativeResponse: { optionId: option.optionId, semantic: option.semantic,
      ...(selected.response !== undefined ? { response: selected.response } : {}) },
    ...(responder.kind === 'operator' && responder.source ? { source: responder.source } : {}),
    ...(options.signal ? { signal: options.signal } : {}) })
  const delivered = await deliverApproval(deps, current.id)
  await resumeApproval(deps, delivered)
  return { interaction: await read(deps, current.id), replayed: decided.replayed }
}
