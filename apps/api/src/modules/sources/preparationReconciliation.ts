import { randomUUID } from 'node:crypto'
import { withTransaction } from '../../infrastructure/transaction.js'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { readJobComputerSelection } from '../jobs/computerSelection.js'
import { JobDefinitionRecordSchema, JobExecutionRecordSchema, isAutoJobSpecRecord } from '@foreman-code/contracts/job-verification'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { SourcePreparationGetInputSchema, SourcePreparationReconcileInputSchema, SourcePreparationSchema,
  SourcePreparationClosureSchema, SourceRootRecordSchema, SourceMaterializationRecordSchema,
  type SourcePreparationClosure } from '@foreman-code/contracts/source-admission'
import { SourceOperationOwnerSchema, type SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError } from '../errors.js'
import { authorizeSource } from './authority.js'
import { sourceBindingHash } from './bindingHash.js'
import { PostgresSourceReservations, type SourceReservation } from './reservations.js'
import type { SourceExecutionHostPort } from './ports.js'
import { assertWorkflowPreparationClosed, loadWorkflowPreparation } from './workflowPreparationCleanup.js'
import { requireQueuedPreparationClosed } from './queuedPreparationAuthority.js'
import { JobQueueTicketSchema, type JobQueueTicket } from '@foreman-code/contracts/job-admission'

