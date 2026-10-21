import { jobPlacementRequest } from './placementRequest.js'
import { disabledCiEnrollmentHosts } from './ciEnrollmentState.js'
import { jobRuntimeProfileLimits, type JobRuntimeProfileRecord, type JobVerificationProfile } from '@foreman-code/contracts/job-verification-runtime'
import { JOB_VERIFICATION_OWNER_CONFIGURATION } from '@foreman-code/contracts/job-verification-policy'
import { JobComputerSelectionSchema } from '@foreman-code/contracts/jobs'
import {
  isAutoJobSpecRecord,
  ResolvedJobDefinitionSpecRecordSchema,
  type JobDefinitionRecord,
  type JobDefinitionSpecRecord,
  type ResolvedJobDefinitionSpecRecord,
  type PreparedJobSpecRecord,
} from '@foreman-code/contracts/job-verification'
import type { JobRuntimeProfile } from '@foreman-code/contracts/job-runtime'
import { DEVICE_RESOURCE_CONTROL_RESERVE } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { BuildComputerPreference } from '@foreman-code/contracts/build-computers'
import { type BuildComputerSettings, buildComputerKey, buildComputerTarget } from '../settings/buildComputers.js'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { DomainError } from '../errors.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { JobSql } from './repository.js'
import { matchesRuntimePolicy } from './runtimeSelection.js'
import { SOURCE_AGGREGATE_LIMITS, verificationSourceStorageBytes } from '../sources/reservations.js'
import { SourceStorageCapacitySchema, type SourceStorageCapacity } from '@foreman-code/contracts/source-operations'
import { sourceStorageLimits } from '../sources/storageCapacity.js'
import { JobComputerEligibilityReasonSchema, type JobComputerEligibility, type JobPlacementIntent } from '@foreman-code/contracts/job-admission'

export interface JobPreparationIdentity { executionId: string; attemptId: string; operationId: string }
export interface JobComputerCandidate {
  spec: ResolvedJobDefinitionSpecRecord
  profile: JobRuntimeProfileRecord
  ready: boolean
  reasons: string[]
  sourceReservation: { scopeId: string; reservedBytes: number }
}
export interface JobComputerDiscovery {
  candidates: JobComputerCandidate[]
  diagnosticCodes: string[]
}
export interface JobComputerInventory {
  candidates(sql: JobSql, principal: ManagementPrincipal, workspaceId: string,
    spec: JobDefinitionSpecRecord, placement?: JobPlacementIntent, options?: { queued?: boolean }): Promise<JobComputerDiscovery>
}
type EnrolledCandidate = JobComputerCandidate & { preference: BuildComputerPreference }
export interface JobComputerClaim {
  spec: ResolvedJobDefinitionSpecRecord | null
  compatibleTargetCount: number
  reasons: JobComputerEligibility['reasons']
  diagnosticCodes: string[]
  waitingHosts: string[]
  selectedHost: string | null
  exceedsMaximum: boolean
}

/** An explicit placement names a computer and root. Each listing re-attests the root, so the attestation itself
 * cannot identify it; admission still uses the candidate's current attestation. */
function placedRoot(target: { destination?: unknown }) {
  if (!target.destination || typeof target.destination !== 'object') return target
  const destination = Object.fromEntries(Object.entries(target.destination as Record<string, unknown>)
    .filter(([key]) => key !== 'attestationId' && key !== 'attestationHash'))
  return { ...target, destination }
}

