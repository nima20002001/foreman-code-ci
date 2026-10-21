import { renewWorkflowNativePublicationLease } from './workflowNativeLease.js'
import { DurableInteractionSchema, HarnessExecutionSchema, type DurableInteraction, type HarnessExecution, type HarnessNativeEvent,
  type NativeSessionReference } from '@foreman-code/contracts'
import { RunGraphScopeSchema, WorkflowRunV3Schema, type RunGraphScope, type NativeGraphProjectionKey } from '@foreman-code/contracts/wave25'
import type { RunOwnership } from './ownership.js'
import { currentRunGraphPublication } from '../run-graph/publication.js'
import { appendNativeGraphEvent } from '../run-graph/nativeIngestion.js'
import { nativeDisconnectObservation, normalizeNativeProducerEvent } from '../run-graph/nativeProducerNormalization.js'
import { appendNormalizedNativeEvent, readPersistedNativeSequence } from './nativeEvents.js'
import { readNativeGraphActivity, readNativeGraphCorrelation, type NativeGraphProjectionGuard } from '../run-graph/records.js'
import { PostgresNativeGraphProjectionWriter } from '../run-graph/nativeWriter.js'
import { DomainError } from '../errors.js'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { activeNativeBatch, forgetNativeRow, memoizeNativeRead, nativeCommitCheck, prefetchedNativeAppend } from '../run-graph/nativeBatch.js'
import { flushNativeGraphRows } from '../run-graph/nativeWriter.js'
import { stagedNativeRecordId } from '../run-graph/records.js'
import { type NativeResponseDeliveryEvidence } from '../interactions/delivery.js'
import type { NativeHistory } from '../harnesses/port.js'
import { selectNativeGraphEvidence } from '../run-graph/nativeEvidence.js'
import type { NativeEventAppendResult } from './nativeEventBatch.js'
import { latestWorkflowCorrelation } from './workflowNativeCorrelation.js'

export interface WorkflowNativeLease {
  id: string
  token: string
  providerId?: string
  live: boolean
}
export interface WorkflowApprovalCorrelation { interaction: DurableInteraction; nativeTurnId: string }
export interface WorkflowContinuationProof {
  session: NativeSessionReference
  providerId: string
  correlationId: string
  responseDeliveries: readonly NativeResponseDeliveryEvidence[]
  historyEvents?: NativeHistory['events']
}

/** Validated by the private capture consumer for this frame in the same transaction. */
interface WorkflowNativeEventContext {
  sql: GraphTransactionSql
  scope: RunGraphScope
  execution: HarnessExecution
  appended?: NativeEventAppendResult
}

/** SQL composition used only AFTER the private native-capture verifier. The
 * original source, execution mutation and G1 receipts share this transaction. */
