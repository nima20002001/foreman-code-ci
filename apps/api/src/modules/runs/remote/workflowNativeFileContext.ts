import { createHash } from 'node:crypto'
import { isDeepStrictEqual as same } from 'node:util'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, type NativeSessionReference } from '@foreman-code/contracts'
import { REMOTE_NATIVE_SOURCE_LIMIT } from '@foreman-code/contracts/remote-workflow-physical'
import { RemoteOperationReceiptSchema, remoteWorkflowHasTurn } from '@foreman-code/contracts/remote-execution'
import type { DispatchIntent } from '@foreman-code/contracts/node-placement'
import { ArtifactAttemptSchema } from '@foreman-code/contracts/artifact-edges'
import { TransferContextSchema, type TransferContext } from '@foreman-code/contracts/byte-transfer'
import type { AcceptedArtifactPublication } from '../../files/distributed/publication.js'
import type { FileToolContext } from '../../files/tools/types.js'
import { readLiveManagementPrincipal } from '../../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../../access/policy.js'
import type { WorkflowNativeCapture, WorkflowNativeVerificationPort } from '../../interactions/workflowNativeCapture.js'
import { readDispatchIntent } from '../../placement/persistence.js'
import { readReconciledDispatchIntent } from './persistence.js'
import { assertGraphTransaction, beforeGraphCommit, poisonGraphTransaction, type GraphTransactionSql } from '../../run-graph/connection.js'
import { currentRunGraphPublication } from '../../run-graph/publication.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from '../../run-graph/repeatReceipts.js'
import { commandInputHash } from '../../commands/postgres.js'
import { repeatDigest, repeatExecutionIdentity } from '../repeatResolution.js'
import { assertWorkflowCorrelation } from '../workResultRepair.js'
import type { RepeatNativeEvidence } from '../repeatNativeRepository.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import type { RunOwnership } from '../ownership.js'
import { codexChatFileTools } from '../../harnesses/codexFiles/declarations.js'
import type { PostgresArtifactPublicationAuthority } from './nativeArtifactAuthority.js'
import { DomainError } from '../../errors.js'

export const WORKFLOW_NATIVE_FILE_CONTEXT_OPERATION = 'remote.native-artifact.context'
export const WORKFLOW_NATIVE_FILE_CONVERSATION_PREFIX = 'workflow-native-files:v1:'
export function workflowNativeFileConversationKey(mainId: string, executionId: string, attemptId: string): string {
  return `${WORKFLOW_NATIVE_FILE_CONVERSATION_PREFIX}${JSON.stringify([mainId, executionId, attemptId])}`
}
export interface WorkflowNativeFileContextPorts {
  captures: WorkflowNativeVerificationPort
  /** Mount the existing production remote workflow's actual SQL-only physical verifier. */
  assertPhysical(sql: GraphTransactionSql, owner: RunOwnership, capture: WorkflowNativeCapture): Promise<void>
  authority: Pick<PostgresArtifactPublicationAuthority, 'authorize'>
}
interface Admission {
  version: 1
  conversationKey: string
  commandId: string
  proofId: string
  sourceDigest: string
  session: NativeSessionReference
  attempt: AcceptedArtifactPublication['attempt']
  agentConfigurationVersionId: string
  workingDirectory: string
  runtimeDirectory: string
  context: FileToolContext
}
const denied = (reason: string): never => {
  throw new DomainError('NATIVE_ARTIFACT_CONTEXT_DENIED',
    'The original running workflow file context is not proven or authorized.', 403, { reason })
}
const conflict = (): never => { throw new DomainError('NATIVE_ARTIFACT_CONTEXT_CONFLICT', 'The original workflow file-context admission differs.', 409) }
const digest = (key: string) => createHash('sha256').update(key).digest('hex')

/** Private Main admission on the existing native/G1 transaction. No pool,
 * provider IO, human message, credentials, chat fork or synthetic native fact. */
