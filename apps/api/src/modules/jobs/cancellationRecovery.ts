import { JobRuntimeMeasurementRecordSchema } from '@foreman-code/contracts/job-verification-runtime'
import { withTransaction } from '../../infrastructure/transaction.js'
import { createHash, createPublicKey, randomUUID, sign, verify } from 'node:crypto'
import { isDeepStrictEqual as same } from 'node:util'
import type pg from 'pg'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { JobCancellationProposalInputSchema, JobCancellationRecoveryGetSchema, JobCancellationRecoveryReadSchema,
  JobCancellationRecoveryApproveSchema,
  JobCancellationGrantSchema, SignedJobCancellationGrantSchema, JobCancellationRecoveryApplySchema,
  JOB_CANCELLATION_GRANT_TTL_MS, jobCancellationGrantMessage, jobCancellationClosureMessage,
  type SignedJobCancellationClosure } from '@foreman-code/contracts/job-cancellation-recovery'
import { RemoteJobDispatchIntentSchema } from '@foreman-code/contracts/remote-job-execution'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { beforeGraphCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import { PostgresCommandCoordinator, commandInputHash } from '../commands/postgres.js'
import { readAcceptedJobCleanupSource } from '../runs/remote/jobAcceptedSource.js'
import { PostgresSourceReservations, type SourceReservation } from '../sources/reservations.js'
import { DomainError } from '../errors.js'
import { JobRepository, type JobSql } from './repository.js'
import type { PostgresJobDispatch } from './dispatch.js'
import type { MainDeviceIdentity } from '../devices/mainIdentity.js'

const PROPOSE = 'job.cancellation-recovery.propose'
const APPROVE = 'job.cancellation-recovery.approve'
const IMPORT = 'job.cancellation-recovery.import'
function deny(message: string): never {
  throw new DomainError('JOB_CANCELLATION_RECOVERY_DENIED', message, 403)
}

export class PostgresJobCancellationRecovery {
  private readonly repository = new JobRepository()
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly dispatch: Pick<PostgresJobDispatch, 'importCancellationClosure'>) {}

  private async authorize(sql: JobSql, principal: ManagementPrincipal, workspaceId: string) {
    const live = await readLiveManagementPrincipal(sql, principal.id)
    requireAuthorization(live, 'jobs:cancel', { workspaceId })
    return live
  }
  private async proposal(sql: JobSql, workspaceId: string, executionId: string, id: string) {
    const row = (await sql.query<{ result: unknown }>(`select result from management_command_receipts
      where operation=$1 and target_key=$2 and result->>'id'=$3 for share`,
    [PROPOSE, executionId, id])).rows[0]
    if (!row) deny('The original cleanup proposal is missing.')
    const proposal = JobCancellationRecoveryReadSchema.parse(row!.result)
    if (proposal.workspaceId !== workspaceId || proposal.executionId !== executionId) deny('Cleanup scope changed.')
    return proposal
  }
  private async current(sql: JobSql, workspaceId: string, executionId: string) {
    const execution = await this.repository.execution(sql, workspaceId, executionId, true)
    const target = execution.acceptedSpec.target
    if (execution.workflow || target.hostRef.kind !== 'device' || !target.registration) {
      deny('This cleanup supports only an original manual Job on a revoked Worker.')
    }
    const row = (await sql.query<{ record: unknown; public_key: string }>(
      'select record,public_key from device_registrations where id=$1 and main_id=$2 for share',
      [target.hostRef.deviceId, target.mainId])).rows[0]
    if (!row) deny('The original Worker registration is missing.')
    const registration = DeviceRegistrationSchema.parse(row!.record)
    if (registration.status !== 'revoked' || registration.workerInstallationId !== target.registration!.workerInstallationId
      || registration.keyRevision !== target.registration!.keyRevision
      || registration.authorizationRevision <= target.registration!.authorizationRevision
      || publicKeyFingerprint(row!.public_key) !== registration.publicKeyFingerprint) {
      deny('The original revoked Worker key or installation changed.')
    }
    return { execution, registration, publicKey: row!.public_key }
  }
  async propose(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown) {
    const input = JobCancellationProposalInputSchema.parse(raw)
    requireAuthorization(principal, 'jobs:cancel', input)
    return (await this.commands.execute({ principal, source, operation: PROPOSE, commandId: input.commandId,
      targetKey: input.executionId, payload: input,
      authorize: async sql => { await this.authorize(sql, principal, input.workspaceId) },
      perform: async sql => {
        const { execution, registration } = await this.current(sql, input.workspaceId, input.executionId)
        if (execution.process.phase === 'terminal') deny('This Job already has a terminal result.')
        const accepted = await readAcceptedJobCleanupSource(sql, execution)
        if (input.filesystemRecovery && input.filesystemRecovery.filesystem.inode !== accepted.root.binding.filesystem.inode) {
          deny('Restored-volume cleanup cannot adopt a different original source root inode.')
        }
        if (input.filesystemRecovery?.kind === 'restored-original-project-quota') {
          if (execution.schemaVersion !== 2 || !accepted.materialization.receipt.quota) {
            deny('Project-quota recovery requires the original verification quota ownership.')
          }
          const qualification = (await sql.query<{ measurement: unknown }>(
            'select measurement from job_runtime_qualification_approvals where id=$1 and qualification_id=$2',
            [execution.acceptedSpec.profile.approvalId, execution.acceptedSpec.profile.qualificationId])).rows[0]
          const measurement = JobRuntimeMeasurementRecordSchema.parse(qualification?.measurement)
          if (measurement.schemaVersion !== 2
            || measurement.fingerprint.quota.volumeId !== input.filesystemRecovery.volumeId
            || measurement.fingerprint.quotaPool?.filesystemUuid !== input.filesystemRecovery.filesystemUuid) {
            deny('Project-quota recovery must retain its measured original filesystem and volume identity.')
          }
        }
        return JobCancellationRecoveryReadSchema.parse({ id: randomUUID(), workspaceId: input.workspaceId,
          executionId: execution.id, principalId: principal.id, state: 'pending', requestedAt: new Date().toISOString(),
          journalSha256: input.journalSha256, execution, registration,
          ...(input.filesystemRecovery ? { filesystemRecovery: input.filesystemRecovery } : {}),
          root: accepted.root, materialization: accepted.materialization, grant: null, closure: null })
      } })).value
  }
  async get(principal: ManagementPrincipal, raw: unknown) {
    const input = JobCancellationRecoveryGetSchema.parse(raw)
    return withTransaction(this.pool, async (sql) => {
      await this.authorize(sql, principal, input.workspaceId)
      const proposal = await this.proposal(sql, input.workspaceId, input.executionId, input.recoveryId)
      if (proposal.principalId !== principal.id) deny('This cleanup belongs to another caller.')
      const rows = (await sql.query<{ operation: string; result: unknown }>(`select operation,result
        from management_command_receipts where target_key=$1 and operation=any($2::text[]) for share`,
      [proposal.id, [APPROVE, IMPORT]])).rows
      const approved = rows.find(row => row.operation === APPROVE)
      const imported = rows.find(row => row.operation === IMPORT)
      if (approved) proposal.grant = SignedJobCancellationGrantSchema.parse(approved.result)
      if (imported) {
        const parsed = JobCancellationRecoveryApplySchema.parse(imported.result)
        proposal.closure = parsed.closure
        proposal.state = 'consumed'
      } else if (proposal.grant) {
        proposal.state = Date.parse(proposal.grant.grant.expiresAt) > Date.now() ? 'approved' : 'expired'
      }
      return proposal
    })
  }
  async approve(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown) {
    const { workspaceId, executionId, recoveryId, commandId } = JobCancellationRecoveryApproveSchema.parse(raw)
    requireAuthorization(principal, 'jobs:cancel', { workspaceId })
    return (await this.commands.execute({ principal, source, operation: APPROVE, commandId,
      targetKey: recoveryId, payload: { workspaceId, executionId, recoveryId },
      authorize: async sql => { await this.authorize(sql, principal, workspaceId) },
      perform: async sql => {
        await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`job-cleanup:${recoveryId}`])
        const prior = await sql.query('select 1 from management_command_receipts where operation=$1 and target_key=$2',
          [APPROVE, recoveryId])
        if (prior.rowCount) deny('Retry the original approval command.')
        const proposal = await this.proposal(sql, workspaceId, executionId, recoveryId)
        const { execution, registration } = await this.current(sql, workspaceId, executionId)
        if (!same(execution.acceptedSpec, proposal.execution.acceptedSpec) || !same(registration, proposal.registration)) {
          deny('The reviewed Job or Worker changed.')
        }
        await this.authorize(sql, await readLiveManagementPrincipal(sql, proposal.principalId), workspaceId)
        const row = (await sql.query<{ cancel_command_id: string | null }>(
          'select cancel_command_id from job_dispatch_intents where execution_id=$1 for share', [executionId])).rows[0]
        if (!row?.cancel_command_id || !execution.cancelRequestedAt || execution.process.phase === 'terminal') {
          deny('Request cancellation of the original Job before approving recovery.')
        }
        const intentRow = (await sql.query<{ intent: unknown }>(
          'select intent from job_dispatch_intents where execution_id=$1 for share', [executionId])).rows[0]
        const now = new Date()
        const grant = JobCancellationGrantSchema.parse({ schemaVersion: 1, kind: 'job-cancel-before-entry',
          id: proposal.id, principalId: proposal.principalId, approvedByPrincipalId: principal.id,
          approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + JOB_CANCELLATION_GRANT_TTL_MS).toISOString(),
          cancelCommandId: row.cancel_command_id, journalSha256: proposal.journalSha256,
          ...(proposal.filesystemRecovery ? { filesystemRecovery: proposal.filesystemRecovery } : {}),
          intent: RemoteJobDispatchIntentSchema.parse(intentRow?.intent), execution, registration,
          root: proposal.root, materialization: proposal.materialization })
        const identityRow = (await sql.query<{ record: MainDeviceIdentity }>(
          'select record from device_main_identity where main_id=$1 for share', [grant.intent.mainId])).rows[0]
        const identity = identityRow?.record
        if (!identity || identity.mainId !== grant.intent.mainId
          || publicKeyFingerprint(identity.publicKey) !== identity.publicKeyFingerprint
          || publicKeyFingerprint(createPublicKey(identity.privateKey).export({ type: 'spki', format: 'pem' }).toString())
            !== identity.publicKeyFingerprint) deny('The original Main signing identity is unavailable.')
        return SignedJobCancellationGrantSchema.parse({ grant, mainPublicKey: identity!.publicKey,
          signature: sign(null, Buffer.from(jobCancellationGrantMessage(grant)), identity!.privateKey).toString('base64url') })
      } })).value
  }
  private async requireClosure(sql: JobSql, principal: ManagementPrincipal, execution: JobExecutionRecord,
    recoveryId: string, signed: SignedJobCancellationClosure) {
    await this.authorize(sql, principal, execution.workspaceId)
    const proposal = await this.proposal(sql, execution.workspaceId, execution.id, recoveryId)
    if (proposal.principalId !== principal.id) deny('The approved cleanup belongs to another caller.')
    const approved = (await sql.query<{ result: unknown }>(`select result from management_command_receipts
      where operation=$1 and target_key=$2 for share`, [APPROVE, recoveryId])).rows
    if (approved.length !== 1) deny('A fresh cleanup authorization is required for this cleanup.')
    const authorization = SignedJobCancellationGrantSchema.parse(approved[0]!.result)
    const grant = authorization.grant
    if (grant.id !== recoveryId || grant.principalId !== principal.id || Date.parse(grant.expiresAt) <= Date.now()) {
      deny('The original cleanup approval is missing, expired or belongs to another caller.')
    }
    await this.authorize(sql, await readLiveManagementPrincipal(sql, grant.approvedByPrincipalId), execution.workspaceId)
    const { registration, publicKey } = await this.current(sql, execution.workspaceId, execution.id)
    if (!same(registration, grant.registration) || !same(execution.acceptedSpec, grant.execution.acceptedSpec)
      || execution.operationId !== grant.execution.operationId || execution.attemptId !== grant.execution.attemptId
      || !same(execution.owner, grant.execution.owner)) deny('The original cleanup identity changed.')
    const closure = signed.closure, receipt = closure.receipt, terminal = receipt.terminal
    const connection = receipt.connection
    const target = execution.acceptedSpec.target
    if (closure.grantId !== recoveryId || !same(receipt.intent, grant.intent)
      || receipt.execution.id !== execution.id || receipt.execution.workspaceId !== execution.workspaceId
      || receipt.execution.operationId !== execution.operationId || receipt.execution.attemptId !== execution.attemptId
      || !same(receipt.execution.owner, execution.owner) || !same(receipt.execution.workflow, execution.workflow)
      || !same(receipt.execution.acceptedSpec, execution.acceptedSpec) || receipt.entryAttempted || receipt.native
      || !receipt.stopFence || receipt.phase !== 'confirmed_terminal' || receipt.publication !== 'complete'
      || !terminal || terminal.outcome !== 'cancelled' || !terminal.processStopped
      || terminal.exitCode !== null || terminal.signal !== null
      || Date.parse(terminal.finishedAt) < Date.parse(grant.approvedAt)
      || Date.parse(receipt.observedAt) > Date.parse(grant.expiresAt)
      || terminal.closureEvidenceDigest !== createHash('sha256')
        .update(jobCancellationGrantMessage(grant)).digest('hex')
      || !receipt.controls.some(command => command.commandId === grant.cancelCommandId && command.action.kind === 'stop')
      || !('deviceId' in connection) || target.hostRef.kind !== 'device'
      || connection.mainId !== grant.intent.mainId || connection.deviceId !== target.hostRef.deviceId
      || connection.workerInstallationId !== target.registration?.workerInstallationId
      || connection.keyRevision !== target.registration.keyRevision
      || connection.authorizationRevision !== target.registration.authorizationRevision
      || closure.sourceClaim.materializationId !== grant.materialization.receipt.materializationId
      || closure.sourceClaim.reservationId !== grant.materialization.reservationId
      || Boolean(closure.sourceClaim.quotaReclaimed) !== Boolean(grant.materialization.receipt.quota)
      || !verify(null, Buffer.from(jobCancellationClosureMessage(closure)), publicKey, Buffer.from(signed.signature, 'base64url'))) {
      deny('The original signed no-entry and source-claim closure is invalid.')
    }
    return grant
  }
  async apply(principal: ManagementPrincipal, source: 'http' | 'mcp', workspaceId: string, executionId: string,
    commandId: string, raw: unknown) {
    const input = JobCancellationRecoveryApplySchema.parse(raw)
    requireAuthorization(principal, 'jobs:cancel', { workspaceId })
    await this.commands.execute({ principal, source, operation: 'job.cancel', commandId, targetKey: workspaceId,
      payload: { id: executionId, recovery: input }, dedicatedConnection: true,
      authorize: async sql => { await this.authorize(sql, principal, workspaceId) },
      prepare: async () => {
        await this.dispatch.importCancellationClosure(workspaceId, executionId, input.closure.closure.receipt,
          async (sql: GraphTransactionSql, execution) => {
            await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`job-cleanup:${input.recoveryId}`])
            const prior = (await sql.query<{ principal_id: string; command_id: string; input_hash: string; result: unknown }>(
              'select principal_id,command_id,input_hash,result from management_command_receipts where operation=$1 and target_key=$2 for share',
              [IMPORT, input.recoveryId])).rows
            if (prior.length) {
              const original = prior[0]!
              await this.authorize(sql, principal, workspaceId)
              if (prior.length !== 1 || original.principal_id !== principal.id || original.command_id !== commandId
                || original.input_hash !== commandInputHash(input) || !same(original.result, input)) {
                deny('Retry the original cleanup import command and closure.')
              }
              return
            }
            const grant = await this.requireClosure(sql, principal, execution, input.recoveryId, input.closure)
            const row = (await sql.query<{ record: SourceReservation; state: string }>(
              'select record,state from source_storage_reservations where reservation_id=$1 for update',
              [grant.materialization.reservationId])).rows[0]
            if (!row || row.record.ownerKind !== 'materialization' || row.record.ownerId !== execution.operationId
              || row.record.reservationId !== grant.materialization.reservationId || row.state === 'reclaimed') {
              deny('The original source reservation changed.')
            }
            const materialization = (await sql.query<{ record: unknown }>(
              'select record from source_execution_materializations where materialization_id=$1 for update',
              [grant.materialization.receipt.materializationId])).rows[0]
            if (!materialization || !same(materialization.record, grant.materialization)) {
              deny('The original source materialization changed.')
            }
            const reservations = new PostgresSourceReservations()
            if (input.closure.closure.sourceClaim.quotaReclaimed) {
              await reservations.reclaimed(sql, row.record, async () => input.closure.closure.sourceClaim.quotaReclaimed === true
                && Boolean(grant.materialization.receipt.quota) && !input.closure.closure.receipt.entryAttempted
                && input.closure.closure.receipt.terminal?.processStopped === true)
            } else {
              await reservations.retain(sql, row.record, 'retained')
            }
            await sql.query("update source_execution_materializations set state='closed' where materialization_id=$1",
              [grant.materialization.receipt.materializationId])
            beforeGraphCommit(sql, async () => { await this.requireClosure(sql, principal, execution,
              input.recoveryId, input.closure) })
            await sql.query(`insert into management_command_receipts
              (principal_id,operation,command_id,target_key,input_hash,result) values($1,$2,$3,$4,$5,$6::jsonb)`,
              [principal.id, IMPORT, commandId, input.recoveryId, commandInputHash(input), JSON.stringify(input)])
            await this.commands.recordAudit(principal.id, source, IMPORT, input.recoveryId, 'succeeded',
              { commandId, executionId, operationId: execution.operationId, attemptId: execution.attemptId }, sql)
          })
      },
      perform: async sql => {
        await this.authorize(sql, principal, workspaceId)
        return input
      } })
    return this.repositoryRead(workspaceId, executionId)
  }
  private async repositoryRead(workspaceId: string, executionId: string) {
    const sql = await this.pool.connect()
    try { return await this.repository.execution(sql, workspaceId, executionId) } finally { sql.release() }
  }
}
