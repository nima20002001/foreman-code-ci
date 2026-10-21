import { randomUUID } from 'node:crypto'
import { withTransaction } from '../../../infrastructure/transaction.js'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import type { FastifyRequest } from 'fastify'
import { ArtifactAttemptSchema, type ArtifactAttempt, type ArtifactGrantReference } from '@foreman-code/contracts/artifact-edges'
import { BYTE_TRANSFER_POLICY, TransferIntentSchema, TransferContextSchema, type TransferContext, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { WorkflowArtifactTransferInputSchema, type WorkflowArtifactTransferInput } from '@foreman-code/contracts/workflow-artifact-transfer'
import { workflowArtifactTransferManifestDigest } from '@foreman-code/contracts/workflow-artifact-transfer-node'
import { bearerToken, type PostgresAccessService } from '../../access/postgres.js'
import { lockActiveWorkerPrincipal } from '../../access/workerLifecycle.js'
import { workerScopesForAction } from '../../access/appPolicy.js'
import { PostgresCommandCoordinator } from '../../commands/postgres.js'
import { BYTE_TRANSFER_NAMESPACE, createEndpointTransferReceiver, transferContextForBinding, type AcceptedTransferAuthority, type TransferOperation } from '../../byte-transfer/carrier.js'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import type { DistributedArtifactEndpointAuthorization } from '../../files/distributed/adapters.js'
import type { AcceptedArtifactPublication } from '../../files/distributed/publication.js'
import { readDispatchIntent, readAcceptedPlacement } from '../../placement/persistence.js'
import { readReconciledDispatchIntent } from './persistence.js'
import type { PostgresArtifactPublicationAuthority, PostgresAcceptedArtifactAttemptFence } from './nativeArtifactAuthority.js'
import { DomainError } from '../../errors.js'

const OPERATION = 'remote.artifact-transfer.admit'
const denied = (): never => { throw new DomainError('WORKFLOW_ARTIFACT_DENIED', 'The original workflow worker lease or artifact binding is unavailable.', 403) }
type Endpoint = Pick<DeviceEndpoint, 'currentBinding'>
type Authority = Pick<PostgresArtifactPublicationAuthority, 'resolveAuthorizedWorkflowContext'>
type Fence = Pick<PostgresAcceptedArtifactAttemptFence, 'assertCurrent'>
interface Caller {
  worker: ManagementPrincipal
  attempt: ArtifactAttempt
  authority: ArtifactGrantReference
  binding: Readonly<DeviceSessionBinding>
  intent: NonNullable<Awaited<ReturnType<typeof readDispatchIntent>>>
  placement: NonNullable<Awaited<ReturnType<typeof readAcceptedPlacement>>>
}
/** Actual W07 workflow credential only; no browser cookies, Operator exchange, or caller-selected execution. */
export class WorkflowArtifactEndpointAuthorization implements DistributedArtifactEndpointAuthorization {
  constructor(private readonly mainId: string, private readonly pool: pg.Pool,
    private readonly access: Pick<PostgresAccessService, 'authenticate'>, private readonly endpoint: Endpoint,
    private readonly publications: Authority, private readonly fence: Fence) {}
  authenticate(request: FastifyRequest) {
    return this.access.authenticate(bearerToken(request.headers.authorization), 'worker')
  }
  async transaction<T>(work: (sql: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, work)
  }
  async locked(sql: pg.PoolClient, snapshot: ManagementPrincipal): Promise<Caller> {
    if (snapshot.audience !== 'worker' || !snapshot.agentId) return denied()
    const worker = await lockActiveWorkerPrincipal(sql, snapshot)
    const rows = await sql.query<{ execution_id: string; run_id: string; agent_id: string; workspace_id: string;
      workflow_id: string; purpose: string;
      authorization_principal_id: string; stopped: boolean; cleanup: boolean }>(`select b.execution_id,b.run_id,b.agent_id,b.workspace_id,b.workflow_id,b.purpose,
      r.record->>'authorizationPrincipalId' as authorization_principal_id,r.stop_requested_at is not null as stopped,
      exists(select 1 from run_cleanup_intents i where i.run_id=r.id and i.pending) as cleanup
      from worker_credential_bindings b join harness_executions e on e.id=b.execution_id
      join runs r on r.id=b.run_id where b.principal_id=$1 for share of b,e,r`, [worker.id])
    const row = rows.rows[0]
    if (rows.rowCount !== 1 || !row || row.purpose !== 'workflow' || row.agent_id !== worker.agentId || row.stopped || row.cleanup) return denied()
    if (!workerScopesForAction(worker, 'interactions:read').some(scope => scope.workspaceIds?.includes(row.workspace_id)
      && scope.workflowIds?.includes(row.workflow_id) && scope.runIds?.includes(row.run_id))) return denied()
    const original = await readDispatchIntent(sql, row.execution_id)
    const intent = original && await readReconciledDispatchIntent(sql, original.operationId, true)
    const placement = intent && await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
    if (!intent || !placement || intent.mainId !== this.mainId || intent.executionId !== row.execution_id || intent.runId !== row.run_id
      || placement.mainId !== this.mainId || placement.runId !== row.run_id || placement.nodeId !== intent.nodeId
      || placement.bindingHash !== intent.bindingHash || placement.payload.kind !== 'agent' || placement.payload.agentId !== row.agent_id
      || placement.hostRef.kind !== 'device' || !placement.registration) return denied()
    const observed = this.endpoint.currentBinding(placement.hostRef.deviceId, BYTE_TRANSFER_NAMESPACE)
    const binding = observed && structuredClone(observed)
    if (!binding || binding.mainId !== this.mainId || binding.deviceId !== placement.hostRef.deviceId
      || binding.workerInstallationId !== placement.registration.workerInstallationId || binding.keyRevision !== placement.registration.keyRevision
      || binding.authorizationRevision !== placement.registration.authorizationRevision) return denied()
    const attempt = ArtifactAttemptSchema.parse({ workspaceId: row.workspace_id, workflowId: row.workflow_id, runId: row.run_id,
      nodeId: intent.nodeId, executionId: row.execution_id, attemptId: intent.attemptId, placementHash: intent.bindingHash })
    const authority = { principalId: row.authorization_principal_id, grantId: intent.owner.grantId, grantRevision: intent.owner.epoch }
    await this.fence.assertCurrent(attempt, authority, sql)
    if (worker.revokedAt || Date.parse(worker.expiresAt) <= Date.now()) return denied()
    this.assertConnection(binding)
    return { worker, attempt, authority, binding: structuredClone(binding), intent, placement }
  }
  assertConnection(binding: Readonly<DeviceSessionBinding>): void {
    if (!isDeepStrictEqual(this.endpoint.currentBinding(binding.deviceId, BYTE_TRANSFER_NAMESPACE), binding)) return denied()
  }
  async assertWorkerActive(sql: pg.PoolClient, caller: Caller): Promise<void> {
    // Parent, execution, principal and binding locks keep the loaded facts stable; expiry still advances.
    const live = await sql.query(`select id from management_principals
      where id=$1 and revoked_at is null and expires_at>clock_timestamp()`, [caller.worker.id])
    if (live.rowCount !== 1) return denied()
    this.assertConnection(caller.binding)
  }
  async publication(sql: pg.PoolClient, caller: Caller): Promise<AcceptedArtifactPublication> {
    const { accepted, authorized } = await this.publications.resolveAuthorizedWorkflowContext(
      caller.attempt, transferContextForBinding(caller.binding), sql)
    if (!isDeepStrictEqual(accepted.attempt, caller.attempt) || authorized.principal.id !== caller.authority.principalId
      || !isDeepStrictEqual(authorized.context, accepted.context)) return denied()
    this.assertConnection(caller.binding)
    return accepted
  }
  async consumer(request: FastifyRequest) {
    const worker = await this.authenticate(request)
    return this.transaction(async sql => {
      const caller = await this.locked(sql, worker)
      return { attempt: caller.attempt, authority: caller.authority }
    })
  }
  async producer(request: FastifyRequest) {
    const worker = await this.authenticate(request)
    return this.transaction(async sql => this.publication(sql, await this.locked(sql, worker)))
  }
}

interface Allocation { workerPrincipalId: string; accepted: AcceptedArtifactPublication; declaration: WorkflowArtifactTransferInput; intent: TransferIntent }
/** Main command ledger owns admission; the existing private byte receiver owns storage and verification. */
export class WorkflowArtifactTransfers implements AcceptedTransferAuthority {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly authorization: WorkflowArtifactEndpointAuthorization) {}
  async admit(request: FastifyRequest, raw: WorkflowArtifactTransferInput, source: 'http' | 'mcp' = 'http'): Promise<TransferIntent> {
    const declaration = WorkflowArtifactTransferInputSchema.parse(raw)
    const worker = await this.authorization.authenticate(request)
    let caller: Caller | undefined
    let accepted: AcceptedArtifactPublication | undefined
    const result = await this.commands.execute<Allocation>({ principal: worker, source, operation: OPERATION,
      commandId: declaration.commandId, targetKey: `workflow-artifact:${worker.id}`, payload: declaration,
      authorize: async sql => {
        caller = await this.authorization.locked(sql, worker)
        accepted = await this.writable(sql, caller)
      },
      perform: async sql => {
        if (!caller || !accepted) return denied()
        const root = caller.placement.source
        if (!('kind' in root) || root.kind !== 'pending') return denied()
        const intent = TransferIntentSchema.parse({ version: 1, ...transferContextForBinding(caller.binding), transferId: randomUUID(),
          operationId: caller.intent.operationId, executionId: caller.attempt.executionId, attemptId: caller.attempt.attemptId,
          placementHash: caller.attempt.placementHash, rootId: root.rootId, rootBindingRevision: root.bindingRevision,
          direction: 'to-main', byteClass: 'artifact', sha256: declaration.sha256, byteSize: declaration.byteSize,
          manifestDigest: workflowArtifactTransferManifestDigest(declaration), expiresAt: new Date(Math.min(Date.parse(caller.worker.expiresAt),
            Date.now() + BYTE_TRANSFER_POLICY.maxLifetimeMs)).toISOString(), chunkBytes: BYTE_TRANSFER_POLICY.maxChunkBytes })
        await this.authorization.assertWorkerActive(sql, caller)
        return { workerPrincipalId: worker.id, accepted, declaration: structuredClone(declaration), intent }
      } })
    // Coordinator rechecks live authority on retry; return only its original intent.
    await this.authorize(result.value.intent, transferContextForBinding(caller!.binding), 'start')
    return result.value.intent
  }
  private async writable(sql: pg.PoolClient, caller: Caller) {
    const accepted = await this.authorization.publication(sql, caller)
    if (!accepted.context.allowMutation || !accepted.context.allowedTools.includes('files.publish_result')) return denied()
    await this.authorization.assertWorkerActive(sql, caller)
    return accepted
  }
  private async allocation(id: string): Promise<Allocation> {
    const rows = await this.pool.query<{ result: Allocation }>(`select result from management_command_receipts
      where operation=$1 and result->'intent'->>'transferId'=$2`, [OPERATION, id])
    if (rows.rowCount !== 1 || !rows.rows[0]) return denied()
    const allocation = rows.rows[0].result
    allocation.intent = TransferIntentSchema.parse(allocation.intent)
    allocation.accepted.attempt = ArtifactAttemptSchema.parse(allocation.accepted.attempt)
    allocation.declaration = WorkflowArtifactTransferInputSchema.parse(allocation.declaration)
    if (!allocation.workerPrincipalId || allocation.intent.manifestDigest !== workflowArtifactTransferManifestDigest(allocation.declaration)
      || allocation.intent.sha256 !== allocation.declaration.sha256 || allocation.intent.byteSize !== allocation.declaration.byteSize) return denied()
    return allocation
  }
  /** Private composition routing only. A matching ID selects this receiver; authorization failures never fall through. */
  async ownsTransfer(id: string): Promise<boolean> {
    const rows = await this.pool.query(`select 1 from management_command_receipts
      where operation=$1 and result->'intent'->>'transferId'=$2 limit 1`, [OPERATION, id])
    return rows.rows.length !== 0
  }
  async intent(id: string, binding: Readonly<DeviceSessionBinding>): Promise<TransferIntent> {
    const allocation = await this.allocation(id)
    await this.authorize(allocation.intent, transferContextForBinding(binding), 'start')
    return allocation.intent
  }
  async authorize(intent: TransferIntent, raw: TransferContext, operation: TransferOperation): Promise<void> {
    void operation
    const context = TransferContextSchema.parse(raw), allocation = await this.allocation(intent.transferId)
    if (!isDeepStrictEqual(allocation.intent, intent)) return denied()
    await this.authorization.transaction(async sql => {
      const snapshot = ManagementPrincipalSchema.parse({ id: allocation.workerPrincipalId, name: 'original workflow worker', audience: 'worker',
        agentId: allocation.accepted.context.scope.chat.kind === 'agent' ? allocation.accepted.context.scope.chat.agentId : undefined,
        grants: [], expiresAt: intent.expiresAt, revokedAt: null })
      const caller = await this.authorization.locked(sql, snapshot), accepted = await this.writable(sql, caller), root = caller.placement.source
      if (!isDeepStrictEqual(transferContextForBinding(caller.binding), context) || !isDeepStrictEqual(accepted.attempt, allocation.accepted.attempt)
        || !isDeepStrictEqual(accepted.context, allocation.accepted.context) || intent.operationId !== caller.intent.operationId
        || intent.executionId !== caller.attempt.executionId || intent.attemptId !== caller.attempt.attemptId || intent.placementHash !== caller.attempt.placementHash
        || intent.direction !== 'to-main' || intent.byteClass !== 'artifact' || !('kind' in root) || root.kind !== 'pending'
        || intent.rootId !== root.rootId || intent.rootBindingRevision !== root.bindingRevision
        || intent.mainId !== context.mainId || intent.deviceId !== context.deviceId || intent.workerInstallationId !== context.workerInstallationId
        || intent.keyRevision !== context.keyRevision || intent.authorizationRevision !== context.authorizationRevision) return denied()
      this.authorization.assertConnection(caller.binding)
    })
  }
}
export function createWorkflowArtifactReceiver(input: { mainId: string; pool: pg.Pool; stagingRoot: string;
  access: Pick<PostgresAccessService, 'authenticate'>; endpoint: Endpoint; authority: Authority; fence: Fence; clock?: () => number }) {
  const authorization = new WorkflowArtifactEndpointAuthorization(input.mainId, input.pool, input.access, input.endpoint, input.authority, input.fence)
  const transfers = new WorkflowArtifactTransfers(input.pool, new PostgresCommandCoordinator(input.pool), authorization)
  const receiver = createEndpointTransferReceiver({ stagingRoot: input.stagingRoot, endpoint: input.endpoint, accepted: transfers,
    ...(input.clock ? { clock: input.clock } : {}) })
  return { authorization, transfers, extension: receiver.extension, reader: receiver.receiver,
    admit: transfers.admit.bind(transfers),
    ownsTransfer: transfers.ownsTransfer.bind(transfers), close: () => receiver.receiver.close() }
}
