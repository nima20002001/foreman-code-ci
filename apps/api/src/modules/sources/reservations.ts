import type { JobVerificationProfile } from '@foreman-code/contracts/job-verification-runtime'
import type { SourceCapacityErrorDetails } from '@foreman-code/contracts'
import { ResolvedJobDefinitionSpecRecordSchema } from '@foreman-code/contracts/job-verification'
import { readJobRuntimeProfileVersion } from '../jobs/runtimeProfileVersion.js'
import { JOB_VERIFICATION_OWNER_CONFIGURATION } from '@foreman-code/contracts/job-verification-policy'
import { randomUUID } from 'node:crypto'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { isDeepStrictEqual } from 'node:util'
import { DomainError } from '../errors.js'
import type { SourcePreparationClosure } from '@foreman-code/contracts/source-admission'
import type { SourceOperationOwner, SourceReservationReclamation } from '@foreman-code/contracts/source-operations'
import { RetainedSourceFootprintSchema, type RetainedSourceFootprint } from '@foreman-code/contracts/source-operations'
import { SourceStorageCapacitySchema, type SourceStorageCapacity } from '@foreman-code/contracts/source-operations'
import { SOURCE_AGGREGATE_LIMITS, sourceStorageLimits } from './storageCapacity.js'
export { SOURCE_AGGREGATE_LIMITS } from './storageCapacity.js'

export type SourceReservation = { reservationId: string; scopeId: string; ownerKind: 'capture' | 'transfer' | 'materialization'; ownerId: string; reservedBytes: number;
  preparation?: SourceOperationOwner; reclamation?: SourceReservationReclamation;
  storageCapacity?: SourceStorageCapacity;
  preparationClosure?: SourcePreparationClosure;
  referenceReclaimed?: true;
  cleanupRetry?: { failures: number; nextAttemptAt: string };
  retainedSharedTree?: { id: string; bytes: number } }
export async function requireUnreclaimedSourceOperation(sql: GraphSqlClient, operationId: string): Promise<void> {
  const fenced = await sql.query(`select 1 from source_storage_reservations
    where owner_kind='materialization' and owner_id=$1 and (record ? 'reclamation' or state='reclaimed')`, [operationId])
  if (fenced.rowCount) {
    throw new DomainError('SOURCE_PREPARATION_RECONCILED', 'The original source reservation is being reclaimed.', 409)
  }
}
export function verificationSourceStorageBytes(profile: JobVerificationProfile): number {
  const fingerprint = profile.measurement?.fingerprint
  const pool = fingerprint?.quotaPool
  if (!fingerprint || !pool) return 0
  return Math.min(pool.slots.reduce((total, slot) => total + slot.hardLimitBytes, 0),
    fingerprint.deviceLimits.diskBytes - fingerprint.quota.controlHardLimitBytes,
    fingerprint.quota.volumeCapacityBytes - fingerprint.quota.controlHardLimitBytes)
}
async function materializationCapacity(sql: GraphSqlClient, request: Omit<SourceReservation, 'reservationId'>,
  limits: ReturnType<typeof sourceStorageLimits>) {
  const ordinary = { verification: false, bytes: limits.bytes, materializations: limits.materializations }
  if (request.ownerKind !== 'materialization') return ordinary
  const row = (await sql.query<{ workspace_id: string; spec: unknown }>(
    `select workspace_id,spec from job_computer_selections
      where operation_id=$1 and released_at is null`, [request.ownerId])).rows[0]
  if (!row) return ordinary
  const spec = ResolvedJobDefinitionSpecRecordSchema.parse(row.spec)
  if (!('verification' in spec)) return ordinary
  const profile = await readJobRuntimeProfileVersion(sql, row.workspace_id,
    spec.policy.isolationPolicyId, spec.policy.isolationPolicyRevision)
  if (profile.schemaVersion !== 2) throw new DomainError('SOURCE_QUOTA_MISSING', 'Verification source requires its saved verification profile.', 409)
  const measured = profile.measurement
  const pool = measured?.fingerprint.quotaPool
  if (!pool || !measured) throw new DomainError('SOURCE_QUOTA_MISSING', 'Verification source requires its qualified quota pool.', 409)
  const approved = profile.root.selection.hostRef.kind === 'main'
    ? JOB_VERIFICATION_OWNER_CONFIGURATION.mainConcurrentJobs : JOB_VERIFICATION_OWNER_CONFIGURATION.laptopConcurrentJobs
  return { verification: true, bytes: verificationSourceStorageBytes(profile),
    materializations: Math.min(approved, pool.slots.length, ...measured.suites.map(suite => suite.maxConcurrentHeavyJobs)) }
}
/** All main processes serialize reservations for one attested host/filesystem.
 * Staging and retained copies remain charged until physical reclamation proof.
 * Execution closure and capture ownership reconciliation precede reclamation.
 */