export function jobEligibilityReason(code: string): JobComputerEligibility['reasons'][number] {
  const known = JobComputerEligibilityReasonSchema.safeParse(code)
  if (known.success) return known.data
  if (['AUTH_REVOKED', 'AUTH_INVALID', 'revoked', 'unauthorized', 'forbidden', 'ACCESS_DENIED'].includes(code)) {
    return 'authorization_revoked'
  }
  if (code === 'BUILD_COMPUTER_DISABLED') return 'disabled'
  if (['SOURCE_CAPACITY', 'SOURCE_DISK_CAPACITY', 'SOURCE_CAPACITY_UNAVAILABLE'].includes(code)) return 'busy'
  if (code === 'WORKER_EXECUTION_DISABLED') return 'remote_execution_disabled'
  if (code === 'JOB_ROOT_PIN_CONFLICT' || code === 'SOURCE_ROOT_NOT_FOUND') return 'root_changed'
  if (code === 'JOB_SOURCE_PIN_CONFLICT') return 'source_unavailable'
  if (code === 'JOB_RUNTIME_UNQUALIFIED') return 'runtime_unqualified'
  if (code === 'JOB_RUNTIME_CONTEXT_CHANGED') return 'runtime_unqualified'
  if (code === 'JOB_DEPENDENCIES_CHANGED') return 'dependencies_changed'
  return 'eligibility_check_failed'
}
export function jobCanWait(code: string): boolean {
  return !['authorization_revoked', 'workspace_denied', 'computer_denied', 'root_changed', 'source_unavailable',
    'incompatible', 'request_exceeds_maximum', 'eligibility_check_failed'].includes(jobEligibilityReason(code))
}
export function compatibleJobComputer(candidate: JobComputerCandidate, request: JobDefinitionSpecRecord): boolean {
  const common = (spec: JobDefinitionSpecRecord) => ({ source: spec.source, argv: spec.argv,
    inputs: spec.inputs, outputs: spec.outputs, relativeCwd: spec.relativeCwd ?? null,
    ...('verification' in spec ? { verification: spec.verification } : {}) })
  if (canonicalJson(common(candidate.spec)) !== canonicalJson(common(request))) return false
  if (!isAutoJobSpecRecord(request)) return canonicalJson(candidate.spec) === canonicalJson(request)
  return matchesRuntimePolicy(request, candidate.profile, candidate.spec.policy)
    && canonicalJson(jobRuntimeProfileLimits(candidate.profile)) === canonicalJson(request.limits)
}
/** Local first: a preferred computer (an Agent's own) leads; the rest keep build priority order. */
export function orderForPlacement(candidates: EnrolledCandidate[], placement?: JobPlacementIntent | null): EnrolledCandidate[] {
  const ordered = orderBuildComputers(candidates)
  if (placement?.kind !== 'prefer') return ordered
  const preferred = canonicalJson(placement.hostRef)
  return [...ordered.filter(candidate => canonicalJson(candidate.spec.target.hostRef) === preferred),
    ...ordered.filter(candidate => canonicalJson(candidate.spec.target.hostRef) !== preferred)]
}
export function orderBuildComputers(candidates: EnrolledCandidate[]): EnrolledCandidate[] {
  return candidates.filter(candidate => candidate.ready && candidate.preference.buildEnabled).sort((left, right) => {
    const priority = right.preference.buildPriority - left.preference.buildPriority
    if (priority) return priority
    const leftKey = `${buildComputerKey(left.preference.target)}:${left.profile.root.binding.rootId}:${left.profile.id}`
    const rightKey = `${buildComputerKey(right.preference.target)}:${right.profile.root.binding.rootId}:${right.profile.id}`
    if (leftKey < rightKey) return -1
    if (leftKey > rightKey) return 1
    return 0
  })
}
/** Capacity a computer lends to builds: its qualified allowance minus the control reserve, with CPU and
 * memory further limited to the owner's build allowance percent. */
export function jobComputerCapacity(profile: JobRuntimeProfileRecord, allowancePercent = 100): JobRuntimeProfile['limits'] {
  const lent = jobComputerFullCapacity(profile)
  if (allowancePercent >= 100) return lent
  return { ...lent, cpuLimit: lent.cpuLimit * allowancePercent / 100,
    memoryBytes: Math.floor(lent.memoryBytes * allowancePercent / 100) }
}
function jobComputerFullCapacity(profile: JobRuntimeProfileRecord): JobRuntimeProfile['limits'] {
  const runtime = profile.schemaVersion === 1 ? profile.measurement?.runtime : profile.measurement?.fingerprint
  if (!runtime?.deviceLimits || !runtime.quota) return jobRuntimeProfileLimits(profile)
  const allowance = runtime.deviceLimits
  const reserve = DEVICE_RESOURCE_CONTROL_RESERVE
  let quotaBytes = runtime.quota.workloadHardLimitBytes
  if (profile.schemaVersion === 2 && profile.measurement) {
    quotaBytes = Math.min(runtime.quota.volumeCapacityBytes - runtime.quota.controlHardLimitBytes,
      profile.measurement.fingerprint.quotaPool?.slots.reduce((bytes, slot) => bytes + slot.hardLimitBytes, 0) ?? 0)
  }
  return { cpuLimit: allowance.cpuLimit - reserve.cpuLimit,
    memoryBytes: allowance.memoryBytes - reserve.memoryBytes,
    pidsLimit: allowance.pidsLimit - reserve.pidsLimit,
    diskBytes: Math.min(allowance.diskBytes - reserve.diskBytes, quotaBytes) }
}