export async function appendWorkflowNativeGraphEventLocked(sql: GraphTransactionSql, owner: RunOwnership,
  input: HarnessNativeEvent, lease?: WorkflowNativeLease, approval?: WorkflowApprovalCorrelation,
  _continuation?: WorkflowContinuationProof, context?: WorkflowNativeEventContext | undefined): Promise<void> {
  void _continuation
  assertGraphTransaction(sql)
  owner.assertOwned()
  if (lease) await renewWorkflowNativePublicationLease(sql, owner, lease.id)
  let scope: RunGraphScope
  let execution: HarnessExecution
  if (context) {
    if (context.sql !== sql || context.scope.runId !== owner.runId || context.execution.runId !== owner.runId
      || context.execution.id !== input.executionId) {
      throw new DomainError('GRAPH_SCOPE_MISMATCH', 'Native event context belongs to another frame or transaction.', 409)
    }
    scope = context.scope
    execution = context.execution
  } else {
    const found = (await sql.query<{ record: unknown }>('select record from runs where id=$1', [owner.runId])).rows[0]
    const run = WorkflowRunV3Schema.parse(found?.record)
    scope = RunGraphScopeSchema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
      runId: run.id, workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 })
    const stored = (await sql.query<{ record: unknown }>(
      'select record from harness_executions where id=$1 and run_id=$2 for update', [input.executionId, owner.runId])).rows[0]
    execution = HarnessExecutionSchema.parse(stored?.record)
  }
  const normalized = normalizeNativeProducerEvent(input)
  const publication = currentRunGraphPublication(sql, scope)
    const key: NativeGraphProjectionKey = { execution: { workflowNodeId: execution.workflowNodeId,
      executionId: execution.id, agentId: execution.agentId,
      agentConfigurationVersionId: execution.agentConfigurationVersionId!, attempt: execution.attempt },
    workKind: 'workflow', workId: execution.id }
    const approvalRecord = approval ? DurableInteractionSchema.parse((await sql.query<{ record: unknown }>(
      'select record from durable_interactions where id=$1 for update', [approval.interaction.id])).rows[0]?.record) : undefined
    const raw = context?.appended ?? prefetchedNativeAppend(sql, normalized.event) ?? await appendNormalizedNativeEvent(sql, normalized)
    if (raw.rejected || !lease || execution.state === 'completed' || !execution.nativeSessionId) return
    const nativeSequence = context?.appended?.sequence ?? prefetchedNativeAppend(sql, normalized.event)?.sequence
      ?? await readPersistedNativeSequence(sql, normalized.event)
    const lane = await memoizeNativeRead(sql, `lane-row:${lease.id}`, async () => (await sql.query<{ record: { leaseToken?: string;
      leaseExpiresAt?: string; connectionGeneration: number; correlationId?: string; currentTurnOrMessageId?: string };
      live: boolean; harness: string; native_session_id: string; owner_agent_id: string }>(
      `select record,harness,native_session_id,owner_agent_id,
        coalesce((record->>'leaseExpiresAt')::timestamptz>clock_timestamp(),false) as live
        from native_session_lanes where id=$1 for update`, [lease.id])).rows[0])
    if (!lane || lane.record.leaseToken !== lease.token || !lane.record.leaseExpiresAt
      || lane.live !== true || lane.owner_agent_id !== execution.agentId
      || lane.native_session_id !== execution.nativeSessionId) throw new DomainError('SESSION_LANE_LEASE_LOST',
      'The native writer is no longer the current workflow owner.', 409)
    const generation = String(lane.record.connectionGeneration)
    const turnCorrelation = lane.record.correlationId ?? `execution:${execution.id}`
    const correlationKey = await latestWorkflowCorrelation(sql, scope.runId, execution.id, turnCorrelation)
    const prior = await readNativeGraphCorrelation(sql, scope, key, correlationKey)
    // The original capture still checks physical ownership before publication
    // and commit. An unchanged correlation has no graph mutation for transcript-only frames.
    const transcriptOnly = !approval && normalized.event.payload.nativeMessageId === undefined
      && normalized.event.type !== 'transport.disconnected'
      && selectNativeGraphEvidence(normalized.event.type, normalized.event.payload).kind === 'ignored'
    if (transcriptOnly && prior && prior.connectionId === (normalized.event.connectionId ?? null)
      && String(prior.connectionGeneration) === generation
      && prior.nativeTurnId === (lease.providerId ?? null)) return
    const ownerFence = await owner.readOneShotFence(sql)
    const guard: NativeGraphProjectionGuard = { expected: { scope, key, ownerId: lease.token,
      fence: ownerFence.fence, connectionGeneration: generation },
    readCurrentLocked: (transaction) => memoizeNativeRead(transaction, `guard-current:${lease.id}:${execution.id}`, async () => {
      await renewWorkflowNativePublicationLease(transaction, owner, lease.id)
      const currentFence = await owner.readOneShotFence(transaction)
      const currentExecution = (await transaction.query<{ record: unknown }>(
        'select record from harness_executions where id=$1 and run_id=$2 for update', [execution.id, owner.runId])).rows[0]
      const current = HarnessExecutionSchema.parse(currentExecution?.record)
      const currentLane = (await transaction.query<{ record: { leaseToken?: string; leaseExpiresAt?: string;
        connectionGeneration: number }; live: boolean; harness: string; native_session_id: string; owner_agent_id: string }>(
        `select record,harness,native_session_id,owner_agent_id,
        coalesce((record->>'leaseExpiresAt')::timestamptz>clock_timestamp(),false) as live
        from native_session_lanes where id=$1 for update`, [lease.id])).rows[0]
      const currentKey: NativeGraphProjectionKey = { execution: { workflowNodeId: current.workflowNodeId,
        executionId: current.id, agentId: current.agentId,
        agentConfigurationVersionId: current.agentConfigurationVersionId!, attempt: current.attempt },
      workKind: 'workflow', workId: current.id }
      const held = !!currentLane && currentLane.record.leaseToken === lease.token
        && !!currentLane.record.leaseExpiresAt && currentLane.live === true
        && currentLane.owner_agent_id === current.agentId && currentLane.native_session_id === current.nativeSessionId
        && current.state !== 'completed'
      return { scope, key: currentKey, ownerId: currentLane?.record.leaseToken ?? 'lost', fence: currentFence.fence,
        connectionGeneration: String(currentLane?.record.connectionGeneration ?? 0), ownership: held ? 'held' : 'lost',
        access: held ? 'project' : 'observe' }
    }) }
    nativeCommitCheck(sql, `graph-lane:${lease.id}`, async () => {
      await renewWorkflowNativePublicationLease(sql, owner, lease.id)
      await owner.readOneShotFence(sql)
      const held = await sql.query(`select 1 from native_session_lanes where id=$1
        and record->>'leaseToken'=$2 and (record->>'leaseExpiresAt')::timestamptz>clock_timestamp()
        and record->>'connectionGeneration'=$3`, [lease.id, lease.token, generation])
      if (held.rowCount !== 1) throw new DomainError('SESSION_LANE_LEASE_LOST',
        'The native writer lease expired before graph publication committed.', 409)
    })
    if (!prior && !lease.live) return
    if (prior && (prior.connectionId !== (normalized.event.connectionId ?? null)
      || String(prior.connectionGeneration) !== generation)) return
    if (!prior) {
      await new PostgresNativeGraphProjectionWriter().persistCorrelation(sql, scope, null, {
        key, correlationKey, provider: lane.harness as 'codex' | 'claude', nativeSessionId: execution.nativeSessionId,
        connectionId: normalized.event.connectionId ?? null, connectionGeneration: lane.record.connectionGeneration,
        nativeTurnId: lease.providerId ?? null, nativeRequestId: null,
        interactionId: null, reviewJobId: null, firstNativeSequence: nativeSequence,
        lastNativeSequence: nativeSequence, terminalNativeSequence: null, metadataRevision: '0',
      }, guard)
    }
    if (prior && normalized.event.type === 'turn.capacity_retry'
      && prior.nativeTurnId === normalized.event.payload.turnId && !lease.providerId) {
      const writer = new PostgresNativeGraphProjectionWriter()
      await writer.persistCorrelation(sql, scope, null, {
        ...prior, correlationKey: `${turnCorrelation}:retry:${prior.nativeTurnId}`,
        nativeTurnId: null, terminalNativeSequence: null, metadataRevision: '0',
        firstNativeSequence: nativeSequence, lastNativeSequence: nativeSequence,
      }, guard)
      const activity = await readNativeGraphActivity(sql, scope, key)
      if (activity) await writer.persistActivity(sql, scope, activity.projectionRevision, {
        ...activity, projectionRevision: String(BigInt(activity.projectionRevision) + 1n),
        activity: { workflowNodeId: execution.workflowNodeId, execution: key.execution, status: 'none' },
      }, guard)
      // A direct delete must see the staged batch rows and must not leave a stale staged checkpoint behind.
      const batch = activeNativeBatch(sql)
      if (batch) await flushNativeGraphRows(batch, ['correlation', 'activity', 'checkpoint'])
      await sql.query(`delete from run_native_projection_checkpoints
        where run_id=$1 and execution_id=$2 and work_kind='workflow' and work_id=$2`, [scope.runId, execution.id])
      if (batch) forgetNativeRow(batch, stagedNativeRecordId('checkpoint', key))
    }
    if (prior && !prior.nativeTurnId && lease.providerId) {
      await new PostgresNativeGraphProjectionWriter().persistCorrelation(sql, scope, prior.metadataRevision, {
        ...prior, nativeTurnId: lease.providerId,
        metadataRevision: String(BigInt(prior.metadataRevision) + 1n),
      }, guard)
    }
    if (approval) {
      const current = approvalRecord!
      if (current.runId !== scope.runId || current.executionId !== execution.id
        || current.nativeSessionId !== execution.nativeSessionId
        || current.nativeRequestId !== approval.interaction.nativeRequestId
        || current.graphThreadId !== scope.runId || !approval.nativeTurnId
        || lease.providerId && lease.providerId !== approval.nativeTurnId) {
        throw new DomainError('GRAPH_SCOPE_MISMATCH', 'The approval does not belong to the current native turn.', 409)
      }
      const anchored = await readNativeGraphCorrelation(sql, scope, key, correlationKey)
      if (!anchored || anchored.connectionId !== (normalized.event.connectionId ?? null)
        || String(anchored.connectionGeneration) !== generation) {
        throw new DomainError('GRAPH_STALE_GENERATION', 'The approval source has no current native correlation.', 409)
      }
      const approvalKey = `approval:${current.id}`
      const saved = await readNativeGraphCorrelation(sql, scope, key, approvalKey)
      if (!saved) await new PostgresNativeGraphProjectionWriter().persistCorrelation(sql, scope, null, {
        key, correlationKey: approvalKey, provider: anchored.provider, nativeSessionId: anchored.nativeSessionId,
        connectionId: anchored.connectionId, connectionGeneration: anchored.connectionGeneration,
        nativeTurnId: approval.nativeTurnId, nativeRequestId: current.nativeRequestId,
        interactionId: current.id, reviewJobId: null, firstNativeSequence: anchored.firstNativeSequence,
        lastNativeSequence: anchored.lastNativeSequence, terminalNativeSequence: null, metadataRevision: '0',
      }, guard)
      else if (saved.interactionId !== current.id || saved.nativeRequestId !== current.nativeRequestId
        || saved.nativeTurnId !== approval.nativeTurnId || saved.connectionId !== anchored.connectionId) {
        throw new DomainError('GRAPH_SOURCE_CONFLICT', 'The approval native correlation changed.', 409)
      }
    }
    const observation = nativeDisconnectObservation(scope, key, normalized.event, generation)
    // Raw transcript frames already passed the source/physical/lane checks and
    // were retained above. Preserve correlation initialization, but do not run
    // a second raw append and semantic authority/projection reads for a frame
    // the shared selector cannot project. Reliability and approval evidence
    // still take the complete ingester path.
    const claudeEvidence = ['message.submitted', 'interaction.pending', 'turn.completed'].includes(normalized.event.type)
      && normalized.event.payload.nativeMessageId !== undefined
    if (!approval && !observation && !claudeEvidence
      && selectNativeGraphEvidence(normalized.event.type, normalized.event.payload).kind === 'ignored') return
    await appendNativeGraphEvent(publication, normalized.event, [{ guard, correlationKey,
      ...(observation ? { observation } : {}) }])
}
