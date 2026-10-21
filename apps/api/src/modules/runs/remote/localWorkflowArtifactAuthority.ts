import { isDeepStrictEqual as same } from 'node:util'
import type pg from 'pg'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { ArtifactAttemptSchema, type ArtifactAttempt } from '@foreman-code/contracts/artifact-edges'
import { SavedRunVersionSnapshotSchema, AcceptedWorkflowRunV3Schema, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { readLiveManagementPrincipal } from '../../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../../access/policy.js'
import { DomainError } from '../../errors.js'
import type { FileQuery } from '../../files/repository.js'
import { bindingIdentity } from '../../files/tools/context.js'
import type { AuthorizedFileCaller, FileToolContext } from '../../files/tools/types.js'
import { codexChatFileTools } from '../../harnesses/codexFiles/declarations.js'
import type { ExecutionRunAuthorityPort } from '../../placement/executionAuthority.js'
import { readDispatchIntent, readAcceptedPlacement } from '../../placement/persistence.js'
import type { AgentPlacementProducer } from '../../placement/agentProducer.js'
import { readReconciledDispatchIntent } from './persistence.js'
import { repeatDigest, repeatExecutionIdentity } from '../repeatResolution.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'

const denied = (reason?: string): never => {
  throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED', 'The original local artifact execution is unavailable.', 403,
    reason === undefined ? undefined : { reason })
}

export async function workflowArtifactsAreLocal(sql: FileQuery, runId: string, nodeId: string): Promise<boolean> {
  const placement = await readAcceptedPlacement(sql, runId, nodeId)
  return !placement || placement.hostRef.kind === 'main'
}

export class LocalWorkflowArtifactAuthority {
  constructor(readonly mainId: string, private readonly pool: pg.Pool,
    private readonly locations: ExecutionRunAuthorityPort,
    private readonly producer: Pick<AgentPlacementProducer, 'assertPinsCurrent'>) {}

