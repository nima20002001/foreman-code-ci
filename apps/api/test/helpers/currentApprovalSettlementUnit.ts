import assert from 'node:assert/strict'
import { DurableInteractionSchema, HarnessExecutionSchema, type NativeSessionReference, type PendingNativeInteraction } from '@foreman-code/contracts'
import { graphSourceDigest } from '../../src/modules/run-graph/publication.js'
import { decisionDigest } from '../../src/modules/interactions/wave25/publication.js'
import { nativeApprovalContext } from '../../src/modules/interactions/nativeApprovalContext.js'
import { assertApprovalTerminalSettlement } from '../../src/modules/interactions/wave25/resume.js'
import type { WorkflowApprovalAck } from '../../src/modules/interactions/nativeApprovalProof.js'
import type { WorkflowNativeProofRecord } from '../../src/modules/runs/workflowNativeProof.js'
import { repeatExecutionIdentity } from '../../src/modules/runs/repeatResolution.js'
import { currentExecutionReadUnit } from './currentExecutionReadUnit.js'

/** Synthetic persisted read-side records, NOT native acknowledgements minted by
 * a test runtime. The original-source, immutable-input and canonical-receipt
 * verifiers consume these records unchanged. A read-only publication lookup is
 * supplied by the importing unit test; it delegates to the real receipt verifier.
 * This does not qualify production SQL writers, native capture or checkpoints. */
