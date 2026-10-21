import { ResolvedJobDefinitionSpecRecordSchema } from '@foreman-code/contracts/job-verification'
import { withTransaction } from '../../infrastructure/transaction.js'
import { createProductionRootPolicies, rootPolicySourceAttempts } from './productionRootAuthority.js'
import type { MaterializationAttempt } from './ports.js'
import { installedSourceQuotaPool } from '../jobs/quotaOwnership.js'
import type { InstalledRuntimeConfigurationLocation } from '../jobs/installedRuntimeHost.js'
import { RSYNC_STAGE_EXTENSION, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { PostgresSourceRsyncLifecycle } from './rsyncTransferLifecycle.js'
import { AgentSourceAttemptAuthority, installedSourceAttemptAuthority } from './agentSourceAuthority.js'
import { readAcceptedPlacement, readDispatchIntent, readNativePlacement } from '../placement/persistence.js'
import { readReconciledDispatchIntent, readRemoteReceipts } from '../runs/remote/persistence.js'
import { readNativeExecutionBinding } from '../placement/executionBinding.js'
import { sourceMaterializationDigest } from './bindingHash.js'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { SOURCE_OPERATION_EXTENSION } from '@foreman-code/contracts/source-operations'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { SourceRootRecord, SourcePreparationClosure, SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { PostgresSourceOperationAuthority } from './operationAuthority.js'
import { PostgresSourcePackageTransfers } from './operationTransferAdmission.js'
import { GitHubSourcePublisher } from './githubPublisher.js'
import { CarrierRemoteSourceMaterializationHost, createMainSourceOperationExtension } from './operationCarrier.js'
import type { MainWorkerCarrier } from '../placement/workerCarrier.js'
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { InstalledSourceExecutionHosts, type RemoteSourceMaterializationHost, type SourceActiveNativeSessionReader, type SourceNativeSessionCaptureReader } from './executionHosts.js'
import { PrivateSourceSnapshotStore } from './store.js'
import { PostgresSourceService } from './service.js'
import { JobSourceAttemptAuthority } from '../jobs/sourceAuthority.js'
import type { PostgresJobDispatch } from '../jobs/dispatch.js'
import { JobRepository } from '../jobs/repository.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError, retryDatabaseRead } from '../errors.js'
import { isDeepStrictEqual } from 'node:util'
import { localWorkflowSourceClosed } from './workflowCleanup.js'
import { requireQueuedPreparationClosed } from './queuedPreparationAuthority.js'
import { localWorkflowPreparationClosed, remoteWorkflowPreparationClosed } from './workflowPreparationCleanup.js'
import { resolvePreparationReconciliationOwner, validateSourcePreparationClosure } from './preparationReconciliation.js'
import type { SourceReservation } from './reservations.js'
import { MaterializationReservationCleanup } from './materializationReservationCleanup.js'
import { reclaimSourceReservation } from './reclaimSourceReservation.js'
import { SourceOperationOwnerSchema, SourceReservationReclamationResponseSchema } from '@foreman-code/contracts/source-operations'

/** Existing approved root records and original Job attempts own these services.
 * Construction does not fabricate an allowlist or authorize native execution. */
async function installationFence(sql: GraphSqlClient, value: import('@foreman-code/contracts/source-admission').SourceRootRecord) {
  await assertDeviceHostInstallation(sql, value.selection.hostRef, value.selection.hostRef.kind === 'main'
    ? value.selection.hostRef.mainId : value.registration!.workerInstallationId)
}

type ProductionSourcesInput = { pool: pg.Pool; commands: PostgresCommandCoordinator;
  locations: WorkspaceLocationService; mainId: string; runtimeRoot: string; endpoint(): DeviceEndpoint;
  installedJobConfiguration?: InstalledRuntimeConfigurationLocation;
  dispatch(): PostgresJobDispatch; remote?: RemoteSourceMaterializationHost;
  activeNativeSession?: SourceActiveNativeSessionReader; captureNativeSession?: SourceNativeSessionCaptureReader;
  transferAcknowledged?: (intent: TransferIntent) => Promise<void>;
  transferPreparationClosed?: (closure: SourcePreparationClosure) => Promise<void>;
  transferMaterializationClosed?: (record: SourceMaterializationRecord) => Promise<void> }

export async function createProductionSources(input: ProductionSourcesInput) {
  const unavailable = (): never => { throw new DomainError('SOURCE_REMOTE_UNAVAILABLE', 'The authenticated source materialization host is not installed.', 409) }
  const { policies, roots } = createProductionRootPolicies(input)
  const root = join(input.runtimeRoot, 'source-snapshots')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const snapshots = new PrivateSourceSnapshotStore(root)
  const jobs = new JobSourceAttemptAuthority(input.pool, installationFence)
  const agents = new AgentSourceAttemptAuthority(input.pool, installationFence)
  const originalAttempts = installedSourceAttemptAuthority(input.pool, agents, jobs)
  const attempts = rootPolicySourceAttempts({ pool: input.pool, roots, originalAttempts,
    prepareIdentity: (root, attempt) => owners.prepareIdentity(root, attempt) })
  const confirmedClosed = async (sql: GraphSqlClient, record: import('@foreman-code/contracts/source-admission').SourceMaterializationRecord) => {
    const original = await readDispatchIntent(sql, record.receipt.executionId)
    if (original) {
      let reconciled = (await sql.query<{ reconciliation_id: string; owner: unknown; closure: unknown }>(
        `select reconciliation_id,owner,closure from source_preparation_reconciliations
          where operation_id=$1 and status='closed'`, [record.operationId])).rows[0]
      if (!reconciled) {
        const retained = (await sql.query<{ record: SourceReservation }>(
          `select record from source_storage_reservations where reservation_id=$1 and state='retained'`,
          [record.reservationId])).rows[0]?.record
        if (retained?.preparationClosure && retained.reclamation?.owner) {
          reconciled = { reconciliation_id: retained.reclamation.reclamationId,
            owner: retained.reclamation.owner, closure: retained.preparationClosure }
        }
      }
      if (reconciled) {
        const owner = SourceOperationOwnerSchema.parse(reconciled.owner)
        if (owner.preparationKind === 'workflow' && isDeepStrictEqual(owner.record, record)) {
          validateSourcePreparationClosure(reconciled.reconciliation_id, owner, reconciled.closure)
          const closed = owner.root.selection.hostRef.kind === 'main'
            ? await localWorkflowPreparationClosed(sql, owner)
            : await remoteWorkflowPreparationClosed(sql, record.receipt.executionId)
          if (closed) return true
        }
      }
      // Closure facts only ever become true and the dispatch is immutable: read committed rows, never queue behind the Run.
      const intent = await readReconciledDispatchIntent(sql, record.operationId)
      const parent = await readAcceptedPlacement(sql, original.runId, original.nodeId)
      const rawNative = await readNativePlacement(sql, record.receipt.executionId)
      if (!intent || !parent || !rawNative || intent.executionId !== record.receipt.executionId
        || intent.attemptId !== record.receipt.attemptId || intent.operationId !== record.operationId
        || original.bindingHash !== intent.bindingHash || !record.finalDispatchBindingHash) return false
      const native = readNativeExecutionBinding(parent, intent, rawNative)
      if (native.bindingHash !== record.finalDispatchBindingHash || native.workingTree.materializationId !== record.receipt.materializationId
        || native.workingTree.materializationDigest !== sourceMaterializationDigest(record)) return false
      if (parent.hostRef.kind === 'main') {
        if (record.receipt.binding.deviceId !== null || record.receipt.binding.workerInstallationId !== null) return false
        return localWorkflowSourceClosed(sql, intent.executionId)
      }
      const receipts = (await readRemoteReceipts(sql, intent.runId, intent.nodeId)).filter(value => value.intent.operationId === record.operationId)
      const receipt = receipts.length === 1 ? receipts[0] : undefined
      if (!receipt || parent.hostRef.kind !== 'device' || !parent.registration) return false
      return sameWorkflowValue(receipt.intent, intent) && receipt.phase === 'confirmed_terminal' && Boolean(receipt.terminal)
        && receipt.connection.mainId === record.receipt.binding.mainId && receipt.connection.deviceId === record.receipt.binding.deviceId
        && receipt.connection.workerInstallationId === parent.registration.workerInstallationId
        && receipt.connection.keyRevision === parent.registration.keyRevision && receipt.connection.authorizationRevision === parent.registration.authorizationRevision
    }

    const execution = await new JobRepository().execution(sql, record.receipt.binding.workspaceId, record.receipt.executionId)
    if (execution.attemptId !== record.receipt.attemptId || execution.operationId !== record.operationId
      || execution.acceptedSpec.source.materializationId !== record.receipt.materializationId
      || execution.acceptedSpec.source.materializationDigest !== sourceMaterializationDigest(record)
      || execution.acceptedSpec.bindingHash !== record.finalDispatchBindingHash) return false
    const identity = { workspaceId: execution.workspaceId, executionId: execution.id,
      attemptId: execution.attemptId, operationId: execution.operationId,
      bindingHash: execution.acceptedSpec.bindingHash, owner: execution.owner }
    if (await input.dispatch().readAcceptedNonEntryClosure(sql, identity)) return true
    return Boolean(await input.dispatch().readAcceptedClosureReceipt(sql, identity))
  }
  const owners = new PostgresSourceOperationAuthority(input.pool, attempts, confirmedClosed, input.activeNativeSession)
  const transfers = new PostgresSourcePackageTransfers(input.pool, input.commands, owners, input.endpoint)
  const lifecycle = new PostgresSourceRsyncLifecycle(input.pool, transfers)
  const carrier: MainWorkerCarrier = { capture(deviceId) {
    const channel = input.endpoint().captureRequest(deviceId, SOURCE_OPERATION_EXTENSION.namespace)
    if (!channel) return unavailable()
    const { mainId, workerInstallationId, bootId, keyRevision, authorizationRevision, connectionGeneration } = channel.binding
    return { identity: { mainId, deviceId: channel.binding.deviceId, workerInstallationId, bootId, keyRevision, authorizationRevision, connectionGeneration },
      request(namespace, payload, options) {
        if (namespace !== SOURCE_OPERATION_EXTENSION.namespace) return Promise.reject(new DomainError('SOURCE_NAMESPACE_CONFLICT', 'The captured source channel cannot serve another namespace.', 409))
        return channel.request(payload, options)
      } }
  } }
  const remote = input.remote ?? new CarrierRemoteSourceMaterializationHost(carrier, owners, new GitHubSourcePublisher())
  const quotaPoolFor = async (binding: SourceRootRecord['binding'], attempt: MaterializationAttempt) => {
    const row = (await input.pool.query<{ spec: unknown }>(
      'select spec from job_computer_selections where execution_id=$1 and attempt_id=$2 and workspace_id=$3',
      [attempt.executionId, attempt.attemptId, binding.workspaceId])).rows[0]
    if (!row || !('verification' in ResolvedJobDefinitionSpecRecordSchema.parse(row.spec))) return undefined
    const path = join(input.runtimeRoot, 'job-runtime.json')
    const exists = input.installedJobConfiguration ?? await lstat(path).then(() => ({ path, ownerUid: process.getuid!() }),
      error => { if (error.code === 'ENOENT') return null; throw error })
    const pool = await installedSourceQuotaPool(exists, binding)
    if (!pool) throw new DomainError('SOURCE_QUOTA_MISSING', 'The verification Job requires its original installed quota pool.', 409)
    return { pool }
  }
  const executions = new InstalledSourceExecutionHosts(input.mainId, snapshots, attempts, remote, input.captureNativeSession, {
    async closed(owner) {
      if (owner.preparationKind === 'workflow') return localWorkflowPreparationClosed(input.pool, owner)
      const row = (await input.pool.query<{ queue_ticket_id: string | null }>(
        'select queue_ticket_id from source_preparation_reconciliations where operation_id=$1',
        [owner.identity.operationId])).rows[0]
      if (!row?.queue_ticket_id) return false
      const ticket = await requireQueuedPreparationClosed(input.pool, row.queue_ticket_id)
      return ticket.operationId === owner.identity.operationId && ticket.executionId === owner.attempt.executionId
        && ticket.attemptId === owner.attempt.attemptId
    },
    async authorize(reconciliationId, owner) {
      await withTransaction(input.pool, async (sql) => {
        const authorized = await resolvePreparationReconciliationOwner(sql, reconciliationId)
        if (!isDeepStrictEqual(authorized, owner)) {
          throw new DomainError('SOURCE_RECONCILIATION_CONFLICT', 'The original Main cleanup owner changed.', 409)
        }
      })
    },
  }, quotaPoolFor)
  const sources = new PostgresSourceService(input.pool, input.commands, input.locations, snapshots, input.mainId, roots, executions, {
    confirmedClosed(record) {
      return retryDatabaseRead(async () => {
        const sql = await input.pool.connect()
        try {
          return await confirmedClosed(sql, record)
        } finally { sql.release() }
      })
    },
  }, { reclaimRetained: scopeId => reclamations.reclaimOldestRetained(scopeId),
    adopted: input.transferAcknowledged ? async record => {
    const deviceId = record.receipt.binding.deviceId
    if (!deviceId) return
    const channel = input.endpoint().captureRequest(deviceId, RSYNC_STAGE_EXTENSION.namespace)
    if (!channel) unavailable()
    const intent = await lifecycle.forMaterialization(record, channel!.binding)
    await input.transferAcknowledged!(intent)
  } : undefined, preparationClosed: input.transferPreparationClosed, closed: input.transferMaterializationClosed })
  const reclamations = new MaterializationReservationCleanup(input.pool, async grant => {
    const root = grant.roots[0]!
    const authorize = async () => {
      return withTransaction(input.pool, async (sql) => {
        const current = await reclamations.authorize(sql, grant.reservationId, grant.reclamationId)
        if (!isDeepStrictEqual(current, grant)) {
          throw new DomainError('SOURCE_RECLAMATION_UNCONFIRMED', 'The original source cleanup changed.', 409)
        }
      })
    }
    if (root.binding.deviceId) {
      const endpoint = input.endpoint()
      const channel = endpoint.captureRequest(root.binding.deviceId, SOURCE_OPERATION_EXTENSION.namespace)
      if (!channel || channel.binding.mainId !== root.binding.mainId
        || channel.binding.workerInstallationId !== root.binding.workerInstallationId
        || channel.binding.keyRevision !== root.registration?.keyRevision
        || channel.binding.authorizationRevision !== root.registration.authorizationRevision) unavailable()
      const reply = await channel!.request({ version: 1, operation: 'sources.reclaim-reservation',
        reservationId: grant.reservationId, reclamationId: grant.reclamationId }, { signal: AbortSignal.timeout(60_000) })
      const result = SourceReservationReclamationResponseSchema.parse(reply.payload)
      if (reply.bytes !== undefined || result.reservationId !== grant.reservationId
        || result.reclamationId !== grant.reclamationId || result.operationId !== grant.operationId
        || !isDeepStrictEqual(endpoint.currentBinding(root.binding.deviceId), channel!.binding)) {
        throw new DomainError('SOURCE_RECLAMATION_UNCONFIRMED', 'The original Worker cleanup reply changed.', 409)
      }
      return { closures: result.closures, ...(result.retained ? { retained: result.retained } : {}) }
    }
    return reclaimSourceReservation(grant, { authorize,
      operationClosed: async () => { await authorize(); return true },
      nativeClosed: async owner => {
        if (grant.removeRetained && owner.record) return confirmedClosed(input.pool, owner.record)
        const workflow = await input.pool.query('select 1 from execution_dispatch_intents where operation_id=$1',
          [owner.identity.operationId])
        if (workflow.rowCount) return localWorkflowPreparationClosed(input.pool,
          { ...owner, preparationKind: 'workflow', preparationClosed: true })
        return true
      },
      quotaPoolFor: async owner => {
        const path = join(input.runtimeRoot, 'job-runtime.json')
        const configuration = input.installedJobConfiguration ?? await lstat(path).then(
          () => ({ path, ownerUid: process.getuid!() }), error => { if (error.code === 'ENOENT') return null; throw error })
        const pool = await installedSourceQuotaPool(configuration, owner.root.binding)
        return pool ? { pool } : undefined
      },
      closed: async closure => { await input.transferPreparationClosed?.(closure) },
    }, AbortSignal.timeout(60_000))
  })
  return { sources, policies, executions, snapshots, attempts, owners, transfers, lifecycle,
    reconcileMaterializationReservations: (report: (error: unknown) => void) => reclamations.reconcile(report),
    startMaterializationReservationReconciliation: (report: (error: unknown) => void) => reclamations.startReconciliation(report),
    drainMaterializationReservationReconciliation: () => reclamations.drain(),
    reconcileFailedCaptures: (report: (error: unknown) => void) => sources.reconcileCaptures(report),
    sourceExtension: createMainSourceOperationExtension(owners, transfers, lifecycle, async (reservationId, reclamationId, context) => {
      return withTransaction(input.pool, async (sql) => {
        const grant = await reclamations.authorize(sql, reservationId, reclamationId)
        if (grant.roots.some(root => root.binding.mainId !== context.binding.mainId
          || root.binding.deviceId !== context.binding.deviceId
          || root.binding.workerInstallationId !== context.binding.workerInstallationId
          || root.registration?.keyRevision !== context.binding.keyRevision
          || root.registration.authorizationRevision !== context.binding.authorizationRevision)) {
          throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Cleanup belongs to another Worker installation.', 403)
        }
        return grant
      })
    }) }
}
