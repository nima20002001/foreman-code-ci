import type pg from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, NativeSessionReferenceSchema } from '@foreman-code/contracts'
import { ArtifactAttemptSchema, type ArtifactAttempt, type ArtifactGrantReference, type ArtifactEdgeBinding } from '@foreman-code/contracts/artifact-edges'
import { DeviceConnectionIdentitySchema, type DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import { WorkerMcpRelayRequestSchema, type WorkerMcpRelayRequest, type WorkerNativeOutputDeclarationsPolicy } from '@foreman-code/contracts/worker-mcp-relay'
import { WORKER_NATIVE_OUTPUT_FILE_OPERATIONS } from '@foreman-code/contracts/worker-native-output'
import { RemoteOperationReceiptSchema, remoteWorkflowHasTurn } from '@foreman-code/contracts/remote-execution'
import { VerifiedTransferReceiptSchema, type VerifiedTransferReceipt, type TransferContext } from '@foreman-code/contracts/byte-transfer'
import type { ArtifactPublicationAuthority, AcceptedArtifactPublication } from '../../files/distributed/publication.js'
import type { AcceptedArtifactAttemptFence } from '../../files/distributed/authorization.js'
import { bindingIdentity, digest, isMutation } from '../../files/tools/context.js'
import type { DistributedPublicationLink } from '../../files/distributed/publicationLedger.js'
import type { AuthorizedFileCaller, FileToolContext } from '../../files/tools/types.js'
import type { FileQuery } from '../../files/repository.js'
import { readLiveManagementPrincipal } from '../../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../../access/policy.js'
import { readDispatchIntent, readAcceptedPlacement, readNativePlacement } from '../../placement/persistence.js'
import { readReconciledDispatchIntent } from './persistence.js'
import type { ExecutionRunAuthorityPort } from '../../placement/executionAuthority.js'
import type { AgentPlacementProducer } from '../../placement/agentProducer.js'
import { assertDeviceHostInstallation } from '../../devices/hostAuthorization.js'
import { withExclusiveGraphConnection } from '../../run-graph/connection.js'
import { readNativeArtifactOutput } from './nativeArtifactOutputPostgres.js'
import { fileScopeIdentity } from '../../files/requests.js'
import { codexChatFileTools } from '../../harnesses/codexFiles/declarations.js'
import { DomainError } from '../../errors.js'

export interface NativeArtifactAuthorityPorts {
  locations: ExecutionRunAuthorityPort
  producer: Pick<AgentPlacementProducer, 'assertPinsCurrent'>
}
const denied = (): never => { throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED', 'The original accepted artifact attempt or native authority is unavailable.', 403) }
/** Shared SQL-only accepted attempt fence; consumer need not have launched a native session. */
async function acceptedAttempt(mainId: string, ports: NativeArtifactAuthorityPorts, raw: ArtifactAttempt, sql: FileQuery, grant?: ArtifactGrantReference) {
  const attempt = ArtifactAttemptSchema.parse(raw)
  const original = await readDispatchIntent(sql, attempt.executionId)
  const intent = original && await readReconciledDispatchIntent(sql, original.operationId, true)
  const placement = intent && await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
  if (!intent || !placement || intent.mainId !== mainId || placement.mainId !== mainId || intent.runId !== attempt.runId
    || intent.nodeId !== attempt.nodeId || intent.attemptId !== attempt.attemptId || intent.bindingHash !== attempt.placementHash
    || placement.bindingHash !== attempt.placementHash || placement.payload.kind !== 'agent') return denied()
  const row = (await sql.query<{ execution: unknown; configuration: unknown; workspace_id: string; workflow_id: string;
    authorization_principal_id: string; stopped: boolean }>(`select e.record as execution,c.record as configuration,r.workspace_id,r.workflow_id,
      r.record->>'authorizationPrincipalId' as authorization_principal_id,r.stop_requested_at is not null as stopped
    from harness_executions e join runs r on r.id=e.run_id
    join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId' and c.agent_id=e.agent_id
    where e.id=$1 and e.run_id=$2 for share of e,r,c`, [attempt.executionId, attempt.runId])).rows[0]
  if (!row || row.workspace_id !== attempt.workspaceId || row.workflow_id !== attempt.workflowId) return denied()
  const execution = HarnessExecutionSchema.parse(row.execution), configuration = AgentConfigurationVersionSchema.parse(row.configuration)
  if (execution.id !== attempt.executionId || execution.runId !== attempt.runId || execution.workflowNodeId !== attempt.nodeId
    || execution.attempt !== intent.technicalAttempt || execution.agentConfigurationVersionId !== placement.payload.agentConfigurationVersionId
    || execution.agentId !== placement.payload.agentId || configuration.id !== execution.agentConfigurationVersionId
    || configuration.agentId !== execution.agentId || configuration.workspaceId !== attempt.workspaceId) return denied()
  const principal = await readLiveManagementPrincipal(sql, row.authorization_principal_id)
  await ports.locations.revalidateRunAuthorization(principal.id, attempt.workspaceId, attempt.workflowId, sql, true)
  await ports.producer.assertPinsCurrent(sql, placement, principal, attempt.workspaceId,
    execution.nativeSessionId ? { purpose: 'resident' } : undefined)
  const registration = await assertDeviceHostInstallation(sql, placement.hostRef, placement.registration?.workerInstallationId ?? placement.mainInstallationId)
  if (placement.registration && (!registration || registration.keyRevision !== placement.registration.keyRevision
    || registration.authorizationRevision !== placement.registration.authorizationRevision)) return denied()
  if (grant && (grant.grantId !== intent.owner.grantId || grant.grantRevision !== intent.owner.epoch)) return denied()
  const live = await sql.query(`select 1 from execution_dispatch_owner_grants
    where execution_id=$1 and operation_id=$2 and grant_id=$3 and epoch=$4 and not revoked for share`,
  [attempt.executionId, intent.operationId, intent.owner.grantId, intent.owner.epoch])
  if (live.rowCount !== 1) return denied()
  return { intent, placement, execution, configuration, principal, stopped: row.stopped }
}

/** Current grants plus original DB-native evidence. No provider IO or credential issuance. */
export class PostgresArtifactPublicationAuthority implements ArtifactPublicationAuthority {
  constructor(private readonly mainId: string, private readonly pool: pg.Pool, private readonly ports: NativeArtifactAuthorityPorts) {}
  private async nativeOutputAttempt(input: WorkerMcpRelayRequest, connection: DeviceConnectionIdentity, sql: FileQuery) {
    // W07 owns and fences the authenticated epoch. Dispatch SQL stores the
    // original seven-field identity, so compare that exact projection here.
    const identity = DeviceConnectionIdentitySchema.parse({ mainId: connection.mainId, deviceId: connection.deviceId,
      workerInstallationId: connection.workerInstallationId, keyRevision: connection.keyRevision,
      authorizationRevision: connection.authorizationRevision, bootId: connection.bootId, connectionGeneration: connection.connectionGeneration })
    await sql.query('select id from runs where id=$1 for share', [input.intent.runId])
    const row = (await sql.query<{ workspace_id: string; workflow_id: string }>(`select r.workspace_id,r.workflow_id
      from runs r join harness_executions e on e.run_id=r.id where r.id=$1 and e.id=$2 for share of r,e`,
    [input.intent.runId, input.intent.executionId])).rows[0]
    if (!row) return denied()
    const attempt: ArtifactAttempt = { workspaceId: row.workspace_id, workflowId: row.workflow_id, runId: input.intent.runId,
      nodeId: input.intent.nodeId, executionId: input.intent.executionId, attemptId: input.intent.attemptId,
      placementHash: input.intent.bindingHash }
    const current = await acceptedAttempt(this.mainId, this.ports, attempt, sql)
    if (!isDeepStrictEqual(current.intent, input.intent) || !isDeepStrictEqual(current.placement, input.placement)
      || current.placement.payload.kind !== 'agent' || !current.placement.payload.artifactOutputs
      || current.placement.payload.agentId !== input.applicationAccess.agentId
      || current.stopped || !['starting', 'running', 'waiting'].includes(current.execution.state)) return denied()
    const cleanup = await sql.query('select 1 from run_cleanup_intents where run_id=$1 and pending for share', [input.intent.runId])
    if (cleanup.rowCount !== 0) return denied()
    const origin = (await sql.query<{ connection: unknown }>('select connection from remote_dispatch_origins where operation_id=$1 for share',
      [input.intent.operationId])).rows[0]
    if (!origin || !isDeepStrictEqual(DeviceConnectionIdentitySchema.parse(origin.connection), identity)) return denied()
    return { ...current, attempt, identity }
  }
  /** Original connection and durable native ACK are required for every mutation; reconnect is not a replacement turn. */
  async assertNativeOutputConnection(raw: Extract<WorkerMcpRelayRequest, { operation: 'worker-mcp.authorize-native-output' }>,
    connection: DeviceConnectionIdentity, sql: FileQuery): Promise<void> {
    const input = WorkerMcpRelayRequestSchema.parse(raw)
    if (input.operation !== 'worker-mcp.authorize-native-output') return denied()
    const current = await this.nativeOutputAttempt(input, connection, sql)
    const row = (await sql.query<{ receipt: unknown }>('select receipt from remote_execution_receipts where operation_id=$1 for share',
      [input.intent.operationId])).rows[0]
    const receipt = row && RemoteOperationReceiptSchema.parse(row.receipt)
    if (!receipt || !isDeepStrictEqual(receipt.intent, input.intent) || !isDeepStrictEqual(receipt.connection, current.identity)
      || receipt.stopFence || !['start_acknowledged', 'running'].includes(receipt.phase)
      || receipt.native?.sessionId !== input.nativeSessionId || receipt.native.turnId !== input.turnId) return denied()
  }
  /** Saved configuration and original owner permissions only. No native session/turn, scope, lease or qualification is invented. */
  async authorizeNativeOutputDeclarations(raw: Extract<WorkerMcpRelayRequest, { operation: 'worker-mcp.authorize-native-output-declarations' }>,
    connection: DeviceConnectionIdentity, sql: FileQuery): Promise<WorkerNativeOutputDeclarationsPolicy> {
    const input = WorkerMcpRelayRequestSchema.parse(raw)
    if (input.operation !== 'worker-mcp.authorize-native-output-declarations') return denied()
    const current = await this.nativeOutputAttempt(input, connection, sql)
    const harness = current.configuration.harness
    const outputOperations = ['create', 'append', 'seal', 'publish'] as const
    if (harness.harness !== 'codex' || harness.sandbox !== 'workspace-write'
      || outputOperations.some(operation => !codexChatFileTools(harness).includes(WORKER_NATIVE_OUTPUT_FILE_OPERATIONS[operation]))) return denied()
    requireAuthorization(current.principal, 'agent_chat:write', { workspaceId: current.configuration.workspaceId,
      workflowId: current.attempt.workflowId, runId: input.intent.runId })
    await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,'device','native_output.authorize_declarations',$2,'succeeded',$3::jsonb)`, [current.principal.id,
      `execution:${input.intent.executionId}`, JSON.stringify({ operationId: input.intent.operationId, attemptId: input.intent.attemptId,
        bindingHash: input.intent.bindingHash, agentConfigurationVersionId: current.configuration.id, outputOperations })])
    return { agentConfigurationVersionId: current.configuration.id, outputOperations: [...outputOperations] }
  }
  authorize(accepted: AcceptedArtifactPublication, query?: FileQuery): Promise<AuthorizedFileCaller> {
    return query ? this.locked(accepted, query) : withExclusiveGraphConnection(this.pool, connection => connection.transaction(sql => this.locked(accepted, sql)))
  }
  /** Reading an existing publication preserves its publishing turn; new writes still require the active turn. */
  authorizePublication(accepted: AcceptedArtifactPublication, query?: FileQuery): Promise<AuthorizedFileCaller> {
    const read = (sql: FileQuery) => this.locked(accepted, sql, { publicationRead: true })
    return query ? read(query) : withExclusiveGraphConnection(this.pool, connection => connection.transaction(read))
  }
  resolvePublicationContext(accepted: AcceptedArtifactPublication, commandId: string,
    query?: FileQuery): Promise<AcceptedArtifactPublication> {
    const read = async (sql: FileQuery) => {
      const current = await this.locked(accepted, sql)
      const requestId = `fil05:remote:${digest(commandId)}`
      const row = (await sql.query<{ record: DistributedPublicationLink }>(
        'select record from file_tool_publications where owner_principal_id=$1 and request_id=$2 for share',
        [current.principal.id, requestId])).rows[0]
      if (!row) throw new DomainError('FILE_PUBLICATION_PENDING', 'The original publication has not been recorded.', 409)
      const link = row.record
      if (link.ownerPrincipalId !== current.principal.id || link.requestId !== requestId
        || !isDeepStrictEqual({ ...link.context, turnId: accepted.context.turnId }, accepted.context)) return denied()
      const original = { ...accepted, context: structuredClone(link.context) }
      const caller = await this.locked(original, sql, { publicationRead: true })
      if (caller.binding !== link.binding) return denied()
      return original
    }
    return query ? read(query) : withExclusiveGraphConnection(this.pool, connection => connection.transaction(read))
  }
  /** Resolves an already admitted workflow conversation. It never creates a chat or forks a native session. */
  resolveWorkflowContext(attempt: ArtifactAttempt, transferContext: TransferContext, query?: FileQuery): Promise<AcceptedArtifactPublication> {
    return this.resolveAuthorizedWorkflowContext(attempt, transferContext, query).then(result => result.accepted)
  }
  resolveAuthorizedWorkflowContext(attempt: ArtifactAttempt, transferContext: TransferContext,
    query?: FileQuery): Promise<{ accepted: AcceptedArtifactPublication; authorized: AuthorizedFileCaller }> {
    const resolve = async (sql: FileQuery) => {
      const current = await acceptedAttempt(this.mainId, this.ports, attempt, sql)
      if (current.configuration.harness.harness !== 'codex' || !current.execution.nativeSessionId) return denied()
      const conversation = await sql.query<{ id: string }>(`select id from operator_conversations where kind='agent' and deleted_at is null
        and workspace_id=$1 and workflow_id=$2 and agent_id=$3 and origin_run_id=$4 and origin_execution_id=$5
        and native_session_id=$6 and agent_configuration_version_id=$7 and harness='codex'
        and record #>> '{origin,sourceNativeSessionId}'=$6
        and record->>'workingDirectory'=$8 and record->>'runtimeDirectory'=$9 for share`,
      [attempt.workspaceId, attempt.workflowId, current.execution.agentId, attempt.runId, attempt.executionId,
        current.execution.nativeSessionId, current.configuration.id, current.execution.workingDirectory, current.execution.runtimeDirectory])
      if (conversation.rowCount !== 1) throw new DomainError('NATIVE_ARTIFACT_CONTEXT_UNAVAILABLE',
        'The original workflow session has no exact admitted file conversation.', 409)
      const row = (await sql.query<{ receipt: unknown }>('select receipt from remote_execution_receipts where operation_id=$1 for share', [current.intent.operationId])).rows[0]
      const receipt = row && RemoteOperationReceiptSchema.parse(row.receipt)
      if (!receipt?.native?.turnId) return denied()
      const context: FileToolContext = { ownerPrincipalId: current.principal.id,
        scope: { kind: 'temporary', chat: { kind: 'agent', conversationId: conversation.rows[0]!.id,
          workspaceId: attempt.workspaceId, workflowId: attempt.workflowId, agentId: current.execution.agentId,
          runId: attempt.runId, executionId: attempt.executionId } },
        nativeSessionId: current.execution.nativeSessionId, turnId: receipt.native.turnId,
        allowMutation: current.configuration.harness.sandbox === 'workspace-write', allowedTools: codexChatFileTools(current.configuration.harness) }
      const accepted = { attempt: structuredClone(attempt), transferContext: structuredClone(transferContext), context }
      const authorized = await this.locked(accepted, sql, { loaded: current })
      return { accepted, authorized }
    }
    return query ? resolve(query) : withExclusiveGraphConnection(this.pool, connection => connection.transaction(resolve))
  }
  private async locked(accepted: AcceptedArtifactPublication, sql: FileQuery,
    options: { loaded?: Awaited<ReturnType<typeof acceptedAttempt>>; publicationRead?: true } = {}): Promise<AuthorizedFileCaller> {
    const current = options.loaded ?? await acceptedAttempt(this.mainId, this.ports, accepted.attempt, sql)
    const { context, transferContext: transfer } = accepted, scope = context.scope.chat
    if (current.placement.hostRef.kind !== 'device' || !current.placement.registration || scope.kind !== 'agent'
      || scope.workspaceId !== accepted.attempt.workspaceId || scope.workflowId !== accepted.attempt.workflowId
      || scope.runId !== accepted.attempt.runId || scope.executionId !== accepted.attempt.executionId || scope.agentId !== current.execution.agentId
      || transfer.mainId !== this.mainId || transfer.deviceId !== current.placement.hostRef.deviceId
      || transfer.workerInstallationId !== current.placement.registration.workerInstallationId
      || transfer.keyRevision !== current.placement.registration.keyRevision || transfer.authorizationRevision !== current.placement.registration.authorizationRevision) return denied()
    const principal = await readLiveManagementPrincipal(sql, context.ownerPrincipalId)
    requireAuthorization(principal, 'agent_chat:read', { workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId })
    // A broad reader cannot impersonate the original native publisher.
    if (principal.id !== current.principal.id) {
      const sender = await sql.query(`select 1 from run_authority_principals where principal_id=$1 and run_id=$2 and caller_principal_id=$3 for share`,
        [current.principal.id, accepted.attempt.runId, principal.id])
      if (sender.rowCount !== 1) return denied()
    }
    const conversation = await sql.query(`select id from operator_conversations where id=$1 and kind='agent' and deleted_at is null
      and workspace_id=$2 and workflow_id=$3 and agent_id=$4 and origin_run_id=$5 and origin_execution_id=$6
      and native_session_id=$7 and agent_configuration_version_id=$8 and harness=$9
      and record #>> '{origin,sourceNativeSessionId}'=$7
      and record->>'workingDirectory'=$10 and record->>'runtimeDirectory'=$11 for share`,
    [scope.conversationId, scope.workspaceId, scope.workflowId, scope.agentId, scope.runId, scope.executionId,
      context.nativeSessionId, current.configuration.id, current.configuration.harness.harness,
      current.execution.workingDirectory, current.execution.runtimeDirectory])
    if (conversation.rowCount !== 1) return denied()
    const originRow = (await sql.query<{ connection: unknown }>('select connection from remote_dispatch_origins where operation_id=$1 for share', [current.intent.operationId])).rows[0]
    const origin = originRow && DeviceConnectionIdentitySchema.parse(originRow.connection)
    if (!origin || origin.mainId !== transfer.mainId || origin.deviceId !== transfer.deviceId
      || origin.workerInstallationId !== transfer.workerInstallationId || origin.keyRevision !== transfer.keyRevision
      || origin.authorizationRevision !== transfer.authorizationRevision) return denied()
    const session = (await sql.query<{ reference: unknown }>('select reference from execution_native_sessions where execution_id=$1 for share', [accepted.attempt.executionId])).rows[0]
    const receiptRow = (await sql.query<{ receipt: unknown }>('select receipt from remote_execution_receipts where operation_id=$1 for share', [current.intent.operationId])).rows[0]
    const receipt = receiptRow && RemoteOperationReceiptSchema.parse(receiptRow.receipt)
    const reference = session && NativeSessionReferenceSchema.parse(session.reference)
    if (!reference || !receipt || !isDeepStrictEqual(receipt.intent, current.intent) || reference.harness !== current.configuration.harness.harness
      || !receipt.native?.turnId || receipt.native.sessionId !== reference.nativeSessionId || context.nativeSessionId !== reference.nativeSessionId
      || current.execution.nativeSessionId !== reference.nativeSessionId || context.nativeMessageId !== undefined
      || !context.turnId || (options.publicationRead
        ? !remoteWorkflowHasTurn(receipt, context.nativeSessionId, context.turnId)
        : context.turnId !== receipt.native.turnId)
      || receipt.connection.mainId !== transfer.mainId || receipt.connection.deviceId !== transfer.deviceId
      || receipt.connection.workerInstallationId !== transfer.workerInstallationId || receipt.connection.keyRevision !== transfer.keyRevision
      || receipt.connection.authorizationRevision !== transfer.authorizationRevision) return denied()
    if (context.messageId) {
      const message = await sql.query(`select t.message_id from operator_conversation_turns t
        join operator_conversation_messages m on m.id=t.message_id and m.conversation_id=t.conversation_id
        where t.conversation_id=$1 and t.message_id=$2 and t.native_turn_id=$3 and t.payload->>'ownerPrincipalId'=$4 for share of t,m`,
      [scope.conversationId, context.messageId, context.turnId, principal.id])
      if (message.rowCount !== 1) return denied()
    }
    const harness = current.configuration.harness
    if (harness.harness !== 'codex') return denied()
    const canWrite = harness.sandbox === 'workspace-write'
    if (context.allowMutation && !canWrite || context.allowedTools.some(tool => isMutation(tool) && (!context.allowMutation || !canWrite))
      || context.allowedTools.some(tool => !codexChatFileTools(harness).includes(tool))) return denied()
    if (context.allowMutation) requireAuthorization(principal, 'agent_chat:write', {
      workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId })
    return { context: structuredClone(context), principal, binding: bindingIdentity(context) }
  }
  async assertSourceLive(accepted: AcceptedArtifactPublication, raw: VerifiedTransferReceipt, query: FileQuery): Promise<void> {
    await this.locked(accepted, query)
    const receipt = VerifiedTransferReceiptSchema.parse(raw), intent = receipt.intent
    const current = await acceptedAttempt(this.mainId, this.ports, accepted.attempt, query)
    const source = current.placement.source
    if (current.stopped || !('kind' in source) || source.kind !== 'pending' || intent.mainId !== this.mainId || intent.deviceId !== accepted.transferContext.deviceId
      || intent.workerInstallationId !== accepted.transferContext.workerInstallationId || intent.keyRevision !== accepted.transferContext.keyRevision
      || intent.authorizationRevision !== accepted.transferContext.authorizationRevision || intent.executionId !== accepted.attempt.executionId
      || intent.operationId !== current.intent.operationId || intent.attemptId !== accepted.attempt.attemptId || intent.placementHash !== accepted.attempt.placementHash
      || intent.rootId !== source.rootId || intent.rootBindingRevision !== source.bindingRevision || intent.direction !== 'to-main' || intent.byteClass !== 'artifact'
      || receipt.transferId !== intent.transferId || receipt.sha256 !== intent.sha256 || receipt.byteSize !== intent.byteSize) return denied()
    const native = await readNativePlacement(query, accepted.attempt.executionId)
    if (!native || native.acceptedBindingHash !== accepted.attempt.placementHash) return denied()
  }
}
export class PostgresAcceptedArtifactAttemptFence implements AcceptedArtifactAttemptFence {
  constructor(private readonly mainId: string, private readonly ports: NativeArtifactAuthorityPorts) {}
  async assertCurrent(attempt: ArtifactAttempt, authority: ArtifactGrantReference, query: FileQuery): Promise<void> {
    const principal = await readLiveManagementPrincipal(query, authority.principalId)
    requireAuthorization(principal, 'agent_chat:read', { workspaceId: attempt.workspaceId, workflowId: attempt.workflowId, runId: attempt.runId })
    const current = await acceptedAttempt(this.mainId, this.ports, attempt, query, authority)
    if (principal.id !== current.principal.id) {
      const sender = await query.query(`select 1 from run_authority_principals where principal_id=$1 and run_id=$2 and caller_principal_id=$3 for share`,
        [current.principal.id, attempt.runId, principal.id])
      if (sender.rowCount !== 1) return denied()
    }
  }
  async assertPublishedOutput(binding: ArtifactEdgeBinding, query: FileQuery): Promise<void> {
    const original = await readNativeArtifactOutput(query, this.mainId, binding.producer, binding.outputKey)
    if (!original || !isDeepStrictEqual(original.publication, binding.publication) || !isDeepStrictEqual(original.pins, binding.pins)
      || fileScopeIdentity(original.scope) !== fileScopeIdentity(binding.scope) || original.publication.ownerPrincipalId !== binding.sender.principalId) return denied()
  }
}