export class WorkflowNativeFileContextAdmission {
  constructor(private readonly mainId: string, private readonly ports: WorkflowNativeFileContextPorts) {}
  /** Later captures read the first durable admission. Their proof never replaces its original source. */
  async resolveOrAdmitLocked(sql: GraphTransactionSql, evidence: RepeatNativeEvidence, proof: WorkflowNativeProofRecord,
    rawTransfer: TransferContext): Promise<AcceptedArtifactPublication> {
    assertGraphTransaction(sql)
    try {
      const capture = this.ports.captures.read(evidence), transferContext = TransferContextSchema.parse(rawTransfer)
      // The proof retains its first lease; verify the current lease against the live lane below.
      if (!capture.lane?.providerId || !['event', 'history'].includes(capture.source.type)
        || capture.source.type === 'history' && (capture.source.history.terminalTurn !== undefined
          || capture.source.history.nativeTurnId !== undefined && capture.source.history.nativeTurnId !== capture.lane.providerId)
        || capture.owner.runId !== proof.scope.runId || proof.scope.executionSemanticsVersion !== 3
        || proof.commandId !== `execution:${capture.execution.id}` || !same(proof.execution, repeatExecutionIdentity(capture.execution))
        || !same(proof.session, capture.session) || !same(proof.original, capture.source)
        || proof.lane?.id !== capture.lane.id || proof.lane.providerId !== capture.lane.providerId) return denied('captured_source_changed')
      const original = await readDispatchIntent(sql, capture.execution.id)
      const intent = original && await readReconciledDispatchIntent(sql, original.operationId, true)
      if (!intent || intent.mainId !== this.mainId || intent.runId !== proof.scope.runId || intent.nodeId !== proof.ref.nodeId
        || intent.inputDigest !== proof.inputDigest || intent.technicalAttempt !== capture.execution.attempt) return denied('dispatch_changed')
      const key = workflowNativeFileConversationKey(this.mainId, capture.execution.id, intent.attemptId)
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [key])
      const rows = (await sql.query<{ id: string; record: { workflowFileContext?: Admission } }>(
        "select id,record from operator_conversations where agent_key=$1 and kind='agent' and deleted_at is null for share", [key])).rows
      if (rows.length === 0) {
        if (capture.source.type === 'event' && capture.source.event.type !== 'turn.started') return denied('initial_turn_missing')
        return await this.admitLocked(sql, evidence, proof, transferContext)
      }
      if (rows.length !== 1) return conflict()
      const conversation = rows[0]!, admission = conversation.record.workflowFileContext
      if (!admission || admission.version !== 1 || admission.conversationKey !== key
        || conversation.id !== `workflow-native-files-${digest(key)}` || admission.commandId !== `execution:${capture.execution.id}`
        || !same(admission.session, capture.session) || admission.context.nativeSessionId !== capture.session.nativeSessionId
        || admission.context.scope.chat.kind !== 'agent'
        || admission.context.scope.chat.conversationId !== conversation.id
        || admission.agentConfigurationVersionId !== capture.execution.agentConfigurationVersionId
        || admission.workingDirectory !== capture.execution.workingDirectory || admission.runtimeDirectory !== capture.execution.runtimeDirectory
        || admission.attempt.executionId !== intent.executionId || admission.attempt.runId !== intent.runId
        || admission.attempt.nodeId !== intent.nodeId || admission.attempt.attemptId !== intent.attemptId
        || admission.attempt.placementHash !== intent.bindingHash || admission.attempt.workspaceId !== proof.scope.workspaceId
        || admission.attempt.workflowId !== proof.scope.workflowId) return conflict()
      const active = await this.currentTurnContext(sql, capture, admission, intent)
      const accepted = { context: active.context, attempt: ArtifactAttemptSchema.parse(admission.attempt), transferContext }
      const fence = await capture.owner.readOneShotFence(sql)
      const verify = async () => {
        capture.assertCurrent(); capture.owner.assertOwned()
        if (!same(fence, await capture.owner.readOneShotFence(sql))) return denied('run_owner_changed')
        await this.ports.assertPhysical(sql, capture.owner, capture)
        const running = await sql.query(`select 1 from runs r join harness_executions e on e.run_id=r.id
          where r.id=$1 and e.id=$2 and r.stop_requested_at is null and r.execution_state in ('running','waiting')
          and r.record->>'authorizationPrincipalId'=$3 and e.record->>'state' in ('running','waiting')
          and e.record->>'nativeSessionId'=$4 and e.record->>'workingDirectory'=$5 and e.record->>'runtimeDirectory'=$6 for share of r,e`,
        [intent.runId, intent.executionId, admission.context.ownerPrincipalId, admission.context.nativeSessionId,
          admission.workingDirectory, admission.runtimeDirectory])
        if (running.rowCount !== 1) return denied('execution_not_running')
        const closure = (await sql.query<{ generation: string; expected_reference: unknown; closed: boolean }>(
          `select generation::text,expected_reference,(closed_at is not null or detached_at is not null) as closed
            from execution_native_closures where execution_id=$1 order by generation desc limit 1 for update`, [intent.executionId])).rows[0]
        const lane = (await sql.query<{ owner_agent_id: string; harness: string; native_session_id: string; generation: string;
          token: string | null; correlation: string | null; provider_id: string | null; held: boolean }>(
          `select owner_agent_id,harness,native_session_id,record->>'connectionGeneration' as generation,
            record->>'leaseToken' as token,record->>'correlationId' as correlation,record->>'currentTurnOrMessageId' as provider_id,
            coalesce((record->>'leaseExpiresAt')::timestamptz>clock_timestamp(),false) as held
            from native_session_lanes where id=$1 for update`, [capture.lane!.id])).rows[0]
        if (!closure || closure.generation !== capture.closureGeneration || closure.closed
          || closure.expected_reference !== null && !same(closure.expected_reference, capture.session)
          || !lane || !lane.held || lane.owner_agent_id !== capture.execution.agentId || lane.harness !== capture.session.harness
          || lane.native_session_id !== capture.session.nativeSessionId || lane.token !== capture.lane!.token
          || lane.generation !== String(capture.lane!.connectionGeneration) || lane.provider_id !== capture.lane!.providerId
          || lane.correlation !== active.correlationId) return denied('native_lease_changed')
        const stored = (await sql.query<{ record: WorkflowNativeProofRecord; source_digest: string }>(
          'select record,source_digest from workflow_native_proofs where proof_id=$1 and run_id=$2 and execution_id=$3 for share',
          [admission.proofId, intent.runId, intent.executionId])).rows[0]
        if (!stored || stored.record.proofId !== admission.proofId || stored.source_digest !== admission.sourceDigest
          || repeatDigest(stored.record, REMOTE_NATIVE_SOURCE_LIMIT) !== admission.sourceDigest
          || !same(stored.record.scope, proof.scope) || !same(stored.record.ref, proof.ref)
          || !same(stored.record.execution, proof.execution) || !same(stored.record.session, admission.session)
          || stored.record.commandId !== admission.commandId || stored.record.inputDigest !== intent.inputDigest
          || stored.record.lane?.providerId !== admission.context.turnId) return conflict()
        const target = JSON.stringify([this.mainId, intent.executionId, intent.attemptId, admission.context.nativeSessionId, admission.context.turnId])
        const receipts = (await sql.query<{ principal_id: string; command_id: string; input_hash: string; result: unknown }>(
          'select principal_id,command_id,input_hash,result from management_command_receipts where operation=$1 and target_key=$2 for share',
          [WORKFLOW_NATIVE_FILE_CONTEXT_OPERATION, target])).rows
        if (receipts.length !== 1 || receipts[0]!.principal_id !== admission.context.ownerPrincipalId
          || receipts[0]!.command_id !== digest(target) || receipts[0]!.input_hash !== commandInputHash(admission)
          || !same(receipts[0]!.result, admission)) return conflict()
        const caller = await this.ports.authority.authorize(accepted, sql)
        if (caller.principal.id !== admission.context.ownerPrincipalId || !same(caller.context, active.context)) return denied('file_caller_changed')
        capture.assertCurrent()
      }
      await verify()
      const source = await currentRunGraphPublication(sql, proof.scope).retainNativeSource(capture.owner, admission.proofId)
      requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: proof.scope, ...source, effect: null })
      beforeGraphCommit(sql, async () => {
        try { await verify() } catch (error) { poisonGraphTransaction(sql); throw error }
      })
      return structuredClone(accepted)
    } catch (error) { poisonGraphTransaction(sql); throw error }
  }
  private async currentTurnContext(sql: GraphTransactionSql, capture: WorkflowNativeCapture,
    admission: Admission, intent: DispatchIntent): Promise<{ context: FileToolContext; correlationId: string }> {
    const turnId = capture.lane!.providerId!
    if (admission.context.turnId === turnId) return { context: admission.context, correlationId: admission.commandId }
    const row = (await sql.query<{ receipt: unknown }>(
      'select receipt from remote_execution_receipts where operation_id=$1 for share', [intent.operationId])).rows[0]
    const receipt = row && RemoteOperationReceiptSchema.parse(row.receipt)
    const repairs = receipt?.resultRepairs ?? []
    const correlationId = `${admission.commandId}:result-repair:${repairs.length}`
    if (!receipt || !same(receipt.intent, intent) || receipt.stopFence || receipt.terminal
      || receipt.native?.sessionId !== capture.session.nativeSessionId || receipt.native.turnId !== turnId
      || receipt.turnInput?.correlationId !== correlationId
      || !admission.context.turnId
      || !remoteWorkflowHasTurn(receipt, admission.context.nativeSessionId, admission.context.turnId)
      || !remoteWorkflowHasTurn(receipt, capture.session.nativeSessionId, turnId)) return conflict()
    await assertWorkflowCorrelation(sql, capture.execution.id, correlationId)
    return { context: { ...admission.context, turnId }, correlationId }
  }
  async admitLocked(sql: GraphTransactionSql, evidence: RepeatNativeEvidence, rawProof: WorkflowNativeProofRecord,
    rawTransfer: TransferContext): Promise<AcceptedArtifactPublication> {
    assertGraphTransaction(sql)
    try {
      const proof = structuredClone(rawProof)
      const capture = this.ports.captures.read(evidence), transferContext = TransferContextSchema.parse(rawTransfer)
      if (capture.session.harness !== 'codex' || !capture.lane?.providerId || !capture.closureGeneration
        || !['event', 'history'].includes(capture.source.type)
        || capture.source.type === 'history' && (capture.source.history.terminalTurn !== undefined
          || capture.source.history.nativeTurnId !== undefined && capture.source.history.nativeTurnId !== capture.lane.providerId) || capture.owner.runId !== proof.scope.runId
        || proof.scope.executionSemanticsVersion !== 3 || proof.commandId !== `execution:${capture.execution.id}`
        || !same(proof.execution, repeatExecutionIdentity(capture.execution)) || !same(proof.session, capture.session)
        || !same(proof.original, capture.source) || proof.lane?.providerId !== capture.lane.providerId) return denied('captured_source_changed')
      const owner = capture.owner, fence = await owner.readOneShotFence(sql)
      const verifyCapture = async () => {
        capture.assertCurrent(); owner.assertOwned()
        if (!same(fence, await owner.readOneShotFence(sql))) return denied('run_owner_changed')
        const row = (await sql.query<{ record: WorkflowNativeProofRecord; source_digest: string }>(
          'select record,source_digest from workflow_native_proofs where proof_id=$1 and run_id=$2 and execution_id=$3 for share',
          [proof.proofId, proof.scope.runId, capture.execution.id])).rows[0]
        if (!row || !same(row.record, proof) || row.source_digest !== repeatDigest(proof, REMOTE_NATIVE_SOURCE_LIMIT)) return denied('stored_proof_changed')
        const closure = (await sql.query<{ generation: string; expected_reference: unknown; closed: boolean }>(
          `select generation::text,expected_reference,(closed_at is not null or detached_at is not null) as closed
            from execution_native_closures where execution_id=$1 order by generation desc limit 1 for update`, [capture.execution.id])).rows[0]
        const lane = (await sql.query<{ owner_agent_id: string; harness: string; native_session_id: string; generation: string;
          token: string | null; correlation: string | null; provider_id: string | null; held: boolean }>(
          `select owner_agent_id,harness,native_session_id,record->>'connectionGeneration' as generation,
            record->>'leaseToken' as token,record->>'correlationId' as correlation,record->>'currentTurnOrMessageId' as provider_id,
            coalesce((record->>'leaseExpiresAt')::timestamptz>clock_timestamp(),false) as held
            from native_session_lanes where id=$1 for update`, [capture.lane!.id])).rows[0]
        if (!closure || closure.generation !== capture.closureGeneration || closure.closed
          || closure.expected_reference !== null && !same(closure.expected_reference, capture.session)
          || !lane || !lane.held || lane.owner_agent_id !== capture.execution.agentId || lane.harness !== capture.session.harness
          || lane.native_session_id !== capture.session.nativeSessionId || lane.token !== capture.lane!.token
          || lane.generation !== String(capture.lane!.connectionGeneration) || lane.provider_id !== capture.lane!.providerId
          || lane.correlation !== proof.commandId) return denied('native_lease_changed')
        await this.ports.assertPhysical(sql, owner, capture)
        capture.assertCurrent()
      }
      await verifyCapture()
      const original = await readDispatchIntent(sql, capture.execution.id)
      const intent = original && await readReconciledDispatchIntent(sql, original.operationId, true)
      if (!intent || intent.mainId !== this.mainId || intent.runId !== proof.scope.runId || intent.nodeId !== proof.ref.nodeId
        || intent.technicalAttempt !== capture.execution.attempt || intent.inputDigest !== proof.inputDigest) return denied('dispatch_changed')
      const row = (await sql.query<{ execution: unknown; configuration: unknown; workspace_id: string; workflow_id: string;
        workflow_version_id: string; authorization_principal_id: string; execution_state: string; stopped: boolean }>(
        `select e.record as execution,c.record as configuration,r.workspace_id,r.workflow_id,r.workflow_version_id,
          r.record->>'authorizationPrincipalId' as authorization_principal_id,r.execution_state,r.stop_requested_at is not null as stopped
          from harness_executions e join runs r on r.id=e.run_id
          join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId' and c.agent_id=e.agent_id
          where e.id=$1 and r.id=$2 for share of e,r,c`, [capture.execution.id, proof.scope.runId])).rows[0]
      if (!row || row.stopped || !['running', 'waiting'].includes(row.execution_state) || row.workspace_id !== proof.scope.workspaceId
        || row.workflow_id !== proof.scope.workflowId || row.workflow_version_id !== proof.scope.workflowVersionId) return denied('run_not_running')
      const execution = HarnessExecutionSchema.parse(row.execution), configuration = AgentConfigurationVersionSchema.parse(row.configuration)
      if (!['running', 'waiting'].includes(execution.state) || !execution.workingDirectory || !execution.runtimeDirectory
        || !same(repeatExecutionIdentity(execution), proof.execution) || execution.runId !== proof.scope.runId
        || execution.nativeSessionId !== capture.session.nativeSessionId || configuration.harness.harness !== 'codex'
        || configuration.id !== execution.agentConfigurationVersionId || configuration.agentId !== execution.agentId
        || configuration.workspaceId !== row.workspace_id || execution.workingDirectory !== capture.execution.workingDirectory
        || execution.runtimeDirectory !== capture.execution.runtimeDirectory || !same(execution.input, capture.execution.input)) return denied('execution_changed')
      const principal = await readLiveManagementPrincipal(sql, row.authorization_principal_id)
      const resource = { workspaceId: row.workspace_id, workflowId: row.workflow_id, runId: execution.runId }
      requireAuthorization(principal, 'agent_chat:read', resource)
      const allowMutation = configuration.harness.sandbox === 'workspace-write'
      if (allowMutation) requireAuthorization(principal, 'agent_chat:write', resource)
      const attempt = ArtifactAttemptSchema.parse({ workspaceId: row.workspace_id, workflowId: row.workflow_id,
        runId: execution.runId, nodeId: execution.workflowNodeId, executionId: execution.id,
        attemptId: intent.attemptId, placementHash: intent.bindingHash })
      const key = workflowNativeFileConversationKey(this.mainId, execution.id, intent.attemptId)
      const conversationId = `workflow-native-files-${digest(key)}`
      const context: FileToolContext = { ownerPrincipalId: principal.id, scope: { kind: 'temporary', chat: {
        kind: 'agent', conversationId, ...resource, executionId: execution.id, agentId: execution.agentId } },
      nativeSessionId: capture.session.nativeSessionId, turnId: capture.lane.providerId, allowMutation,
      allowedTools: codexChatFileTools(configuration.harness) }
      const admission: Admission = { version: 1, conversationKey: key, commandId: proof.commandId, proofId: proof.proofId,
        sourceDigest: repeatDigest(proof, REMOTE_NATIVE_SOURCE_LIMIT), session: capture.session, attempt,
        agentConfigurationVersionId: configuration.id, workingDirectory: execution.workingDirectory,
        runtimeDirectory: execution.runtimeDirectory, context }
      const target = JSON.stringify([this.mainId, execution.id, intent.attemptId, context.nativeSessionId, context.turnId])
      const commandId = digest(target), inputHash = commandInputHash(admission)
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [key])
      const conversationRecord = { origin: { kind: 'run_execution', runId: execution.runId, executionId: execution.id,
        sourceNativeSessionId: capture.session.nativeSessionId }, workingDirectory: execution.workingDirectory,
      runtimeDirectory: execution.runtimeDirectory, workflowFileContext: admission }
      await sql.query(`insert into operator_conversations(id,kind,agent_key,workspace_id,workflow_id,workflow_node_id,agent_id,
        agent_configuration_version_id,origin_run_id,origin_execution_id,harness,provider_version,native_session_id,record)
        values($1,'agent',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) on conflict do nothing`,
      [conversationId, key, row.workspace_id, row.workflow_id, execution.workflowNodeId, execution.agentId, configuration.id,
        execution.runId, execution.id, capture.session.harness, capture.session.providerVersion, capture.session.nativeSessionId, JSON.stringify(conversationRecord)])
      const verifyContext = async () => {
        const running = await sql.query(`select 1 from runs r join harness_executions e on e.run_id=r.id
          where r.id=$1 and e.id=$2 and r.stop_requested_at is null and r.execution_state in ('running','waiting')
          and r.record->>'authorizationPrincipalId'=$3 and e.record->>'state' in ('running','waiting')
          and e.record->>'nativeSessionId'=$4 and e.record->>'workingDirectory'=$5 and e.record->>'runtimeDirectory'=$6 for share of r,e`,
        [execution.runId, execution.id, principal.id, capture.session.nativeSessionId, execution.workingDirectory, execution.runtimeDirectory])
        if (running.rowCount !== 1) return denied('execution_not_running')
        const conversation = await sql.query(`select id from operator_conversations where id=$1 and kind='agent' and agent_key=$2 and deleted_at is null
          and workspace_id=$3 and workflow_id=$4 and workflow_node_id=$5 and agent_id=$6 and agent_configuration_version_id=$7
          and origin_run_id=$8 and origin_execution_id=$9 and harness=$10 and provider_version=$11 and native_session_id=$12
          and record=$13::jsonb for share`,
        [conversationId, key, row.workspace_id, row.workflow_id, execution.workflowNodeId, execution.agentId, configuration.id,
          execution.runId, execution.id, capture.session.harness, capture.session.providerVersion, capture.session.nativeSessionId, JSON.stringify(conversationRecord)])
        if (conversation.rowCount !== 1) return conflict()
        const accepted = { context, attempt, transferContext }
        const caller = await this.ports.authority.authorize(accepted, sql)
        if (caller.principal.id !== principal.id || !same(caller.context, context)) return denied('file_caller_changed')
      }
      await verifyContext()
      const inserted = await sql.query(`insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result)
        values($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing`,
      [principal.id, WORKFLOW_NATIVE_FILE_CONTEXT_OPERATION, commandId, target, inputHash, JSON.stringify(admission)])
      const receipt = (await sql.query<{ principal_id: string; command_id: string; input_hash: string; result: unknown }>(
        'select principal_id,command_id,input_hash,result from management_command_receipts where operation=$1 and target_key=$2 for share',
        [WORKFLOW_NATIVE_FILE_CONTEXT_OPERATION, target])).rows
      if (receipt.length !== 1 || receipt[0]!.principal_id !== principal.id || receipt[0]!.command_id !== commandId
        || receipt[0]!.input_hash !== inputHash || !same(receipt[0]!.result, admission)) return conflict()
      if (inserted.rowCount === 1) await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
        values($1,'device',$2,$3,'succeeded',$4::jsonb)`,
      [principal.id, WORKFLOW_NATIVE_FILE_CONTEXT_OPERATION, target, JSON.stringify({ commandId: proof.commandId, proofId: proof.proofId })])
      const publication = currentRunGraphPublication(sql, proof.scope)
      const source = await publication.retainNativeSource(owner, proof.proofId)
      requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: proof.scope, ...source, effect: null })
      beforeGraphCommit(sql, async () => {
        try { await verifyCapture(); await verifyContext() }
        catch (error) { poisonGraphTransaction(sql); throw error }
      })
      return structuredClone({ context, attempt, transferContext })
    } catch (error) { poisonGraphTransaction(sql); throw error }
  }
}
