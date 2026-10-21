import { readPublicProjectionLocked } from '../../run-graph/compactSnapshot.js'
import { isDeepStrictEqual as same } from 'node:util'
import type { Readable } from 'node:stream'
import type pg from 'pg'
import type { HarnessExecution, ResultProtocol } from '@foreman-code/contracts'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema } from '@foreman-code/contracts/files'
import { type AcceptedWorkflowRunV3, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../../errors.js'
import type { FileQuery } from '../../files/repository.js'
import type { TemporaryFileService } from '../../files/service.js'
import { PostgresFileRepository } from '../../files/postgres.js'
import { fileScopeIdentity } from '../../files/requests.js'
import { digest, targetOf } from '../../files/tools/context.js'
import { PostgresFileToolRepository } from '../../files/tools/postgres.js'
import type { FileToolContext, PublicationLink } from '../../files/tools/types.js'
import { codexChatFileTools } from '../../harnesses/codexFiles/declarations.js'
import type { WorkflowNativeCapture } from '../../interactions/workflowNativeCapture.js'
import { assertGraphTransaction, beforeGraphCommit, poisonGraphTransaction,
  type GraphTransactionSql } from '../../run-graph/connection.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from '../../run-graph/repeatReceipts.js'
import { openRunGraphPublication } from '../../run-graph/publication.js'
import { repeatDigest, repeatExecutionIdentity } from '../repeatResolution.js'
import { workflowRunScope } from '../repeatLifecycle.js'
import { readAcceptedRepeatRunLocked } from '../repeatStartRead.js'
import { readRepeatExecutionLocked } from '../repeatPostgres.js'
import { assertSettlementLocked } from '../repeatSettlementServices.js'
import { readWorkflowTerminalReceiptLocked } from '../workflowTerminalReceipt.js'
import type { RunOwnership } from '../ownership.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import { LocalNativeArtifactOutputSchema, type LocalNativeArtifactOutput } from './nativeArtifactOutputs.js'
import { assertNativeArtifactOutputLive, PostgresNativeArtifactOutputRepository,
  readLocalNativeArtifactOutput } from './nativeArtifactOutputPostgres.js'
import { LocalWorkflowArtifactAuthority } from './localWorkflowArtifactAuthority.js'
import { workflowNativeFileConversationKey } from './workflowNativeFileContext.js'
import { workflowArtifactResult } from '../workflowCoordinationResult.js'

const conflict = (): never => {
  throw new DomainError('WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT', 'Local artifact publications differ from the saved native result.', 409)
}

function mappings(version: WorkflowVersionV3, execution: HarnessExecution, resultProtocol?: ResultProtocol) {
  const node = version.definition.nodes.find(item => item.id === execution.workflowNodeId)
  if (!node || node.kind === 'job' || !node.artifactOutputs || !execution.result) return conflict()
  try {
    return workflowArtifactResult(execution.result, version, node.id, resultProtocol).outputs
  } catch { return conflict() }
}

export class LocalWorkflowArtifacts {
  private readonly publications: PostgresFileToolRepository
  private readonly outputs: PostgresNativeArtifactOutputRepository
  private readonly metadata: PostgresFileRepository
  constructor(private readonly pool: pg.Pool, readonly authority: LocalWorkflowArtifactAuthority,
    private readonly files: () => TemporaryFileService) {
    this.publications = new PostgresFileToolRepository(pool)
    this.outputs = new PostgresNativeArtifactOutputRepository(pool, authority.mainId)
    this.metadata = new PostgresFileRepository(pool)
  }

  async admitContextLocked(sql: GraphTransactionSql, capture: WorkflowNativeCapture,
    proof: WorkflowNativeProofRecord): Promise<void> {
    assertGraphTransaction(sql)
    if (capture.session.harness !== 'codex' || !capture.lane?.providerId
      || !['running', 'waiting'].includes(capture.execution.state)
      || capture.source.type === 'event' && capture.source.event.type !== 'turn.started'
      || capture.source.type !== 'event' && capture.source.type !== 'history'
      || capture.source.type === 'history' && capture.source.history.terminalTurn) return
    const current = await this.authority.execution(sql, capture.execution.id)
    const key = workflowNativeFileConversationKey(this.authority.mainId, current.execution.id, current.attempt.attemptId)
    const conversationId = `workflow-native-files-${digest(key)}`
    const harness = current.configuration.harness
    if (harness.harness !== 'codex' || !same(proof.execution, repeatExecutionIdentity(capture.execution))
      || proof.inputDigest !== repeatDigest(capture.execution.input) || !same(proof.original, capture.source)
      || !same(proof.session, capture.session) || proof.lane?.providerId !== capture.lane.providerId) return conflict()
    const context: FileToolContext = { ownerPrincipalId: current.principal.id,
      scope: { kind: 'temporary', chat: { kind: 'agent', conversationId, workspaceId: current.run.workspaceId,
        workflowId: current.run.workflowId, runId: current.run.id, executionId: current.execution.id,
        agentId: current.execution.agentId } }, nativeSessionId: capture.session.nativeSessionId,
      turnId: capture.lane.providerId,
      allowMutation: harness.sandbox === 'workspace-write',
      allowedTools: codexChatFileTools(harness) }
    const record = { origin: { kind: 'run_execution', runId: current.run.id, executionId: current.execution.id,
      sourceNativeSessionId: capture.session.nativeSessionId }, workingDirectory: current.execution.workingDirectory,
      runtimeDirectory: current.execution.runtimeDirectory, localWorkflowFileContext: { context, attempt: current.attempt, proof } }
    const inserted = await sql.query(`insert into operator_conversations(id,kind,agent_key,workspace_id,workflow_id,workflow_node_id,agent_id,
      agent_configuration_version_id,origin_run_id,origin_execution_id,harness,provider_version,native_session_id,record)
      values($1,'agent',$2,$3,$4,$5,$6,$7,$8,$9,$13,$10,$11,$12::jsonb) on conflict do nothing`,
    [conversationId, key, current.run.workspaceId, current.run.workflowId, current.node.id, current.execution.agentId,
      current.configuration.id, current.run.id, current.execution.id, capture.session.providerVersion,
      capture.session.nativeSessionId, JSON.stringify(record), capture.session.harness])
    const verify = async () => {
      capture.assertCurrent()
      const admitted = await this.authority.context(current.execution.id, { query: sql })
      if (context.allowMutation) await this.authority.assertDeclarations(current.execution.id, sql)
      if (!same(admitted.caller.context, context) || !same(admitted.attempt, current.attempt)) return conflict()
      capture.assertCurrent()
    }
    await verify()
    if (inserted.rowCount === 1) await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,'mcp','workflow.native-artifact.context',$2,'succeeded',$3::jsonb)`,
    [current.principal.id, conversationId, JSON.stringify({ commandId: proof.commandId, proofId: proof.proofId })])
    requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: proof.scope, evidence: { sourceKind: 'native_event',
      sourceId: proof.proofId, sourceRevision: '1' }, sourceDigest: repeatDigest(proof, 4 * 1024 * 1024), effect: null })
    beforeGraphCommit(sql, verify)
  }

  async publish(executionId: string, raw: unknown, snapshot: {
    sha256: string; byteSize: number; open(): Promise<Readable>
  }, assertNativeCurrent?: (sql: FileQuery) => Promise<void>) {
    const accepted = await this.authority.context(executionId, { mutation: true })
    const { caller, attempt } = accepted
    const input = AgentFilePublishInputSchema.parse(raw)
    if (fileScopeIdentity(input.scope) !== fileScopeIdentity(caller.context.scope)) return conflict()
    const requestId = `fil05:local:${digest(input.commandId)}`
    const check = async (sql: FileQuery = this.pool) => {
      await assertNativeCurrent?.(sql)
      const current = await this.authority.context(executionId, { query: sql, mutation: true })
      if (!same(current, accepted)) return conflict()
      return current.caller
    }
    const guard = { source: 'mcp' as const, authorize: async (sql: FileQuery) => { await check(sql) } }
    const identity = digest(JSON.stringify([caller.binding, attempt, input.artifactId, snapshot.sha256, snapshot.byteSize]))
    const files = this.files()
    await check()
    const allocated = await files.allocateAgentResult(caller.principal, targetOf(caller.context), {
      requestId, filename: input.filename, mediaType: input.mediaType, sha256: snapshot.sha256, byteSize: snapshot.byteSize,
    }, 'agent_output', identity, guard)
    await check()
    await this.publications.linkPublication({ ownerPrincipalId: caller.principal.id, requestId,
      binding: caller.binding, context: caller.context,
      ref: { fileId: allocated.value.file.fileId, revisionId: allocated.value.revision.revisionId },
      createdAt: allocated.value.file.createdAt })
    if (allocated.value.file.state !== 'ready') {
      const stream = await snapshot.open()
      try {
        await files.upload(caller.principal, targetOf(caller.context), requestId, stream, {
          reauthorize: async () => (await check()).principal, commitAuthorization: guard,
          signal: AbortSignal.timeout(120_000), source: 'mcp',
        })
      } finally { stream.destroy() }
    }
    const finalized = await files.finalize((await check()).principal, targetOf(caller.context), requestId, 'mcp', guard)
    await check()
    return AgentFilePublishResultSchema.parse({ value: finalized.value, replayed: allocated.replayed })
  }

  private async publication(sql: FileQuery, executionId: string, outputKey: string,
    commandId: string): Promise<LocalNativeArtifactOutput> {
    const { attempt, caller } = await this.authority.context(executionId, { query: sql })
    const requestId = `fil05:local:${digest(commandId)}`
    const row = (await sql.query<{ record: PublicationLink }>(
      'select record from file_tool_publications where owner_principal_id=$1 and request_id=$2 for share',
      [caller.principal.id, requestId])).rows[0]
    if (!row || !same(row.record.context, caller.context) || row.record.binding !== caller.binding) return conflict()
    const stored = await this.metadata.read(row.record.ref.fileId, row.record.ref.revisionId, sql)
    if (!stored || fileScopeIdentity(stored.value.file.scope) !== fileScopeIdentity(caller.context.scope)) return conflict()
    const output = LocalNativeArtifactOutputSchema.parse({ version: 1, producer: attempt, outputKey, commandId,
      nativeIdentity: { nativeSessionId: caller.context.nativeSessionId, turnId: caller.context.turnId },
      publication: { ownerPrincipalId: caller.principal.id, requestId, binding: caller.binding },
      pins: { ...row.record.ref, sha256: stored.value.revision.sha256, byteSize: stored.value.revision.byteSize },
      scope: caller.context.scope, localPublication: { mainId: this.authority.mainId, executionId,
        attemptId: attempt.attemptId, placementHash: attempt.placementHash } })
    await assertNativeArtifactOutputLive(sql, this.authority.mainId, output)
    return output
  }

  async recover(owner: RunOwnership, execution: HarnessExecution, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (execution.state !== 'completed' || execution.result?.outcome !== 'succeeded') return
    const original = await owner.oneShotConnection().transaction(async sql => {
      const snapshot = await readAcceptedRepeatRunLocked(sql, owner.runId)
      await openRunGraphPublication(sql, workflowRunScope(snapshot.run), readPublicProjectionLocked)
      const stored = await readRepeatExecutionLocked(sql, snapshot, execution.id)
      if (!same(stored.execution, execution) || snapshot.stopRequested || snapshot.cleanupPending) return conflict()
      const source = await readWorkflowTerminalReceiptLocked(sql, snapshot, stored)
      await assertSettlementLocked(sql, snapshot.run, [execution.id], owner)
      return { ...source, mappings: mappings(snapshot.version, execution, snapshot.run.resultProtocol) }
    })
    for (const mapping of original.mappings) {
      signal.throwIfAborted()
      const output = await this.publication(this.pool, execution.id, mapping.outputKey, mapping.commandId)
      if (output.nativeIdentity.turnId !== original.proof.lane?.providerId) return conflict()
      const { caller } = await this.authority.context(execution.id)
      const opened = await this.files().download(caller.principal, targetOf(caller.context), {
        fileId: output.pins.fileId, revisionId: output.pins.revisionId,
      })
      opened.stream.destroy()
      signal.throwIfAborted()
      await this.outputs.bindLocal(output, async sql => {
        signal.throwIfAborted()
        const current = await this.publication(sql, execution.id, mapping.outputKey, mapping.commandId)
        if (!same(current, output)) return conflict()
      }, signal)
    }
  }

  async assertOutputsLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    version: WorkflowVersionV3, execution: HarnessExecution): Promise<void> {
    const verify = async () => {
      const current = await this.authority.execution(sql, execution.id)
      if (current.run.id !== run.id || current.version.id !== version.id || !same(current.execution, execution)) return conflict()
      const snapshot = await readAcceptedRepeatRunLocked(sql, run.id)
      const stored = await readRepeatExecutionLocked(sql, snapshot, execution.id)
      const source = await readWorkflowTerminalReceiptLocked(sql, snapshot, stored)
      for (const mapping of mappings(version, execution, run.resultProtocol)) {
        const output = await readLocalNativeArtifactOutput(sql, this.authority.mainId, current.attempt, mapping.outputKey)
        if (!output) throw new DomainError('WORKFLOW_ARTIFACT_OUTPUTS_PENDING', 'Local output adoption is pending.', 409)
        const publication = await this.publication(sql, execution.id, mapping.outputKey, mapping.commandId)
        if (!same(output, publication) || output.nativeIdentity.turnId !== source.proof.lane?.providerId) return conflict()
      }
    }
    assertGraphTransaction(sql)
    try { await verify() }
    catch (error) { poisonGraphTransaction(sql); throw error }
    beforeGraphCommit(sql, verify)
  }
}
