import { randomUUID } from 'node:crypto'
import { withTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { SourceMaterializationRecordSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { SourceOperationOwnerSchema, SourceReservationReclamationSchema,
  type SourceReservationReclamation } from '@foreman-code/contracts/source-operations'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { admissionClosed, loadSourcePreparation, validateSourcePreparationClosure } from './preparationReconciliation.js'
import type { SourceReclamationResult } from './reclaimSourceReservation.js'
import { PostgresSourceReservations, type SourceReservation } from './reservations.js'
import { withSourceOperationExclusion } from './sourceOperationExclusion.js'
import { localWorkflowSourceClosed } from './workflowCleanup.js'
import { oldestRetainedMaterialization } from './retainedMaterializations.js'
import { componentLogger } from '../diagnostics/logger.js'

async function hasActiveAdmission(sql: GraphSqlClient, operationId: string): Promise<boolean> {
  const active = await sql.query(`select 1 from job_executions e where e.operation_id=$1
      and (e.record#>>'{process,phase}' is distinct from 'terminal'
        or e.record#>>'{process,processStopped}' is distinct from 'true'
        or e.record->>'publication' not in ('complete','failed'))
    union all select 1 from job_admission_queue q where q.operation_id=$1
      and q.record->>'state' in ('waiting','blocked','claimed')`, [operationId])
  return Boolean(active.rowCount)
}

async function admissionRemainsClosed(sql: GraphSqlClient, operationId: string): Promise<boolean> {
  if (await hasActiveAdmission(sql, operationId)) return false
  // The fence already checked ownership. Cleanup callbacks may run while the Run owner waits for them.
  const activeRuns = await sql.query(`with preparations as (
      select i.run_id from execution_dispatch_intents i where i.operation_id=$1
      union select w.run_id from workflow_job_preparations w where w.preparation->>'operationId'=$1
    ) select r.id from preparations p join runs r on r.id=p.run_id
      where r.execution_state not in ('completed','interrupted') and r.stop_requested_at is null
        and not exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)`, [operationId])
  return activeRuns.rowCount === 0
}

async function admissionInactive(sql: GraphSqlClient, operationId: string): Promise<boolean> {
  if (await hasActiveAdmission(sql, operationId)) return false
  const reconciliation = (await sql.query<{ owner: unknown; principal_id: string; command_id: string;
    queue_ticket_id: string | null }>(`select owner,principal_id,command_id,queue_ticket_id
      from source_preparation_reconciliations where operation_id=$1 and status<>'closed'`, [operationId])).rows[0]
  if (reconciliation) {
    const owner = SourceOperationOwnerSchema.parse(reconciliation.owner)
    if (Date.parse(owner.identity.expiresAt) > Date.now()) return false
    const lock = reconciliation.queue_ticket_id
      ? await sql.query<{ locked: boolean }>('select pg_try_advisory_xact_lock(810038,hashtext($1)) as locked',
        [owner.attempt.executionId])
      : await sql.query<{ locked: boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) as locked',
        [`command:${reconciliation.principal_id}:source.preparation.reconcile:${reconciliation.command_id}`])
    if (!lock.rows[0]?.locked) return false
  }
  const preparations = await sql.query<{ workspace_id: string; run_id: string | null }>(
    `select workspace_id,null::text as run_id from job_preparations
    where operation_id=$1 union select r.workspace_id,r.id from workflow_job_preparations w join runs r on r.id=w.run_id
    where w.preparation->>'operationId'=$1
    union select r.workspace_id,r.id from execution_dispatch_intents i join runs r on r.id=i.run_id
    where i.operation_id=$1`, [operationId])
  for (const preparation of preparations.rows) {
    if (preparation.run_id) {
      // A live Run can hold its row while waiting for this cleanup's storage lock.
      const ownership = await sql.query<{ locked: boolean }>(
        'select pg_try_advisory_xact_lock($1,hashtext($2)) as locked', [810_002, preparation.run_id])
      if (!ownership.rows[0]?.locked) return false
      const run = await sql.query('select id from runs where id=$1 for share skip locked', [preparation.run_id])
      if (!run.rowCount) return false
    }
  }
  for (const preparation of preparations.rows) {
    try {
      await admissionClosed(sql, await loadSourcePreparation(sql, preparation.workspace_id, operationId))
    } catch (error) {
      if (error instanceof DomainError && error.code === 'SOURCE_PREPARATION_ACTIVE') return false
      throw error
    }
  }
  const live = await sql.query(`select 1 from job_computer_selections s where s.operation_id=$1 and s.released_at is null
      and not exists(select 1 from job_preparations p where p.operation_id=$1)
      and not exists(select 1 from workflow_job_preparations w where w.preparation->>'operationId'=$1)
      and not exists(select 1 from job_executions e where e.operation_id=$1)
      and not exists(select 1 from job_admission_queue q where q.operation_id=$1 and q.record->>'state'='terminal')
      and not exists(select 1 from source_preparation_reconciliations c where c.operation_id=$1 and c.status='closed')
      and not exists(select 1 from workflow_job_preparations w join runs r on r.id=w.run_id
        where w.preparation->>'operationId'=$1 and r.execution_state in ('completed','interrupted'))`, [operationId])
  return live.rowCount === 0
}

export class MaterializationReservationCleanup {
  private reconciliation: Promise<number> | undefined
  constructor(private readonly pool: pg.Pool,
    private readonly reclaim: (grant: SourceReservationReclamation) => Promise<SourceReclamationResult>) {}

  startReconciliation(report: (error: unknown) => void): void {
    if (this.reconciliation) return
    this.reconciliation = this.reconcile(report).catch(error => {
      report(error)
      return 0
    }).finally(() => { this.reconciliation = undefined })
  }

  async drain(): Promise<void> {
    await this.reconciliation
  }

  async reclaimOldestRetained(scopeId: string): Promise<boolean> {
    const attempted: string[] = []
    for (;;) {
      const candidate = await oldestRetainedMaterialization(this.pool, scopeId, undefined, attempted)
      if (!candidate) return false
      attempted.push(candidate.reservation_id)
      const reclaimed = await withSourceOperationExclusion(candidate.owner_id, () =>
        this.reconcileCandidate(candidate, error => {
          componentLogger('byte-transfer').warn({ err: error, reservationId: candidate.reservation_id, scopeId },
            'Retained source reclamation deferred')
        }, { removeRetained: true }))
      if (reclaimed) return true
    }
  }

  private async defer(reservationId: string, failures: number): Promise<void> {
    const delayMs = failures === 0 ? 0 : Math.min(900_000, 30_000 * 2 ** Math.min(5, failures - 1))
    await this.pool.query(`update source_storage_reservations
      set record=jsonb_set(record,'{cleanupRetry}',$2::jsonb)
      where reservation_id=$1 and state in ('preparing','owned','uncertain')`,
    [reservationId, JSON.stringify({ failures, nextAttemptAt: new Date(Date.now() + delayMs).toISOString() })])
  }

  private async transaction<T>(work: (sql: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, work)
  }

  async authorize(sql: GraphSqlClient, reservationId: string, reclamationId: string) {
    const row = (await sql.query<{ record: SourceReservation }>(`select record from source_storage_reservations
      where reservation_id=$1 and owner_kind='materialization' and state<>'reclaimed' for share`, [reservationId])).rows[0]
    if (!row?.record.reclamation || row.record.reclamation.reclamationId !== reclamationId) {
      throw new DomainError('SOURCE_RECLAMATION_UNCONFIRMED', 'The original source cleanup is unavailable.', 403)
    }
    const grant = SourceReservationReclamationSchema.parse(row.record.reclamation)
    if (grant.reclamationId !== reclamationId || grant.reservationId !== reservationId
      || row.record.ownerId !== grant.operationId || row.record.scopeId !== grant.scopeId
      || Date.parse(grant.expiresAt) <= Date.now() || !await admissionRemainsClosed(sql, grant.operationId)) {
      throw new DomainError('SOURCE_RECLAMATION_UNCONFIRMED', 'The original source cleanup no longer has authority.', 409)
    }
    if (grant.removeRetained && !await oldestRetainedMaterialization(sql, grant.scopeId, reservationId)) {
      throw new DomainError('SOURCE_RECLAMATION_UNCONFIRMED', 'The retained source is still needed by its Run.', 409)
    }
    for (const root of grant.roots) {
      const registration = await assertDeviceHostInstallation(sql, root.selection.hostRef,
        root.binding.workerInstallationId ?? root.binding.mainId)
      if (root.registration && (!registration || registration.keyRevision !== root.registration.keyRevision
        || registration.authorizationRevision !== root.registration.authorizationRevision)) {
        throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'The original cleanup host registration changed.', 409)
      }
    }
    return grant
  }

  private async fence(reservationId: string, options: { removeRetained?: true } = {}) {
    return this.transaction(async sql => {
      const candidate = (await sql.query<{ record: SourceReservation }>(`select record from source_storage_reservations
        where reservation_id=$1 and (state in ('preparing','owned','uncertain')
          or ($2::boolean and state='retained'))`, [reservationId, options.removeRetained ?? false])).rows[0]
      if (!candidate) return null
      let reservation = candidate.record
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-reconcile:${reservation.ownerId}`])
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${reservation.scopeId}`])
      if (options.removeRetained) {
        const current = (await sql.query<{ record: SourceReservation }>(`select record
          from source_storage_reservations where reservation_id=$1 and state='retained' for update`, [reservationId])).rows[0]
        if (!current) return null
        reservation = current.record
      }
      const removeRetained = options.removeRetained ?? reservation.reclamation?.removeRetained
      if (removeRetained && !await oldestRetainedMaterialization(sql, reservation.scopeId, reservationId)) return null
      if (removeRetained) {
        if (await hasActiveAdmission(sql, reservation.ownerId)) return null
      } else if (!await admissionInactive(sql, reservation.ownerId)) return null
      const materialization = (await sql.query<{ record: unknown }>(
        'select record from source_execution_materializations where operation_id=$1', [reservation.ownerId])).rows[0]
      const reconciliation = (await sql.query<{ reconciliation_id: string; owner: unknown }>(`select reconciliation_id,owner
        from source_preparation_reconciliations where operation_id=$1 and status='reconciling'`, [reservation.ownerId])).rows[0]
      let owner = reservation.preparation ?? (reconciliation ? SourceOperationOwnerSchema.parse(reconciliation.owner) : null)
      const binding = materialization ? SourceMaterializationRecordSchema.parse(materialization.record).receipt.binding
        : owner?.root.binding
      if (!binding) return null
      if (materialization) {
        const record = SourceMaterializationRecordSchema.parse(materialization.record)
        const native = await sql.query(`select id from harness_executions
          where id=$1 and record->>'nativeSessionId' is not null`, [record.receipt.executionId])
        // A published result can precede the original native owner's close, on Main or on a Worker.
        if (native.rowCount && !await localWorkflowSourceClosed(sql, record.receipt.executionId)) return null
      }
      const rows = await sql.query<{ record: unknown }>(`select b.record from source_root_bindings b
        join application_installation a on a.singleton and a.id::text=(b.record#>>'{binding,mainId}')
        where concat(b.record#>>'{binding,mainId}',':',coalesce(b.record#>>'{binding,deviceId}','original-main'),':',
          coalesce(b.record#>>'{binding,workerInstallationId}',b.record#>>'{binding,mainId}'),':',
          b.record#>>'{binding,filesystem,device}',':',b.record#>>'{binding,filesystem,mountId}')=$1
          and b.root_id=$2 and b.binding_revision=$3`,
      [reservation.scopeId, binding.rootId, binding.bindingRevision])
      const roots = rows.rows.map(row => SourceRootRecordSchema.parse(row.record))
      if (!roots.length) return null
      if (materialization) {
        const record = SourceMaterializationRecordSchema.parse(materialization.record)
        const root = roots.find(root => root.binding.rootId === record.receipt.binding.rootId
          && root.binding.bindingRevision === record.receipt.binding.bindingRevision)
        if (!root) throw new DomainError('SOURCE_ROOT_NOT_FOUND', 'The original cleanup root is missing.', 409)
        owner = SourceOperationOwnerSchema.parse({ ...(owner ?? {}), identity: { operationId: reservation.ownerId,
          ownerPrincipalId: root.ownerPrincipalId, expiresAt: new Date(Date.now() + 300_000).toISOString() },
        root, source: root.source, record, physicalClosureConfirmed: false,
        attempt: { executionId: record.receipt.executionId, attemptId: record.receipt.attemptId,
          placementHash: record.receipt.placementHash, keyRevision: record.receipt.keyRevision,
          authorizationRevision: record.receipt.authorizationRevision } })
      }
      if (owner) owner = SourceOperationOwnerSchema.parse({ ...owner, preparationClosed: true })
      const grant = SourceReservationReclamationSchema.parse({ reservationId, scopeId: reservation.scopeId,
        ...(removeRetained ? { removeRetained } : {}),
        operationId: reservation.ownerId, reclamationId: reservation.reclamation?.reclamationId
          ?? reconciliation?.reconciliation_id ?? randomUUID(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(), roots, owner })
      await sql.query(`update source_storage_reservations set state='uncertain',record=$2::jsonb
        where reservation_id=$1 and state in ('preparing','owned','uncertain','retained')`,
      [reservationId, JSON.stringify({ ...reservation, reclamation: grant })])
      await this.authorize(sql, reservationId, grant.reclamationId)
      return grant
    })
  }

  async reconcile(report?: (error: unknown) => void): Promise<number> {
    const candidates = await this.pool.query<{ reservation_id: string; owner_id: string; retry: SourceReservation['cleanupRetry'] }>(
      `select reservation_id,owner_id,record->'cleanupRetry' as retry from source_storage_reservations
      where owner_kind='materialization' and state in ('preparing','owned','uncertain')
        and (record#>>'{cleanupRetry,nextAttemptAt}' is null or record#>>'{cleanupRetry,nextAttemptAt}' <= $1)
      order by coalesce(record#>>'{cleanupRetry,nextAttemptAt}',''),reservation_id limit 10`,
      [new Date().toISOString()])
    let reconciled = 0
    for (const candidate of candidates.rows) {
      if (await withSourceOperationExclusion(candidate.owner_id, () => this.reconcileCandidate(candidate, report))) reconciled++
    }
    return reconciled
  }

  private async reconcileCandidate(candidate: { reservation_id: string; retry: SourceReservation['cleanupRetry'] },
    report?: (error: unknown) => void, options: { removeRetained?: true } = {}): Promise<boolean> {
    try {
      const grant = await this.fence(candidate.reservation_id, options)
      if (!grant) {
        await this.defer(candidate.reservation_id, candidate.retry?.failures ?? 0)
        return false
      }
      const result = await this.reclaim(grant)
      await this.transaction(async sql => {
        await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-reconcile:${grant.operationId}`])
        await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${grant.scopeId}`])
        await this.authorize(sql, grant.reservationId, grant.reclamationId)
        const reservation = (await sql.query<{ record: SourceReservation }>(
          'select record from source_storage_reservations where reservation_id=$1 for update', [grant.reservationId])).rows[0]!.record
        delete reservation.cleanupRetry
        const original = grant.owner
        if (original) {
          const closure = result.closures.find(value => value.executionId === original.attempt.executionId
            && value.rootId === original.root.binding.rootId
            && value.bindingRevision === original.root.binding.bindingRevision)
          reservation.preparationClosure = validateSourcePreparationClosure(grant.reclamationId, original, closure)
        }
        const reservations = new PostgresSourceReservations()
        if (result.retained) {
          const receipt = original?.record?.receipt
          if (!grant.removeRetained && receipt?.sharedTree
            && (receipt.binding.accessMode === 'read-only' || receipt.worktree)) reservation.referenceReclaimed = true
          await reservations.retainMaterialization(sql, reservation,
            { ...result.retained, retainedBytes: result.retained.retainedBytes + 16 * 1024 })
        } else {
          await reservations.reclaimed(sql, reservation, async () => true)
        }
        await sql.query(`update source_execution_materializations set state='closed',
          worktree_cleanup=coalesce($2::jsonb,worktree_cleanup) where operation_id=$1`,
        [grant.operationId, result.retained?.worktree ? JSON.stringify({ ...result.retained.worktree,
          ...(result.retained.worktree.state === 'retained'
            ? { nextAttemptAt: new Date(Date.now() + 300_000).toISOString() } : {}) }) : null])
        await sql.query('update job_computer_selections set released_at=clock_timestamp() where operation_id=$1 and released_at is null',
          [grant.operationId])
        const pending = (await sql.query<{ reconciliation_id: string; owner: unknown }>(`select reconciliation_id,owner
          from source_preparation_reconciliations where operation_id=$1 and status='reconciling' for update`,
        [grant.operationId])).rows[0]
        if (pending) {
          const owner = SourceOperationOwnerSchema.parse(pending.owner)
          const raw = result.closures.find(closure => closure.executionId === owner.attempt.executionId
            && closure.rootId === owner.root.binding.rootId && closure.bindingRevision === owner.root.binding.bindingRevision)
          const closure = validateSourcePreparationClosure(pending.reconciliation_id, owner, raw)
          await sql.query("update source_preparation_reconciliations set status='closed',closure=$2::jsonb where operation_id=$1",
            [grant.operationId, JSON.stringify(closure)])
        }
        await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
          values($1,'system','source.materialization.reservation.release',$2,'succeeded',$3::jsonb)`,
        [grant.roots[0]!.ownerPrincipalId, grant.roots[0]!.binding.workspaceId,
          JSON.stringify({ reservationId: grant.reservationId, operationId: grant.operationId,
            reclamationId: grant.reclamationId, scopeId: grant.scopeId,
            ...(grant.removeRetained ? { reason: 'capacity' } : {}) })])
      })
      if (grant.removeRetained && !result.retained) {
        componentLogger('byte-transfer').info({ reservationId: grant.reservationId, operationId: grant.operationId,
          scopeId: grant.scopeId }, 'Reclaimed retained source materialization for capacity')
      }
      return true
    } catch (error) {
      await this.defer(candidate.reservation_id, (candidate.retry?.failures ?? 0) + 1)
      if (!report) throw error
      report(error)
      return false
    }
  }
}