export type VerificationMemoryReader = (profile: JobVerificationProfile) => Promise<number | null>
export type JobComputerCapacityDecision = { fits: true } | { fits: false;
  reason: 'busy' | 'memory_unavailable' | 'memory_headroom_required' | 'request_exceeds_maximum' }

const closedJobExecutionSql = `(e.record #>> '{process,phase}'='terminal'
      and e.record #> '{process,processStopped}'='true'::jsonb
      and e.record->>'publication' not in ('pending','collecting')
      and (
        (exists(select 1 from source_execution_materializations m
          where m.operation_id=e.operation_id and m.execution_id=e.id and m.state='closed')
        and not exists(select 1 from source_storage_reservations r
          where r.owner_kind='materialization' and r.owner_id=e.operation_id
            and r.state in ('preparing','owned','uncertain')))
        or exists(select 1 from job_runtime_qualification_approvals q
          where e.record #>> '{owner,grantId}'='qualification:'||q.id
            and e.accepted_spec #>> '{profile,qualificationId}'=q.record->>'qualificationId'
            and e.accepted_by=q.run_principal_id
            and (q.run_result->>'outcome'='qualified'
              or q.run_result #>> '{closure}'='confirmed'))))`


const closedJobComputerSql = `(
      exists(select 1 from job_executions e where e.id=s.execution_id and ${closedJobExecutionSql})
      or exists(select 1 from source_preparation_reconciliations c
        where c.operation_id=s.operation_id and c.status='closed' and c.closure is not null
        and not exists(select 1 from job_executions e where e.id=s.execution_id)))`

/** Releases only closed source owners; offline or uncertain delivery retains capacity. */
export async function releaseClosedJobComputers(sql: JobSql): Promise<void> {
  await sql.query(`update job_computer_selections s set released_at=clock_timestamp()
    where s.released_at is null and ${closedJobComputerSql}`)
}
export async function readJobComputerSelection(sql: JobSql, definition: JobDefinitionRecord,
  identity: JobPreparationIdentity): Promise<ResolvedJobDefinitionSpecRecord> {
  const row = (await sql.query<{ spec: unknown; definition_version_id: string; attempt_id: string; operation_id: string }>(
    'select spec,definition_version_id,attempt_id,operation_id from job_computer_selections where execution_id=$1 and workspace_id=$2 for share',
    [identity.executionId, definition.workspaceId])).rows[0]
  if (!row) {
    if (isAutoJobSpecRecord(definition.spec)) {
      throw new DomainError('JOB_COMPUTER_SELECTION_MISSING', 'The original Auto computer selection is missing.', 409)
    }
    return definition.spec
  }
  if (row.definition_version_id !== definition.versionId || row.attempt_id !== identity.attemptId
    || row.operation_id !== identity.operationId) {
    throw new DomainError('JOB_COMPUTER_SELECTION_CONFLICT', 'This selection belongs to another Job preparation.', 409)
  }
  return ResolvedJobDefinitionSpecRecordSchema.parse(row.spec)
}

export class JobComputerSelection {
  constructor(private readonly settings: BuildComputerSettings, private readonly inventory: JobComputerInventory,
    private readonly workerExecution: WorkerExecutionPolicy, private readonly availableMemory?: VerificationMemoryReader,
    private readonly assertBundleReady?: (host: CanonicalMachineReference) => Promise<void>) {}