export async function loadSourcePreparation(sql: GraphSqlClient, workspaceId: string, operationId: string) {
  const row = (await sql.query<{ execution_id: string; attempt_id: string; principal_id: string; start_command_id: string; definition: unknown; created_at: Date; workflow_run_id: string | null;
    reservation_id: string; scope_id: string; reservation: SourceReservation; reservation_state: string; reserved_bytes: string; materialization: unknown | null;
    reconciliation_id: string | null; command_id: string | null; status: string | null; owner: unknown | null; closure: unknown | null }>(`with preparations as (
    select execution_id,attempt_id,operation_id,workspace_id,principal_id,command_id,definition,created_at,null::text as workflow_run_id
      from job_preparations
    union all select s.execution_id,s.attempt_id,s.operation_id,s.workspace_id,
      r.record->>'authorizationPrincipalId',w.slot_id,v.record,w.created_at,w.run_id
      from workflow_job_preparations w join job_computer_selections s on s.execution_id=w.preparation->>'executionId'
      join runs r on r.id=w.run_id join job_definition_versions v on v.id=s.definition_version_id
    ) select
    j.execution_id,j.attempt_id,j.principal_id,j.command_id as start_command_id,j.definition,j.created_at,r.reservation_id,r.scope_id,r.record as reservation,r.state as reservation_state,r.reserved_bytes,
    m.record as materialization,c.reconciliation_id,c.command_id,c.status,c.owner,c.closure,j.workflow_run_id
    from preparations j join source_storage_reservations r on r.owner_kind='materialization' and r.owner_id=j.operation_id
    left join source_execution_materializations m on m.operation_id=j.operation_id
    left join source_preparation_reconciliations c on c.operation_id=j.operation_id
    where j.workspace_id=$1 and j.operation_id=$2 for share of r`, [workspaceId, operationId])).rows[0]
  if (!row) return loadWorkflowPreparation(sql, workspaceId, operationId)
  const saved = JobDefinitionRecordSchema.parse(row.definition)
  const spec = isAutoJobSpecRecord(saved.spec) ? await readJobComputerSelection(sql, saved, {
    executionId: row.execution_id, attemptId: row.attempt_id, operationId,
  }) : saved.spec
  const definition = { ...saved, spec }
  const record = row.materialization === null ? null : SourceMaterializationRecordSchema.parse(row.materialization)
  const roots = (await sql.query<{ record: unknown }>(`select record from source_root_bindings
    where workspace_id=$1 and record->>'attestationId'=$2 for share`, [workspaceId, definition.spec.target.destination.attestationId])).rows
  if (roots.length !== 1) throw new DomainError('SOURCE_ROOT_NOT_FOUND', 'The exact original preparation root attestation is unavailable.', 409)
  const root = SourceRootRecordSchema.parse(roots[0]!.record)
  const main = (await sql.query<{id: string}>('select id from application_installation where singleton=true for share')).rows[0]
  const binding = root.binding, scopeId = `${binding.mainId}:${binding.deviceId ?? 'original-main'}:${binding.workerInstallationId ?? binding.mainId}:${binding.filesystem.device}:${binding.filesystem.mountId}`
  if (main?.id !== binding.mainId || row.reservation.reservationId !== row.reservation_id || row.reservation.scopeId !== row.scope_id
    || row.scope_id !== scopeId || row.reservation.ownerKind !== 'materialization' || row.reservation.ownerId !== operationId)
    throw new DomainError('SOURCE_RESERVATION_CONFLICT', 'The original host/filesystem reservation identity changed.', 409)
  const attempt = { executionId: row.execution_id, attemptId: row.attempt_id, keyRevision: root.registration?.keyRevision ?? null,
    authorizationRevision: root.registration?.authorizationRevision ?? null, placementHash: '' }
  attempt.placementHash = sourceBindingHash(root, attempt, operationId)
  if (record && (record.operationId !== operationId || record.reservationId !== row.reservation.reservationId
    || record.receipt.executionId !== attempt.executionId || record.receipt.attemptId !== attempt.attemptId
    || record.receipt.placementHash !== attempt.placementHash || !isDeepStrictEqual(record.receipt.binding, root.binding)))
    throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'The original preparation/source reservation facts differ.', 409)
  if (root.binding.workspaceId !== workspaceId || root.source.approvedSourceId !== definition.spec.source.approvedSourceId
    || root.source.snapshotId !== definition.spec.source.snapshotId || root.source.manifestDigest !== definition.spec.source.manifestDigest
    || !isDeepStrictEqual(definition.spec.target.hostRef, root.selection.hostRef) || !isDeepStrictEqual(definition.spec.target.registration, root.registration)
    || definition.spec.target.destination.attestationHash !== root.attestationDigest)
    throw new DomainError('SOURCE_PIN_CONFLICT', 'The original preparation does not own this exact root/source.', 409)
  return { ...row, kind: 'job' as const, root, attempt, record, definition, operationId, workspaceId }
}
type State = Awaited<ReturnType<typeof loadSourcePreparation>>
export function validateQueuedSourcePreparation(ticket: JobQueueTicket, state: State): void {
  if (state.kind !== 'job' || state.workflow_run_id || state.principal_id !== ticket.principalId
    || state.workspaceId !== ticket.workspaceId || state.operationId !== ticket.operationId
    || state.attempt.executionId !== ticket.executionId || state.attempt.attemptId !== ticket.attemptId
    || state.definition.versionId !== ticket.definition.versionId) {
    throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'Queued cleanup differs from its original preparation.', 409)
  }
}
export function validateSourcePreparationClosure(reconciliationId: string, owner: SourceOperationOwner,
  raw: unknown): SourcePreparationClosure {
  const closure = SourcePreparationClosureSchema.parse(raw)
  const root = owner.root
  const attempt = owner.attempt
  if (closure.reconciliationId !== reconciliationId || closure.operationId !== owner.identity.operationId
    || closure.executionId !== attempt.executionId || closure.attemptId !== attempt.attemptId
    || closure.rootId !== root.binding.rootId || closure.bindingRevision !== root.binding.bindingRevision
    || closure.mainId !== root.binding.mainId || closure.deviceId !== root.binding.deviceId
    || closure.workerInstallationId !== root.binding.workerInstallationId
    || closure.keyRevision !== attempt.keyRevision || closure.authorizationRevision !== attempt.authorizationRevision
    || !isDeepStrictEqual(closure.filesystem, root.binding.filesystem)
    || owner.record && closure.materializationId !== owner.record.receipt.materializationId) {
    throw new DomainError('SOURCE_CLOSURE_CONFLICT', 'Worker closure does not match the original source owner.', 409)
  }
  return closure
}
function readPreparationClosure(state: State) {
  if (state.closure) return SourcePreparationClosureSchema.parse(state.closure)
  const { preparationClosure, reclamation } = state.reservation
  if (!preparationClosure) return null
  if (!reclamation?.owner || reclamation.operationId !== state.operationId) {
    throw new DomainError('SOURCE_CLOSURE_CONFLICT', 'Automatic source closure has no matching preparation owner.', 409)
  }
  return validateSourcePreparationClosure(reclamation.reclamationId,
    SourceOperationOwnerSchema.parse(reclamation.owner), preparationClosure)
}