export function currentApprovalSettlementUnit() {
  const model = currentExecutionReadUnit()
  const { f, ref, bound } = model
  const session: NativeSessionReference = { harness: 'codex', providerVersion: 'synthetic-no-native-call', nativeSessionId: 'unit-session' }
  const execution = HarnessExecutionSchema.parse({ ...model.state.execution, state: 'completed', nativeSessionId: session.nativeSessionId,
    finishedAt: f.createdAt, result: { outcome: 'succeeded', output: { done: true } } })
  model.seedAccepted(execution)
  const option = { optionId: 'approve', label: 'Approve once', semantic: 'approve_once' as const,
    persistence: 'request' as const, affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }
  const request: PendingNativeInteraction = { session, turn: { nativeTurnId: 'unit-turn', nativeRequestId: 'unit-request' },
    nativeRequestType: 'item/commandExecution/requestApproval', request: { command: 'echo unit-only' }, responseOptions: [option] }
  const reviewContext = nativeApprovalContext(request, [])
  const interaction = DurableInteractionSchema.parse({ id: 'unit-interaction', revision: 4,
    workspaceId: f.run.workspaceId, workflowId: f.run.workflowId, runId: f.run.id, executionId: execution.id,
    requestingAgentId: execution.agentId, ...session, nativeRequestId: request.turn.nativeRequestId,
    nativeRequestType: request.nativeRequestType, request: request.request, responseOptions: request.responseOptions,
    approval: f.run.approval, graphThreadId: f.run.id, graphInterruptId: 'unit-interrupt',
    ...(reviewContext ? { reviewContext } : {}), status: 'delivered', deliveryState: 'delivered',
    selectedOptionId: option.optionId, selectedSemantic: option.semantic,
    nativeResponse: { optionId: option.optionId, semantic: option.semantic },
    decidedAt: f.createdAt, deliveredAt: f.createdAt, createdAt: f.createdAt, updatedAt: f.createdAt })
  const evidence = { source: 'provider_history' as const, ...session, nativeRequestId: interaction.nativeRequestId,
    nativeRequestType: interaction.nativeRequestType, optionId: option.optionId, semantic: option.semantic }
  const commandId = `execution:${execution.id}`
  const original = (proofId: string, history: Extract<WorkflowNativeProofRecord['original'], { type: 'history' }>['history']): WorkflowNativeProofRecord => ({
    proofId, scope: f.scope, ref, execution: repeatExecutionIdentity(execution), inputDigest: bound.digest,
    commandId, session, original: { type: 'history', history }, observedAt: f.createdAt,
    ownerId: 'unit-owner', ownerFence: '1', lifetimeGeneration: 1, closureGeneration: '1',
    lane: { id: 'unit-lane', token: 'unit-token', connectionGeneration: 1, providerId: 'unit-turn' },
  })
  const pending = original('unit-pending-source', { events: [], pendingInteractions: [request], correlationId: commandId, nativeTurnId: 'unit-turn' })
  const continued = original('unit-continuation-source', { events: [], pendingInteractions: [], correlationId: commandId,
    nativeTurnId: 'unit-turn', terminalTurn: { correlationId: commandId, providerId: 'unit-turn', result: execution.result! }, responseDeliveries: [evidence] })
  const proofs = new Map([pending, continued].map((record) => [record.proofId, { record, source_digest: graphSourceDigest(record) }]))
  for (const proof of proofs.values()) {
    const nativeSource = { sourceKind: 'native_event' as const, sourceId: proof.record.proofId, sourceRevision: '1' }
    model.state.receipts.push({ scope: f.scope, evidence: nativeSource, sourceDigest: proof.source_digest,
      semanticDigest: graphSourceDigest({ evidence: nativeSource, facts: [], effect: null }), effect: null })
  }
  const nativeSource = { sourceKind: 'native_event' as const, sourceId: continued.proofId, sourceRevision: '1' }
  const requester = repeatExecutionIdentity(execution)
  const fact = { type: 'worker.resumed', interactionId: interaction.id, requester, acknowledgementId: 'unit-ack' }
  const publication = { evidence: { sourceKind: 'native_event' as const, sourceId: interaction.id, sourceRevision: String(interaction.revision) },
    sourceDigest: graphSourceDigest({ next: interaction, source: nativeSource, fact }), semanticDigest: graphSourceDigest([fact]) }
  const ack: WorkflowApprovalAck = { scope: f.scope, interaction, requester, occurrence: null, inputDigest: bound.digest,
    acknowledgementId: 'unit-ack', originalProofId: continued.proofId, originalProofDigest: graphSourceDigest(continued),
    nativeSource, nativeSourceDigest: graphSourceDigest(continued), publication }
  model.state.receipts.push({ scope: f.scope, ...publication, effect: null })
  const state = { records: [interaction], proofs, ack, pendingSourceId: pending.proofId as string | null,
    resume: { state: 'resumed', approval_native_ack_id: 'unit-ack' as string | null },
    receipt: graphSourceDigest({ interactionId: interaction.id, runId: interaction.runId, executionId: interaction.executionId,
      graphThreadId: interaction.graphThreadId, graphInterruptId: interaction.graphInterruptId, decision: decisionDigest(interaction) }) as string | undefined,
  }
  model.state.extra = (q, values) => {
    if (q.startsWith('select id,execution_id,record from durable_interactions')) {
      assert.deepEqual(values, [f.run.id, execution.id])
      return state.records.map((record) => ({ id: record.id, execution_id: record.executionId, record }))
    }
    if (q.startsWith('select state,approval_native_ack_id,approval_native_ack_record')) {
      assert.ok(state.records.some((record) => record.id === values[0]))
      return [{ ...state.resume, approval_native_ack_record: state.ack, approval_native_ack_source: state.ack.nativeSource }]
    }
    if (q.startsWith('select record,source_digest from workflow_native_proofs')) {
      assert.deepEqual(values.slice(1), [f.run.id, execution.id])
      const proof = state.proofs.get(String(values[0])); return proof ? [proof] : []
    }
    if (q.startsWith('select approval_native_request_proof_id from durable_interactions')) {
      assert.deepEqual(values, [interaction.id, execution.id])
      return [{ approval_native_request_proof_id: state.pendingSourceId }]
    }
    if (q.startsWith('select lease_expires_at,last_error,state,lease_token,')) return [{ ...state.resume }]
    if (q.startsWith('select effect_digest from run_graph_effects')) {
      assert.deepEqual(values, [f.run.id, interaction.id])
      return state.receipt ? [{ effect_digest: state.receipt }] : []
    }
    return undefined
  }
  const check = () => model.transaction((sql) => assertApprovalTerminalSettlement(sql, f.run.id, execution.id))
  return { model, state, interaction, execution, session, check }
}