export class PostgresSourceReservations {
  constructor(private readonly readCapacity?:
    (request: Omit<SourceReservation, 'reservationId'>) => Promise<SourceStorageCapacity>) {}
  async retainClosedPreparation(sql: GraphSqlClient, reservation: SourceReservation,
    closure: SourcePreparationClosure, currentBytes: number): Promise<void> {
    if (reservation.ownerKind !== 'materialization' || reservation.ownerId !== closure.operationId) {
      throw new DomainError('SOURCE_RESERVATION_CONFLICT', 'Preparation closure belongs to another reservation.', 409)
    }
    if (closure.quotaReclaimed) {
      await this.reclaimed(sql, reservation, async () => closure.childrenClosed && closure.claimReleased)
      return
    }
    // Without a materialization, only the bounded 16 KiB closure record remains.
    const retainedBytes = closure.materializationId === null ? Math.min(currentBytes, 16 * 1024) : currentBytes
    await this.retain(sql, reservation, 'retained', retainedBytes)
  }
  async reserve(sql: GraphSqlClient, request: Omit<SourceReservation, 'reservationId'>,
    options: { capacity?: SourceStorageCapacity } = {}): Promise<SourceReservation> {
    if (!Number.isSafeInteger(request.reservedBytes) || request.reservedBytes < 0 || request.reservedBytes > SOURCE_AGGREGATE_LIMITS.bytes)
      throw new DomainError('SOURCE_CAPACITY', 'Invalid source disk reservation.', 409)
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${request.scopeId}`])
    const existing = (await sql.query<{ record: SourceReservation; state: string }>(
      'select record,state from source_storage_reservations where owner_kind=$1 and owner_id=$2 for update', [request.ownerKind, request.ownerId])).rows[0]
    if (existing) {
      if (existing.record.reclamation) {
        throw new DomainError('SOURCE_PREPARATION_RECONCILED', 'The original source reservation is being reclaimed.', 409)
      }
      const { preparation: existingPreparation, retainedSharedTree: _retainedSharedTree, ...existingRequest } = existing.record
      const { preparation: requestedPreparation, retainedSharedTree: _requestedTree, ...requested } = request
      void _retainedSharedTree
      void _requestedTree
      if (!isDeepStrictEqual({ ...existingRequest, reservationId: undefined, storageCapacity: undefined },
        { ...requested, reservationId: undefined, storageCapacity: undefined })
        || existingPreparation && requestedPreparation && !isDeepStrictEqual(
          { ...existingPreparation, identity: { ...existingPreparation.identity, expiresAt: null } },
          { ...requestedPreparation, identity: { ...requestedPreparation.identity, expiresAt: null } })
        || existing.state === 'reclaimed')
        throw new DomainError('SOURCE_RESERVATION_CONFLICT', 'The source reservation identity or retained bytes changed.', 409)
      if (!existingPreparation && requestedPreparation) {
        const record = { ...existing.record, preparation: requestedPreparation }
        await sql.query('update source_storage_reservations set record=$2::jsonb where reservation_id=$1',
          [record.reservationId, JSON.stringify(record)])
        return record
      }
      return existing.record
    }
    if (!options.capacity && !this.readCapacity) {
      throw new DomainError('SOURCE_CAPACITY_UNAVAILABLE', 'Source capacity requires a measurement from its host.', 409)
    }
    const measured = SourceStorageCapacitySchema.parse(options.capacity ?? await this.readCapacity!(request))
    if (Date.now() - Date.parse(measured.observedAt) > 10_000 || Date.parse(measured.observedAt) > Date.now() + 1000) {
      throw new DomainError('SOURCE_CAPACITY_UNAVAILABLE', 'Source capacity measurement is stale.', 409)
    }
    const limits = sourceStorageLimits(measured)
    const capacity = await materializationCapacity(sql, request, limits)
    // Verification and other materializations (Agent worktrees) are separate pools for bytes and for count, so
    // running Agents never occupy the computer's CI slots.
    const totals = (await sql.query<{ bytes: string; verification_bytes: string; pending_bytes: string;
      retained_bytes: string; verification_retained_bytes: string;
      preparing: string; materializations: string;
      verification_materializations: string }>(`select
      coalesce(sum(reserved_bytes) filter(where not verification),0) as bytes,
      coalesce(sum(reserved_bytes) filter(where verification),0) as verification_bytes,
      coalesce(sum(reserved_bytes) filter(where state='retained' and not verification),0) as retained_bytes,
      coalesce(sum(reserved_bytes) filter(where state='retained' and verification),0) as verification_retained_bytes,
      coalesce(sum(reserved_bytes) filter(where state in ('preparing','owned','uncertain')),0) as pending_bytes,
      count(*) filter(where state='preparing') as preparing,
      count(*) filter(where owner_kind='materialization' and state in ('preparing','owned','uncertain') and not verification) as materializations,
      count(*) filter(where owner_kind='materialization' and state in ('preparing','owned','uncertain') and verification)
        as verification_materializations
      from (select r.*,exists(select 1 from job_computer_selections s
        where r.owner_kind='materialization' and s.operation_id=r.owner_id and s.spec ? 'verification') as verification
        from source_storage_reservations r where r.scope_id=$1 and r.state<>'reclaimed') usage`, [request.scopeId])).rows[0]!
    const usedBytes = capacity.verification ? Number(totals.verification_bytes) : Number(totals.bytes)
    const retainedBytes = Number(capacity.verification ? totals.verification_retained_bytes : totals.retained_bytes)
    const activeMaterializations = Number(capacity.verification ? totals.verification_materializations : totals.materializations)
    const pendingBytes = Number(totals.pending_bytes)
    const preparing = Number(totals.preparing)
    const idle = preparing === 0 && Number(totals.materializations) === 0
      && Number(totals.verification_materializations) === 0
    // An idle scope gets one memory slot so low-memory hosts can make progress.
    const minimumConcurrency = idle ? 1 : 0
    const preparationLimit = Math.max(limits.preparing, minimumConcurrency)
    const materializationLimit = capacity.verification ? capacity.materializations
      : Math.max(capacity.materializations, minimumConcurrency)
    // Free space already excludes retained files. Outstanding writers remain fully charged in both pools.
    const exhausted: SourceCapacityErrorDetails['exhausted'] = []
    if (usedBytes + request.reservedBytes > capacity.bytes) exhausted.push('retained_bytes')
    if (pendingBytes + request.reservedBytes > limits.availableBytes) exhausted.push('available_bytes')
    if (preparing >= preparationLimit) exhausted.push('preparations')
    if (request.ownerKind === 'materialization' && activeMaterializations >= materializationLimit) {
      exhausted.push('materializations')
    }
    if (exhausted.length) {
      // Active writers release their slots and staging charge after physical closure.
      // A request that cannot fit alongside retained files still requires operator action.
      const retryable = retainedBytes + request.reservedBytes <= capacity.bytes
        && request.reservedBytes <= limits.availableBytes
      throw new DomainError('SOURCE_CAPACITY',
        'Aggregate source staging, retained copies or active materializations exhaust this host/filesystem budget.', 409, {
          scopeId: request.scopeId,
          retryable,
          pool: capacity.verification ? 'verification' : 'ordinary',
          exhausted,
          usage: { usedBytes, retainedBytes, pendingBytes, preparing, activeMaterializations,
            requestedBytes: request.reservedBytes },
          limits: { bytes: capacity.bytes, availableBytes: limits.availableBytes,
            preparing: preparationLimit, materializations: materializationLimit },
          measured: { cpuCount: measured.cpuCount, availableMemoryBytes: measured.availableMemoryBytes,
            observedAt: measured.observedAt },
        })
    }
    const reservation = { ...request, reservationId: randomUUID(), storageCapacity: measured }
    await sql.query(`insert into source_storage_reservations(reservation_id,scope_id,owner_kind,owner_id,reserved_bytes,state,record)
      values($1,$2,$3,$4,$5,'preparing',$6::jsonb)`, [reservation.reservationId, request.scopeId, request.ownerKind, request.ownerId, request.reservedBytes, JSON.stringify(reservation)])
    return reservation
  }
  async retain(sql: GraphSqlClient, reservation: SourceReservation, state: 'retained' | 'owned' | 'uncertain', accountedBytes = reservation.reservedBytes): Promise<void> {
    if (!Number.isSafeInteger(accountedBytes) || accountedBytes < 0) throw new DomainError('SOURCE_CAPACITY', 'Invalid verified source footprint.', 409)
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${reservation.scopeId}`])
    const result = await sql.query(`update source_storage_reservations set state=$2,reserved_bytes=$3 where reservation_id=$1 and state<>'reclaimed'`, [reservation.reservationId, state, accountedBytes])
    if (result.rowCount !== 1) throw new DomainError('SOURCE_RESERVATION_CONFLICT', 'Source reservation is not retained.', 409)
  }
  async retainMaterialization(sql: GraphSqlClient, reservation: SourceReservation,
    rawFootprint: RetainedSourceFootprint): Promise<void> {
    const footprint = RetainedSourceFootprintSchema.parse(rawFootprint)
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${reservation.scopeId}`])
    if (footprint.sharedTree) {
      // The latest closed execution owns the shared directory's entire current charge.
      await sql.query(`update source_storage_reservations
        set reserved_bytes=reserved_bytes-(record#>>'{retainedSharedTree,bytes}')::bigint,
          record=record-'retainedSharedTree'
        where scope_id=$1 and reservation_id<>$2 and state='retained'
          and record#>>'{retainedSharedTree,id}'=$3`,
      [reservation.scopeId, reservation.reservationId, footprint.sharedTree.id])
    }
    await this.retain(sql, reservation, 'retained', footprint.retainedBytes)
    const record = { ...reservation }
    delete record.retainedSharedTree
    if (footprint.sharedTree) record.retainedSharedTree = footprint.sharedTree
    await sql.query('update source_storage_reservations set record=$2::jsonb where reservation_id=$1',
      [reservation.reservationId, JSON.stringify(record)])
  }
  /** Authoritative physical deletion AND execution closure must precede this.
   * No automatic timer or client input can provide that proof. */
  async reclaimed(sql: GraphSqlClient, reservation: SourceReservation, prove: () => Promise<boolean>): Promise<void> {
    if (!await prove()) throw new DomainError('SOURCE_RECLAMATION_UNCONFIRMED', 'Physical source reclamation is not confirmed.', 409)
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${reservation.scopeId}`])
    await sql.query(`update source_storage_reservations set state='reclaimed' where reservation_id=$1`, [reservation.reservationId])
  }
}