function metadata(state: State) {
  const closure = readPreparationClosure(state)
  return SourcePreparationSchema.parse({ workspaceId: state.workspaceId, operationId: state.operationId,
    hostRef: state.root.selection.hostRef,
    executionId: state.attempt.executionId, attemptId: state.attempt.attemptId, reservationId: state.reservation.reservationId,
    reservationState: state.reservation_state, reservedBytes: Number(state.reserved_bytes),
    materializationId: state.record?.receipt.materializationId ?? closure?.materializationId ?? null,
    closure })
}
export async function admissionClosed(sql: GraphSqlClient, state: State) {
  if (state.kind === 'workflow') return assertWorkflowPreparationClosed(sql, state)
  const job = (await sql.query<{ record: unknown }>('select record from job_executions where id=$1 or operation_id=$2 for share',
    [state.attempt.executionId, state.operationId])).rows[0]
  if (job) {
    const execution = JobExecutionRecordSchema.parse(job.record)
    if (execution.id !== state.attempt.executionId || execution.operationId !== state.operationId
      || execution.attemptId !== state.attempt.attemptId || execution.workspaceId !== state.workspaceId
      || execution.process.phase !== 'terminal' || !execution.process.processStopped
      || !['complete', 'failed'].includes(execution.publication)) {
      throw new DomainError('SOURCE_PREPARATION_ACTIVE', 'The original Job must have confirmed closure and settled publication before data recovery.', 409)
    }
    return execution
  }
  if (state.workflow_run_id) {
    const run = (await sql.query<{ closed: boolean }>(`select (stop_requested_at is not null
      or execution_state in ('completed','interrupted') or exists(select 1 from run_cleanup_intents c
      where c.run_id=r.id and c.pending)) as closed from runs r where id=$1 for share`, [state.workflow_run_id])).rows[0]
    if (!run?.closed) throw new DomainError('SOURCE_PREPARATION_ACTIVE', 'Stop the workflow before reconciling this Job preparation.', 409)
    if ((await sql.query('select 1 from job_executions where id=$1 or operation_id=$2 for share',
      [state.attempt.executionId, state.operationId])).rowCount) {
      throw new DomainError('SOURCE_PREPARATION_ADMITTED', 'An admitted Job requires its original execution cancellation/reconciliation path.', 409)
    }
    return
  }
  const queued = (await sql.query<{ record: unknown }>(
    'select record from job_admission_queue where execution_id=$1 for share', [state.attempt.executionId])).rows[0]
  if (queued) {
    const ticket = JobQueueTicketSchema.parse(queued.record)
    validateQueuedSourcePreparation(ticket, state)
    const lock = (await sql.query<{ locked: boolean }>(
      'select pg_try_advisory_xact_lock(810038,hashtext($1)) as locked', [ticket.executionId])).rows[0]
    if (ticket.state !== 'terminal' || !lock?.locked) {
      throw new DomainError('SOURCE_PREPARATION_ACTIVE', 'The original queued preparation is still active.', 409)
    }
    return
  }
  const lock = (await sql.query<{locked: boolean}>('select pg_try_advisory_xact_lock(hashtext($1)) as locked',
    [`command:${state.principal_id}:job.start:${state.start_command_id}`])).rows[0]
  if (!lock?.locked) throw new DomainError('SOURCE_PREPARATION_ACTIVE', 'The original Job Start command is still active.', 409)
  if ((await sql.query('select 1 from job_executions where id=$1 or operation_id=$2 for share', [state.attempt.executionId, state.operationId])).rowCount)
    throw new DomainError('SOURCE_PREPARATION_ADMITTED', 'An admitted Job requires its original execution cancellation/reconciliation path.', 409)
  const owner = (await sql.query<{revoked_at: Date | null; expires_at: Date}>('select revoked_at,expires_at from management_principals where id=$1 for share', [state.principal_id])).rows[0]
  const failure = await sql.query(`select 1 from management_audit where principal_id=$1 and action='job.start'
    and target_key=$2 and outcome='failed' and details->>'commandId'=$3 limit 1`, [state.principal_id,state.workspaceId,state.start_command_id])
  const ownerLost = Boolean(owner?.revoked_at || owner && owner.expires_at.getTime() <= Date.now())
  if (!ownerLost && !failure.rowCount && Date.now() - state.created_at.getTime() < state.definition.spec.policy.preparationTimeoutMs)
    throw new DomainError('SOURCE_PREPARATION_ACTIVE', 'The original Job preparation still has admission authority.', 409)
}
async function authorize(sql: GraphSqlClient, principal: ManagementPrincipal, workspaceId: string, write: boolean) {
  await authorizeSource(sql, principal, 'sources:read', workspaceId)
  await authorizeSource(sql, principal, 'source_roots:read', workspaceId)
  return write ? (await authorizeSource(sql, principal, 'sources:reconcile', workspaceId)).principal : principal
}
export async function requireSourcePreparationHost(sql: GraphSqlClient, state: State) {
  const root = state.root
  const policy = await sql.query('select 1 from workspace_root_policies where workspace_id=$1 and root_policy_id=$2 and root_policy_revision=$3 and revoked_at is null for share',
    [state.workspaceId, root.selection.rootPolicyId, root.selection.rootPolicyRevision])
  if (policy.rowCount !== 1) throw new DomainError('ROOT_POLICY_UNAVAILABLE', 'The original cleanup root policy is unavailable or revoked.', 409)
  const registration = await assertDeviceHostInstallation(sql, root.selection.hostRef, root.binding.workerInstallationId ?? root.binding.mainId)
  if (root.registration ? !registration || registration.workerInstallationId !== root.registration.workerInstallationId
    || registration.keyRevision !== root.registration.keyRevision || registration.authorizationRevision !== root.registration.authorizationRevision
    : registration !== null) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'The original cleanup host registration changed.', 409)
}