  async execution(sql: FileQuery, executionId: string) {
    const row = (await sql.query<{ run: unknown; version: unknown; execution: unknown; configuration: unknown }>(
      `with parent as materialized (
         select id,record,workflow_version_id from runs
         where id=(select run_id from harness_executions where id=$1) for share
       )
       select r.record as run,v.record as version,e.record as execution,c.record as configuration
       from parent r join harness_executions e on e.run_id=r.id
       join workflow_versions v on v.id=r.workflow_version_id
       join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId' and c.agent_id=e.agent_id
       where e.id=$1 for share of e,v,c`, [executionId])).rows[0]
    if (!row) return denied()
    const snapshot = SavedRunVersionSnapshotSchema.parse({ run: row.run, version: row.version })
    const run = AcceptedWorkflowRunV3Schema.parse(snapshot.run)
    const version = WorkflowVersionV3Schema.parse(snapshot.version)
    const execution = HarnessExecutionSchema.parse(row.execution)
    const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
    const node = version.definition.nodes.find(item => item.id === execution.workflowNodeId)
    if (!node || node.kind === 'job' || !node.artifactOutputs
      || run.workflowVersionId !== version.id || execution.runId !== run.id || node.agentId !== execution.agentId
      || version.agentConfigurationVersionIds[execution.agentId] !== configuration.id
      || configuration.id !== execution.agentConfigurationVersionId || configuration.agentId !== execution.agentId
      || configuration.workspaceId !== run.workspaceId || configuration.harness.harness === 'claude') return denied()
    const principal = await readLiveManagementPrincipal(sql, run.authorizationPrincipalId)
    await this.locations.revalidateRunAuthorization(principal.id, run.workspaceId, run.workflowId, sql, true)
    const placement = await readAcceptedPlacement(sql, run.id, execution.workflowNodeId)
    const original = await readDispatchIntent(sql, executionId)
    const intent = original && await readReconciledDispatchIntent(sql, original.operationId, true)
    if (placement) {
      if (placement.hostRef.kind !== 'main' || placement.mainId !== this.mainId || !intent
        || intent.runId !== run.id || intent.nodeId !== node.id || intent.executionId !== executionId
        || intent.technicalAttempt !== execution.attempt || intent.inputDigest !== repeatDigest(execution.input)
        || intent.bindingHash !== placement.bindingHash || placement.payload.kind !== 'agent'
        || !same(placement.payload.artifactOutputs, node.artifactOutputs)
        || placement.payload.agentConfigurationVersionId !== configuration.id) return denied()
      await this.producer.assertPinsCurrent(sql, placement, principal, run.workspaceId,
        execution.nativeSessionId ? { purpose: 'resident' } : undefined)
    } else if (intent || run.executionLocation?.runnerId !== 'runner-local') return denied()
    const attempt = ArtifactAttemptSchema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
      runId: run.id, nodeId: node.id, executionId, attemptId: intent?.attemptId ?? `local:${executionId}:${execution.attempt}`,
      placementHash: intent?.bindingHash ?? repeatDigest({ mainId: this.mainId, execution: repeatExecutionIdentity(execution),
        inputDigest: repeatDigest(execution.input), location: run.executionLocation }).slice('sha256:'.length) })
    return { run, version, execution, configuration, node, principal, attempt }
  }

  async context(executionId: string, options: {
    query?: FileQuery; mutation?: boolean
  } = {}): Promise<{
    attempt: ArtifactAttempt; caller: AuthorizedFileCaller
  }> {
    const query = options.query ?? this.pool
    const current = await this.execution(query, executionId)
    const conversation = (await query.query<{ id: string; record: { localWorkflowFileContext?: {
      context: FileToolContext; attempt: ArtifactAttempt; proof: WorkflowNativeProofRecord
    } } }>(`select id,record from operator_conversations where origin_execution_id=$1 and kind='agent'
       and workspace_id=$2 and workflow_id=$3 and agent_id=$4 and origin_run_id=$5
       and agent_configuration_version_id=$6 and harness=$10 and native_session_id=$7
       and record#>>'{origin,sourceNativeSessionId}'=$7
       and record->>'workingDirectory'=$8 and record->>'runtimeDirectory'=$9
       and deleted_at is null and record ? 'localWorkflowFileContext' for share`,
    [executionId, current.run.workspaceId, current.run.workflowId, current.execution.agentId, current.run.id,
      current.configuration.id, current.execution.nativeSessionId,
      current.execution.workingDirectory, current.execution.runtimeDirectory, current.configuration.harness.harness])).rows
    if (!conversation.length) throw new DomainError('NATIVE_ARTIFACT_CONTEXT_PENDING',
      'The original native output context is awaiting its committed turn source.', 409)
    const admission = conversation[0]?.record.localWorkflowFileContext
    if (conversation.length !== 1 || !admission || !same(admission.attempt, current.attempt)) {
      return denied('The saved artifact context belongs to a different attempt.')
    }
    const { context, proof } = admission
    const scope = context.scope.chat
    if (scope.kind !== 'agent' || scope.conversationId !== conversation[0]!.id
      || scope.workspaceId !== current.run.workspaceId || scope.workflowId !== current.run.workflowId
      || scope.runId !== current.run.id || scope.executionId !== executionId || scope.agentId !== current.execution.agentId
      || current.execution.nativeSessionId !== context.nativeSessionId || context.nativeSessionId !== proof.session.nativeSessionId
      || context.turnId !== proof.lane?.providerId || context.ownerPrincipalId !== current.principal.id) {
      return denied('The saved artifact context does not match the execution, native turn or owner.')
    }
    const stored = (await query.query<{ record: WorkflowNativeProofRecord; source_digest: string }>(
      'select record,source_digest from workflow_native_proofs where proof_id=$1 and run_id=$2 and execution_id=$3 for share',
      [proof.proofId, current.run.id, executionId])).rows[0]
    if (!stored || !same(stored.record, proof) || stored.source_digest !== repeatDigest(proof, 4 * 1024 * 1024)) {
      return denied('The saved artifact context does not match its original native source.')
    }
    requireAuthorization(current.principal, 'agent_chat:read', { workspaceId: current.run.workspaceId,
      workflowId: current.run.workflowId, runId: current.run.id })
    if (options.mutation) await this.assertWritable(query, current, context)
    return { attempt: current.attempt, caller: { principal: current.principal, context, binding: bindingIdentity(context) } }
  }

  async assertDeclarations(executionId: string, query: FileQuery = this.pool): Promise<void> {
    const current = await this.execution(query, executionId)
    const harness = current.configuration.harness
    if (harness.harness !== 'codex' || harness.sandbox !== 'workspace-write'
      || !codexChatFileTools(harness).includes('files.write_working_copy')
      || !codexChatFileTools(harness).includes('files.publish_result')) return denied()
    requireAuthorization(current.principal, 'agent_chat:write', { workspaceId: current.run.workspaceId,
      workflowId: current.run.workflowId, runId: current.run.id })
  }

  private async assertWritable(query: FileQuery, current: Awaited<ReturnType<LocalWorkflowArtifactAuthority['execution']>>,
    context: FileToolContext): Promise<void> {
    await this.assertDeclarations(current.execution.id, query)
    if (!context.allowMutation || !context.allowedTools.includes('files.publish_result')
      || !['running', 'waiting'].includes(current.execution.state)) {
      return denied('The saved artifact context cannot write in this execution state.')
    }
    const live = await query.query<{
      stopped: boolean; cleanup: boolean; closed: boolean; detached: boolean;
      correlation_matches: boolean; turn_matches: boolean; lease_held: boolean | null
    }>(`select r.stop_requested_at is not null as stopped,
      exists(select 1 from run_cleanup_intents where run_id=r.id and pending) as cleanup,
      c.closed_at is not null as closed,c.detached_at is not null as detached,
      l.record->>'correlationId'=$5 as correlation_matches,l.record->>'currentTurnOrMessageId'=$6 as turn_matches,
      (l.record->>'leaseExpiresAt')::timestamptz>clock_timestamp() as lease_held
      from runs r join execution_native_closures c on c.execution_id=$2
      join native_session_lanes l on l.harness=$7 and l.native_session_id=$3 and l.owner_agent_id=$4
      where r.id=$1
      and c.generation=(select max(generation) from execution_native_closures where execution_id=$2)
      for share of r,c,l`,
    [current.run.id, current.execution.id, context.nativeSessionId, current.execution.agentId,
      `execution:${current.execution.id}`, context.turnId, current.configuration.harness.harness])
    const state = live.rows[0]
    if (live.rowCount !== 1 || !state || state.stopped || state.cleanup || state.closed || state.detached
      || state.correlation_matches !== true || state.turn_matches !== true || state.lease_held !== true) {
      throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED', 'The original local artifact execution is unavailable.', 403,
        { reason: 'The original native lifetime and turn writer are not active.', ...(state ? { conditions: state } : {}) })
    }
  }
}