  async reserve(sql: JobSql, principal: ManagementPrincipal, definition: JobDefinitionRecord,
    identity: JobPreparationIdentity): Promise<ResolvedJobDefinitionSpecRecord> {
    const claim = await this.claim(sql, principal, definition, identity)
    if (claim.spec) return claim.spec
    const code = isAutoJobSpecRecord(definition.spec) ? 'JOB_NO_BUILD_COMPUTER' : 'JOB_BUILD_COMPUTER_UNAVAILABLE'
    throw new DomainError(code, 'No eligible build computer. Enable builds and check connection, runtime setup and capacity.',
      409, { reasons: claim.reasons, diagnosticCodes: claim.diagnosticCodes })
  }

  async claim(sql: JobSql, principal: ManagementPrincipal, definition: JobDefinitionRecord,
    identity: JobPreparationIdentity, options: {
      excludedHosts?: ReadonlySet<string>
      placementOverride?: JobPlacementIntent | null
      limits?: JobRuntimeProfile['limits']
      queued?: boolean
    } = {}): Promise<JobComputerClaim> {
    const prior = (await sql.query('select 1 from job_computer_selections where execution_id=$1', [identity.executionId])).rowCount
    if (prior) {
      const spec = await readJobComputerSelection(sql, definition, identity)
      await this.assertBundleReady?.(spec.target.hostRef)
      return { spec, compatibleTargetCount: 1, reasons: [], diagnosticCodes: [], waitingHosts: [],
        selectedHost: buildComputerKey(buildComputerTarget(spec.target)), exceedsMaximum: false }
    }
    const request = jobPlacementRequest(definition.spec, options)
    const { enrolled, placementCandidates, reasons } = await this.candidates(sql, principal, definition.workspaceId,
      request, options.placementOverride, { queued: options.queued ?? false, lockEnrollment: true })
    const compatibleTargetCount = new Set(enrolled.map(candidate => buildComputerKey(candidate.preference.target))).size
    const exceedsMaximum = this.exceedsMaximum(enrolled)
    const waitingHosts: string[] = []
    for (const candidate of orderForPlacement(placementCandidates, options.placementOverride)) {
      if (!this.fitsEmptyComputer(candidate)) {
        reasons.push('request_exceeds_maximum')
        continue
      }
      try { this.workerExecution.requireEnabled(candidate.spec.target.hostRef) } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'WORKER_EXECUTION_DISABLED') throw error
        reasons.push('remote_execution_disabled')
        continue
      }
      const preference = await this.settings.requireEnabled(sql, buildComputerTarget(candidate.spec.target),
        { preference: candidate.preference })
      await this.assertBundleReady?.(candidate.spec.target.hostRef)
      const hostKey = buildComputerKey(preference.target)
      waitingHosts.push(hostKey)
      if (options.excludedHosts?.has(hostKey)) {
        reasons.push('busy')
        continue
      }
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`job-capacity:${hostKey}`])
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${candidate.sourceReservation.scopeId}`])
      await releaseClosedJobComputers(sql)
      const capacity = await this.fits(sql, candidate)
      if (!capacity.fits) {
        reasons.push(capacity.reason)
        continue
      }
      let mode: 'auto' | 'fixed' = isAutoJobSpecRecord(request) ? 'auto' : 'fixed'
      if (options.placementOverride?.kind === 'explicit') mode = 'fixed'
      const selection = { mode,
        buildPriority: preference.buildPriority, settingsRevision: preference.revision }
      await sql.query(`insert into job_computer_selections
        (execution_id,workspace_id,definition_version_id,attempt_id,operation_id,host_key,spec,limits,selection,source_scope,source_bytes)
        values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11)`,
      [identity.executionId, definition.workspaceId, definition.versionId, identity.attemptId, identity.operationId,
        hostKey, JSON.stringify(candidate.spec), JSON.stringify(jobRuntimeProfileLimits(candidate.profile)), JSON.stringify(selection),
        candidate.sourceReservation.scopeId, candidate.sourceReservation.reservedBytes])
      return { spec: candidate.spec, compatibleTargetCount, reasons: [], diagnosticCodes: [], waitingHosts: [],
        selectedHost: hostKey, exceedsMaximum: false }
    }
    const diagnosticCodes = [...new Set(reasons.length ? reasons : ['setup_required'])]
    const authorizedCandidate = enrolled.some(candidate =>
      !candidate.reasons.some(code => jobEligibilityReason(code) === 'authorization_revoked'))
    const normalized = diagnosticCodes.map(jobEligibilityReason)
      .filter(reason => reason !== 'request_exceeds_maximum' || exceedsMaximum)
      .filter(reason => reason !== 'authorization_revoked' || !isAutoJobSpecRecord(request) || !authorizedCandidate)
    return { spec: null, compatibleTargetCount, diagnosticCodes, waitingHosts: [...new Set(waitingHosts)],
      selectedHost: null, exceedsMaximum, reasons: [...new Set(normalized)] }
  }
  private async candidates(sql: JobSql, principal: ManagementPrincipal, workspaceId: string,
    request: JobDefinitionSpecRecord, placementOverride?: JobPlacementIntent | null,
    options: { queued?: boolean; lockEnrollment?: boolean } = {}) {
    const discovery = await this.inventory.candidates(sql, principal, workspaceId, request,
      placementOverride ?? undefined, options)
    const enrolled: EnrolledCandidate[] = []
    const reasons: string[] = [...discovery.diagnosticCodes]
    const candidates = discovery.candidates.filter(candidate => {
      const incompatible = !compatibleJobComputer(candidate, request)
        || (placementOverride?.kind === 'explicit'
          && canonicalJson(placedRoot(candidate.spec.target)) !== canonicalJson(placedRoot(placementOverride.target)))
      if (incompatible) reasons.push('incompatible')
      return !incompatible
    })
    const targets = candidates.map(candidate => buildComputerTarget(candidate.spec.target))
    const preferences = await this.settings.preferences(sql, targets)
    // Enrollment locks follow build order and precede capacity/source locks.
    const disabledHosts = await disabledCiEnrollmentHosts(sql, workspaceId, targets,
      { lock: options.lockEnrollment ?? false })
    for (const [index, candidate] of candidates.entries()) {
      const preference = preferences[index]!
      if (disabledHosts.has(buildComputerKey(preference.target))) {
        reasons.push('disabled')
        continue
      }
      enrolled.push({ ...candidate, preference })
    }
    const readyHosts = new Set(enrolled.filter(candidate => candidate.ready)
      .map(candidate => buildComputerKey(candidate.preference.target)))
    const placementCandidates = enrolled.filter(candidate => candidate.ready
      || !readyHosts.has(buildComputerKey(candidate.preference.target)))
    for (const candidate of placementCandidates) {
      if (!candidate.preference.buildEnabled) reasons.push('disabled')
      reasons.push(...candidate.reasons)
    }
    return { enrolled, placementCandidates, reasons }
  }

  async validateRequest(sql: JobSql, principal: ManagementPrincipal, workspaceId: string,
    request: JobDefinitionSpecRecord, placementOverride?: JobPlacementIntent) {
    const { enrolled, placementCandidates, reasons } = await this.candidates(sql, principal, workspaceId,
      request, placementOverride)
    for (const candidate of orderForPlacement(placementCandidates, placementOverride)) {
      try {
        this.workerExecution.requireEnabled(candidate.spec.target.hostRef)
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'WORKER_EXECUTION_DISABLED') throw error
        reasons.push('remote_execution_disabled')
        continue
      }
      if (!this.fitsEmptyComputer(candidate)) {
        reasons.push('request_exceeds_maximum')
        continue
      }
      const capacity = await this.fits(sql, candidate)
      if (capacity.fits) return { valid: true, canQueue: true, reasons: [], sideEffects: false as const }
      reasons.push(capacity.reason)
    }
    const configuredCandidate = placementCandidates.some(candidate => candidate.reasons.every(jobCanWait))
    const canQueue = (configuredCandidate || reasons.every(jobCanWait)) && !this.exceedsMaximum(enrolled)
    return { valid: false, canQueue,
      reasons: [...new Set(reasons.length ? reasons : ['setup_required'])], sideEffects: false as const }
  }

  private exceedsMaximum(candidates: EnrolledCandidate[]): boolean {
    return candidates.length > 0 && !candidates.some(candidate => this.fitsEmptyComputer(candidate))
      && candidates.every(candidate => candidate.profile.schemaVersion !== 2 || candidate.profile.measurement !== null)
  }

  private fitsEmptyComputer(candidate: EnrolledCandidate): boolean {
    const capacity = jobComputerCapacity(candidate.profile, candidate.preference.buildAllowancePercent)
    const sourceBytes = candidate.profile.schemaVersion === 2
      ? verificationSourceStorageBytes(candidate.profile) : SOURCE_AGGREGATE_LIMITS.bytes
    if (candidate.sourceReservation.reservedBytes > sourceBytes) return false
    return (Object.keys(capacity) as (keyof typeof capacity)[])
      .every(field => jobRuntimeProfileLimits(candidate.profile)[field] <= capacity[field])
  }
  private async fits(sql: JobSql, candidate: EnrolledCandidate): Promise<JobComputerCapacityDecision> {
    const storage = (await sql.query<{ bytes: string; verification_bytes: string; materializations: string;
      verification_materializations: string; pending_bytes: string; preparing: string;
      capacity: SourceStorageCapacity | null }>(`select
      (select r.record->'storageCapacity' from source_storage_reservations r
        where r.scope_id=$1 and r.record ? 'storageCapacity'
        order by (r.record #>> '{storageCapacity,observedAt}')::timestamptz desc limit 1) as capacity,
      coalesce(sum(bytes) filter(where not verification),0)::text as bytes,
      coalesce(sum(bytes) filter(where verification),0)::text as verification_bytes,
      coalesce(sum(materializations) filter(where not verification),0)::text as materializations,
      coalesce(sum(materializations) filter(where verification),0)::text as verification_materializations,
      coalesce(sum(pending_bytes),0)::text as pending_bytes,
      coalesce(sum(preparing),0)::text as preparing from (
        select r.reserved_bytes as bytes,case when r.owner_kind='materialization' and r.state in ('preparing','owned','uncertain')
          then 1 else 0 end as materializations,exists(select 1 from job_computer_selections owner
            where r.owner_kind='materialization' and owner.operation_id=r.owner_id and owner.spec ? 'verification') as verification,
          case when r.state in ('preparing','owned','uncertain') then r.reserved_bytes else 0 end as pending_bytes,
          case when r.state='preparing' then 1 else 0 end as preparing
          from source_storage_reservations r where r.scope_id=$1 and r.state<>'reclaimed'
        union all select source_bytes,1,s.spec ? 'verification',source_bytes,1 from job_computer_selections s
          where s.source_scope=$1 and s.released_at is null
          and not exists(select 1 from source_storage_reservations r where r.owner_kind='materialization' and r.owner_id=s.operation_id)
      ) usage`, [candidate.sourceReservation.scopeId])).rows[0]!
    const capacity = storage.capacity ? SourceStorageCapacitySchema.parse(storage.capacity) : null
    const age = capacity ? Date.now() - Date.parse(capacity.observedAt) : null
    // Placement may defer using a recent host reading; reservation still measures its allocated host again.
    const limits = capacity && age !== null && age >= -1000 && age <= 10_000
      ? sourceStorageLimits(capacity) : null
    let sourceSlots: number = limits?.materializations ?? SOURCE_AGGREGATE_LIMITS.materializations
    if (candidate.profile.schemaVersion === 2) {
      sourceSlots = candidate.profile.root.selection.hostRef.kind === 'main'
        ? JOB_VERIFICATION_OWNER_CONFIGURATION.mainConcurrentJobs : JOB_VERIFICATION_OWNER_CONFIGURATION.laptopConcurrentJobs
    }
    const sourceBytes = candidate.profile.schemaVersion === 2
      ? verificationSourceStorageBytes(candidate.profile) : limits?.bytes ?? SOURCE_AGGREGATE_LIMITS.bytes
    const usedBytes = candidate.profile.schemaVersion === 2 ? Number(storage.verification_bytes) : Number(storage.bytes)
    const usedSlots = candidate.profile.schemaVersion === 2
      ? Number(storage.verification_materializations) : Number(storage.materializations)
    const hostStorageFull = limits !== null
      && (Number(storage.pending_bytes) + candidate.sourceReservation.reservedBytes > limits.availableBytes
        || Number(storage.preparing) >= limits.preparing)
    if (usedBytes + candidate.sourceReservation.reservedBytes > sourceBytes
      || usedSlots >= sourceSlots || hostStorageFull) return { fits: false, reason: 'busy' }
    return jobComputerCapacityDecision(sql, candidate.spec.target, candidate.profile, this.availableMemory,
      candidate.preference.buildAllowancePercent)
  }

  async prepare(sql: JobSql, definition: JobDefinitionRecord, identity: JobPreparationIdentity): Promise<ResolvedJobDefinitionSpecRecord> {
    const spec = await readJobComputerSelection(sql, definition, identity)
    this.workerExecution.requireEnabled(spec.target.hostRef)
    await this.assertBundleReady?.(spec.target.hostRef)
    await this.settings.requireEnabled(sql, buildComputerTarget(spec.target))
    const row = (await sql.query<{ released_at: Date | null }>(
      'select released_at from job_computer_selections where execution_id=$1', [identity.executionId])).rows[0]
    if (!row || row.released_at) throw new DomainError('JOB_PREPARATION_CLOSED', 'This preparation was closed; create a new Start command.', 409)
    return spec
  }
  async selection(sql: JobSql, identity: JobPreparationIdentity): Promise<PreparedJobSpecRecord['computerSelection']> {
    const row = (await sql.query<{ selection: unknown }>(
      'select selection from job_computer_selections where execution_id=$1 and attempt_id=$2 and operation_id=$3',
      [identity.executionId, identity.attemptId, identity.operationId])).rows[0]
    return row ? JobComputerSelectionSchema.parse(row.selection) : undefined
  }
  async validateFixed(sql: JobSql, spec: ResolvedJobDefinitionSpecRecord) {
    try {
      this.workerExecution.requireEnabled(spec.target.hostRef)
      await this.assertBundleReady?.(spec.target.hostRef)
      await this.settings.requireEnabled(sql, buildComputerTarget(spec.target))
      return { valid: true, reasons: [], sideEffects: false as const }
    } catch (error) {
      if (!(error instanceof DomainError)
        || !['BUILD_COMPUTER_DISABLED', 'WORKER_EXECUTION_DISABLED'].includes(error.code)) throw error
      return { valid: false, reasons: [error.message], sideEffects: false as const }
    }
  }
}

export async function jobComputerHasCapacity(sql: JobSql,
  target: Pick<ResolvedJobDefinitionSpecRecord['target'], 'mainId' | 'hostRef'>, profile: JobRuntimeProfileRecord,
  availableMemory?: VerificationMemoryReader): Promise<boolean> {
  return (await jobComputerCapacityDecision(sql, target, profile, availableMemory)).fits
}

export async function jobComputerCapacityDecision(sql: JobSql,
  target: Pick<ResolvedJobDefinitionSpecRecord['target'], 'mainId' | 'hostRef'>, profile: JobRuntimeProfileRecord,
  availableMemory?: VerificationMemoryReader, allowancePercent = 100): Promise<JobComputerCapacityDecision> {
  const hostKey = buildComputerKey({ hostRef: target.hostRef })
  const rows = (await sql.query<{ limits: JobRuntimeProfile['limits']; compute_closed: boolean; inodes?: number }>(`select s.limits,
    coalesce(p.record #>> '{spec,resources,mutableInodes}','0')::bigint as inodes,
    exists(select 1 from job_executions e where e.id=s.execution_id
      and e.record #>> '{process,phase}'='terminal' and e.record #> '{process,processStopped}'='true'::jsonb) as compute_closed
    from job_computer_selections s
    join job_runtime_profile_versions p on p.profile_id=s.spec #>> '{policy,isolationPolicyId}'
      and p.revision=(s.spec #>> '{policy,isolationPolicyRevision}')::bigint
    where host_key=$1 and released_at is null and not ${closedJobComputerSql}
    union all select coalesce(p.record->'limits',p.record #> '{spec,resources,limits}') as limits,
      coalesce(p.record #>> '{spec,resources,mutableInodes}','0')::bigint as inodes,
      (e.record #>> '{process,phase}'='terminal' and e.record #> '{process,processStopped}'='true'::jsonb) as compute_closed
    from job_executions e
    join job_runtime_profile_versions p on p.profile_id=e.accepted_spec #>> '{policy,isolationPolicyId}'
      and p.revision=(e.accepted_spec #>> '{policy,isolationPolicyRevision}')::bigint
    where not exists(select 1 from job_computer_selections s where s.execution_id=e.id)
      and e.accepted_spec #>> '{target,hostRef,mainId}'=$2
      and coalesce(e.accepted_spec #>> '{target,hostRef,deviceId}','main')=$3
      and not ${closedJobExecutionSql}
    union all select s.limits,
      coalesce(p.record #>> '{spec,resources,mutableInodes}','0')::bigint as inodes, true as compute_closed
    from job_computer_selections s
    join job_runtime_profile_versions p on p.profile_id=s.spec #>> '{policy,isolationPolicyId}'
      and p.revision=(s.spec #>> '{policy,isolationPolicyRevision}')::bigint
    join source_storage_reservations r on r.owner_kind='materialization' and r.owner_id=s.operation_id
    join source_execution_materializations m on m.operation_id=s.operation_id
    where s.host_key=$1 and s.released_at is not null and r.state<>'reclaimed'
      and m.record #> '{receipt,quota}' is not null`,
  [hostKey, target.mainId,
    target.hostRef.kind === 'device' ? target.hostRef.deviceId : 'main'])).rows
  const capacity = jobComputerCapacity(profile, allowancePercent)
  if ((Object.keys(capacity) as (keyof typeof capacity)[])
    .some(field => jobRuntimeProfileLimits(profile)[field] > capacity[field])) {
    return { fits: false, reason: 'request_exceeds_maximum' }
  }
  const computing = rows.filter(row => !row.compute_closed)
  let slots = 1
  if (profile.schemaVersion === 2) {
    const approved = target.hostRef.kind === 'main' ? JOB_VERIFICATION_OWNER_CONFIGURATION.mainConcurrentJobs
      : JOB_VERIFICATION_OWNER_CONFIGURATION.laptopConcurrentJobs
    const measured = profile.measurement?.suites.map(suite => suite.maxConcurrentHeavyJobs) ?? []
    const pool = profile.measurement?.fingerprint.quotaPool
    slots = measured.length && pool ? Math.min(approved, pool.slots.length, ...measured) : 0
    if (!pool || rows.length >= pool.slots.length
      || rows.reduce((total, row) => total + Number(row.inodes ?? profile.spec.resources.mutableInodes),
        profile.spec.resources.mutableInodes) > pool.slots.reduce((total, slot) => total + slot.hardInodes, 0)) {
      return { fits: false, reason: 'busy' }
    }
    if (target.hostRef.kind === 'device') {
      const bytes = await availableMemory?.(profile)
      if (bytes === null || bytes === undefined) return { fits: false, reason: 'memory_unavailable' }
      const minimum = JOB_VERIFICATION_OWNER_CONFIGURATION.laptopMinimumAvailableBytes
        + JOB_VERIFICATION_OWNER_CONFIGURATION.laptopPerRunningJobBytes * (computing.length + 1)
      if (bytes < minimum) return { fits: false, reason: 'memory_headroom_required' }
    }
  }
  if (computing.length >= slots) return { fits: false, reason: 'busy' }
  const fits = (Object.keys(capacity) as (keyof typeof capacity)[]).every(field =>
    (field === 'diskBytes' ? rows : computing).reduce((total, row) => total + row.limits[field],
      jobRuntimeProfileLimits(profile)[field]) <= capacity[field])
  return fits ? { fits: true } : { fits: false, reason: 'busy' }
}

export async function releaseUnstartedJobComputer(sql: JobSql, identity: JobPreparationIdentity): Promise<void> {
  await sql.query(`update job_computer_selections s set released_at=clock_timestamp()
    where execution_id=$1 and attempt_id=$2 and operation_id=$3 and released_at is null
      and not exists(select 1 from job_executions e where e.id=s.execution_id)
      and not exists(select 1 from source_storage_reservations r where r.owner_kind='materialization' and r.owner_id=s.operation_id)
      and not exists(select 1 from source_execution_materializations m where m.operation_id=s.operation_id)`,
  [identity.executionId, identity.attemptId, identity.operationId])
}