/** Cleanup authority is separate from the host's physical closure confirmation. */
export async function resolvePreparationReconciliationOwner(sql: GraphSqlClient, reconciliationId: string) {
  const row = (await sql.query<{ workspace_id: string; operation_id: string; principal_id: string;
    status: string; owner: unknown; queue_ticket_id: string | null }>(
    'select workspace_id,operation_id,principal_id,status,owner,queue_ticket_id from source_preparation_reconciliations where reconciliation_id=$1 for share', [reconciliationId])).rows[0]
  if (!row || row.status !== 'reconciling') throw new DomainError('SOURCE_RECONCILIATION_UNAVAILABLE', 'The original cleanup command has no active reconciliation authority.', 409)
  let principalId = row.principal_id
  if (row.queue_ticket_id) {
    const ticket = await requireQueuedPreparationClosed(sql, row.queue_ticket_id)
    if (ticket.operationId !== row.operation_id || ticket.workspaceId !== row.workspace_id
      || ticket.principalId !== row.principal_id) {
      throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'Queued cleanup belongs to another original preparation.', 409)
    }
  } else {
    const principal = await readLiveManagementPrincipal(sql, row.principal_id)
    await authorize(sql, principal, row.workspace_id, true)
    principalId = principal.id
  }
  const state = await loadSourcePreparation(sql, row.workspace_id, row.operation_id)
  if (row.queue_ticket_id) {
    validateQueuedSourcePreparation(await requireQueuedPreparationClosed(sql, row.queue_ticket_id), state)
  } else if (await admissionClosed(sql, state)) {
    requireAuthorization(await readLiveManagementPrincipal(sql, principalId), 'jobs:cancel', { workspaceId: state.workspaceId })
  }
  await requireSourcePreparationHost(sql, state)
  const owner = SourceOperationOwnerSchema.parse(row.owner)
  if ((owner.preparationKind === 'workflow') !== (state.kind === 'workflow')
    || state.kind === 'workflow' && !isDeepStrictEqual(owner.preparationNativeSession ?? null, state.nativeSession)
    || !isDeepStrictEqual(owner.root, state.root) || !isDeepStrictEqual(owner.attempt, state.attempt)
    || !isDeepStrictEqual(owner.record, state.record) || owner.identity.operationId !== state.operationId
    || owner.identity.ownerPrincipalId !== principalId || Date.parse(owner.identity.expiresAt) <= Date.now())
    throw new DomainError('SOURCE_ATTEMPT_CONFLICT', 'The original reconciliation authority changed.', 409)
  return owner
}

export class PostgresSourcePreparationReconciliation {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly executions: SourceExecutionHostPort,
    private readonly options: { retireTransfers?: ((closure: SourcePreparationClosure) => Promise<void>) | undefined } = {}) {}
  private async transaction<T>(work: (sql: pg.PoolClient) => Promise<T>) {
    return withTransaction(this.pool, work)
  }
  async get(principal: ManagementPrincipal, _source: 'http' | 'mcp', raw: unknown) {
    const input = SourcePreparationGetInputSchema.parse(raw)
    return this.transaction(async sql => {
      await authorize(sql, principal, input.workspaceId, false)
      let operationId = input.operationId
      if (!operationId) {
        const rows = (await sql.query<{operation_id: string}>('select operation_id from job_preparations where workspace_id=$1 and command_id=$2 limit 2', [input.workspaceId,input.startCommandId])).rows
        if (rows.length !== 1) throw new DomainError('SOURCE_PREPARATION_NOT_FOUND', 'The original Start command is missing or ambiguous; use its exact operationId.', 404)
        operationId = rows[0]!.operation_id
      }
      return metadata(await loadSourcePreparation(sql, input.workspaceId, operationId))
    })
  }
  async reconcile(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown) {
    const input = SourcePreparationReconcileInputSchema.parse(raw)
    try { requireAuthorization(principal, 'sources:reconcile', input) }
    catch (error) { await this.commands.recordDenied(principal.id, source, 'source.preparation.reconcile', input.workspaceId); throw error }
    let closure: SourcePreparationClosure | undefined
    return this.commands.execute({ principal, source, operation: 'source.preparation.reconcile', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:source-preparation:${input.operationId}`, payload: input,
      authorize: sql => authorize(sql, principal, input.workspaceId, true).then(() => {}),
      prepare: async () => {
        const pending = await this.transaction(async sql => {
          await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-reconcile:${input.operationId}`])
          const live = await authorize(sql, principal, input.workspaceId, true), state = await loadSourcePreparation(sql, input.workspaceId, input.operationId)
          if (state.root.selection.hostRef.kind !== 'device' && state.kind !== 'workflow') {
            throw new DomainError('SOURCE_RECONCILIATION_UNAVAILABLE', 'Job preparation cleanup requires its original worker journal.', 409)
          }
          const closedJob = await admissionClosed(sql, state)
          if (closedJob) requireAuthorization(live, 'jobs:cancel', { workspaceId: state.workspaceId })
          await requireSourcePreparationHost(sql, state)
          if (state.status === 'closed' && closedJob?.schemaVersion !== 2) { closure = SourcePreparationClosureSchema.parse(state.closure); return null }
          if (state.owner && state.status !== 'closed') {
            const owner = SourceOperationOwnerSchema.parse(state.owner)
            if (owner.identity.ownerPrincipalId !== live.id || state.command_id !== input.commandId) throw new DomainError('SOURCE_RECONCILIATION_CONFLICT', 'Retry the original pending cleanup command and principal.', 409)
            return { reconciliationId: state.reconciliation_id!, owner }
          }
          const reconciliationId = randomUUID(), owner: SourceOperationOwner = { identity: { operationId: input.operationId,
            ownerPrincipalId: live.id, expiresAt: closedJob ? new Date(Math.min(Date.parse(live.expiresAt),
              Date.now() + (closedJob.schemaVersion === 2 ? closedJob.acceptedSpec.policy.cleanupTimeoutMs : 60_000))).toISOString() : live.expiresAt }, root: state.root, attempt: state.attempt,
            source: state.root.source, record: state.record, physicalClosureConfirmed: false, preparationClosed: true,
            ...(state.kind === 'job' && state.definition.schemaVersion === 2 ? { quotaRequired: true as const } : {}),
            ...(state.kind === 'workflow' ? { preparationKind: 'workflow' as const,
              preparationNativeSession: state.nativeSession } : {}) }
          await sql.query(`insert into source_preparation_reconciliations(operation_id,reconciliation_id,workspace_id,principal_id,command_id,status,owner)
            values($1,$2,$3,$4,$5,'reconciling',$6::jsonb)
            on conflict(operation_id) do update set reconciliation_id=excluded.reconciliation_id,
              principal_id=excluded.principal_id,command_id=excluded.command_id,status='reconciling',owner=excluded.owner,closure=null`,
          [input.operationId,reconciliationId,input.workspaceId,live.id,input.commandId,JSON.stringify(owner)])
          return { reconciliationId, owner }
        })
        if (pending) {
          if (!this.executions.reconcilePreparation) throw new DomainError('SOURCE_RECONCILIATION_UNAVAILABLE', 'The installed source host does not support preparation reconciliation.', 409)
          closure = validateSourcePreparationClosure(pending.reconciliationId, pending.owner,
            await this.executions.reconcilePreparation(pending.reconciliationId, pending.owner))
        }
        if (closure) await this.options.retireTransfers?.(closure)
      },
      perform: async sql => {
        const live = await authorize(sql, principal, input.workspaceId, true)
        const state = await loadSourcePreparation(sql, input.workspaceId, input.operationId)
        if (await admissionClosed(sql, state)) requireAuthorization(live, 'jobs:cancel', { workspaceId: state.workspaceId })
        await requireSourcePreparationHost(sql, state)
        if (!closure || closure.reconciliationId !== state.reconciliation_id) throw new DomainError('SOURCE_RECLAMATION_UNCONFIRMED', 'Worker closure was not positively confirmed.', 409)
        await new PostgresSourceReservations().retainClosedPreparation(
          sql, state.reservation, closure, Number(state.reserved_bytes),
        )
        await sql.query("update source_execution_materializations set state='closed' where operation_id=$1", [input.operationId])
        await sql.query("update source_preparation_reconciliations set status='closed',closure=$2::jsonb where operation_id=$1", [input.operationId,JSON.stringify(closure)])
        return metadata(await loadSourcePreparation(sql, input.workspaceId, input.operationId))
      } })
  }
}
