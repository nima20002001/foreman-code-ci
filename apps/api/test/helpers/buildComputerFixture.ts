import { sourceStorageCapacityFixture } from './sourceStorageCapacityFixture.js'
import { randomUUID } from 'node:crypto'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { JobRuntimeProfileSchema, type JobRuntimeProfile } from '@foreman-code/contracts/job-runtime'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { JobDefinitionSchema, AutoJobDefinitionSpecSchema, jobPolicyRequirements, isAutoJobSpec } from '@foreman-code/contracts/jobs'
import type { JobComputerCandidate } from '../../src/modules/jobs/computerSelection.js'
import { buildComputerTarget } from '../../src/modules/settings/buildComputers.js'
import { jobSpec } from './jobFixture.js'
import type pg from 'pg'
import { vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { JobSql } from '../../src/modules/jobs/repository.js'
import type { ResolvedJobDefinitionSpec } from '@foreman-code/contracts/jobs'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { BuildComputerSettings } from '../../src/modules/settings/buildComputers.js'
import { WorkerExecutionPolicy } from '../../src/modules/settings/workerExecution.js'
import { JobComputerSelection, releaseClosedJobComputers } from '../../src/modules/jobs/computerSelection.js'
import { PostgresSourceReservations } from '../../src/modules/sources/reservations.js'
import { JobService } from '../../src/modules/jobs/service.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { JobWorkerService } from '../../src/modules/jobs/worker.js'
import type { JobQueueConfiguration } from '../../src/modules/jobs/ports.js'

export function buildQueueConfigurationFixture(principal: ManagementPrincipal,
  limits: JobRuntimeProfile['limits']): JobQueueConfiguration {
  return { revision: 1,
    review: { reviewedByPrincipalId: principal.id, reviewedAt: new Date().toISOString(), decisionDigest: '1'.repeat(64) },
    limits: { maxPendingPerPrincipal: 20, maxPendingPerWorkspace: 40, maxBackfillClaims: 0 },
    resources: async () => ({ schemaVersion: 1, limits,
      mutableInodes: 100, controlTempBytes: 1024, scratchBytes: 1048576, scratchExecutable: false,
      shmBytes: 1024, spoolBytes: 4096, reportBytes: 4096 }),
  }
}

// Runtime readiness is an inventory fixture; these tests make no physical qualification claim.
export function buildComputerFixture(mainId: string, workspaceId: string, deviceId: string = randomUUID()) {
  const spec = jobSpec()
  const registration = DeviceRegistrationSchema.parse({ mainId, deviceId, workerInstallationId: randomUUID(),
    publicKeyFingerprint: '1'.repeat(64), keyRevision: 1, authorizationRevision: 1,
    status: 'paired', scopes: ['connect', 'heartbeat'] })
  const rootId = randomUUID()
  spec.target = { ...spec.target, mainId, mainInstallationId: mainId,
    hostRef: { kind: 'device', mainId, deviceId },
    registration: { workerInstallationId: registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    destination: { ...spec.target.destination, rootPolicyId: rootId, attestationId: randomUUID() } }
  spec.policy = { ...spec.policy, isolationPolicyId: randomUUID() }
  const root = SourceRootRecordSchema.parse({ version: 1,
    source: { approvedSourceId: spec.source.approvedSourceId, snapshotId: spec.source.snapshotId,
      manifestDigest: spec.source.manifestDigest },
    selection: { hostRef: spec.target.hostRef, rootPolicyId: rootId, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId, deviceId, workerInstallationId: registration.workerInstallationId,
      workspaceId, rootId, bindingRevision: 1, locationRevision: 1, canonicalPath: spec.target.destination.canonicalProjectRoot,
      filesystem: { device: '1', inode: '2', mountId: '3' }, accessMode: 'exclusive-write',
      snapshotId: spec.source.snapshotId, manifestDigest: spec.source.manifestDigest },
    ownerPrincipalId: 'fixture', authorizedByPrincipalId: 'fixture', registration: spec.target.registration,
    attestationId: spec.target.destination.attestationId, attestationDigest: spec.target.destination.attestationHash,
    boundAt: '2026-10-01T00:00:00.000Z' })
  const profile = JobRuntimeProfileSchema.parse({ schemaVersion: 1, id: spec.policy.isolationPolicyId,
    revision: 1, workspaceId, name: 'Fixture runtime', root, policy: spec.policy,
    limits: { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 32, diskBytes: 8388608 },
    specDigest: '1'.repeat(64), status: 'unqualified', measurement: null,
    createdAt: root.boundAt, updatedAt: root.boundAt })
  const candidate: JobComputerCandidate & { spec: ResolvedJobDefinitionSpec; profile: JobRuntimeProfile } = { spec, profile, ready: true, reasons: [],
    sourceReservation: { scopeId: `${mainId}:${deviceId}:${registration.workerInstallationId}:1:3`, reservedBytes: 2097152 } }
  const auto = AutoJobDefinitionSpecSchema.parse({ ...spec, target: { kind: 'auto' },
    policy: jobPolicyRequirements(spec.policy), limits: profile.limits })
  return { registration, candidate, auto, target: buildComputerTarget(spec.target) }
}

/** PostgreSQL queue behavior with trusted runtime/source events supplied by the fixture. */
export async function buildQueueFixture(pool: pg.Pool, principal: ManagementPrincipal, options: {
  computerCount?: number; maxBackfillClaims?: number; maxPendingPerPrincipal?: number; clock?: () => Date
  workspaceId?: string; mainComputer?: boolean; settingsPrincipal?: ManagementPrincipal
} = {}) {
  const workspaceId = options.workspaceId ?? randomUUID()
  const mainId = (await pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
  if (!options.workspaceId) await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [workspaceId, JSON.stringify({ id: workspaceId, name: 'Queued builds' })])
  const source = { ...jobSpec().source, approvedSourceId: randomUUID(), snapshotId: randomUUID() }
  const computers = Array.from({ length: options.computerCount ?? 1 }, () => buildComputerFixture(mainId, workspaceId))
  await pool.query(`insert into source_approvals
    (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
    values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
  [source.approvedSourceId, source.snapshotId, workspaceId, principal.id, randomUUID(), '1'.repeat(64)])
  await pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
    values($1,$2,$3,$4,'{}')`, [source.snapshotId, source.approvedSourceId, workspaceId, source.manifestDigest])
  const commands = new PostgresCommandCoordinator(pool)
  const settings = new BuildComputerSettings(pool, commands, async () => ({
    state: 'ready', reasons: [], remoteExecutionEnabled: true,
  }))
  for (const computer of computers) {
    if (options.mainComputer) {
      const target = { ...computer.candidate.spec.target, hostRef: { kind: 'main' as const, mainId }, registration: null }
      computer.candidate.spec.target = target
      computer.target = buildComputerTarget(target)
      computer.candidate.sourceReservation.scopeId = `${mainId}:main:main:1:3`
      computer.candidate.profile.root = SourceRootRecordSchema.parse({ ...computer.candidate.profile.root,
        selection: { ...computer.candidate.profile.root.selection, hostRef: target.hostRef },
        binding: { ...computer.candidate.profile.root.binding, deviceId: null, workerInstallationId: null },
        registration: null })
    }
    computer.candidate.spec.source = source
    computer.auto.source = source
    computer.candidate.profile.root = SourceRootRecordSchema.parse({ ...computer.candidate.profile.root,
      source: { approvedSourceId: source.approvedSourceId, snapshotId: source.snapshotId, manifestDigest: source.manifestDigest },
      binding: { ...computer.candidate.profile.root.binding, snapshotId: source.snapshotId } })
    computer.candidate.ready = false
    computer.candidate.reasons = ['offline']
    const root = computer.candidate.profile.root
    await pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$3,'fixture',$4::jsonb)`, [computer.registration.deviceId, mainId,
      computer.registration.workerInstallationId, JSON.stringify(computer.registration)])
    await pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
      values($1,$2,$3,1)`, [root.binding.rootId, workspaceId, randomUUID()])
    await pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
      values($1,1,$2,$3,$4::jsonb)`, [root.binding.rootId, workspaceId, source.snapshotId, JSON.stringify(root)])
    await pool.query(`insert into job_runtime_profiles(id,workspace_id,revision,root_id,binding_revision,record)
      values($1,$2,1,$3,1,$4::jsonb)`, [computer.candidate.profile.id, workspaceId,
      root.binding.rootId, JSON.stringify(computer.candidate.profile)])
    await pool.query('insert into job_runtime_profile_versions(profile_id,revision,record) values($1,1,$2::jsonb)',
      [computer.candidate.profile.id, JSON.stringify(computer.candidate.profile)])
    await settings.update(options.settingsPrincipal ?? principal, 'http', { target: computer.target, commandId: randomUUID(),
      expectedRevision: 0, buildEnabled: true, buildPriority: 100 })
  }
  const inventory = { candidates: vi.fn(async (_sql: JobSql, _principal: ManagementPrincipal,
    _workspaceId: string, spec: import('@foreman-code/contracts/jobs').JobDefinitionSpec) => ({ candidates: computers.map(computer => ({
      ...computer.candidate, spec: { ...computer.candidate.spec, argv: spec.argv },
    })).filter(candidate => isAutoJobSpec(spec) || canonicalJson(candidate.spec.target) === canonicalJson(spec.target)),
    diagnosticCodes: [] })) }
  const workerExecution = new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' })
  const placement = new JobComputerSelection(settings, inventory, workerExecution)
  const reservations = new PostgresSourceReservations(async () => sourceStorageCapacityFixture({
    totalBytes: 256 * 2 ** 30, availableBytes: 256 * 2 ** 30,
  }))
  const accept = vi.fn(async (_sql: JobSql, _principal: ManagementPrincipal, _workspace: string,
    spec: ResolvedJobDefinitionSpec, identity: { executionId: string; attemptId: string; operationId: string }) => {
    const computer = computers.find(computer => computer.candidate.spec.policy.isolationPolicyId === spec.policy.isolationPolicyId)!
    const materializationId = randomUUID()
    const sql = await pool.connect()
    try {
      await sql.query('begin')
      const reservation = await reservations.reserve(sql, { ...computer.candidate.sourceReservation,
        ownerKind: 'materialization', ownerId: identity.operationId })
      await reservations.retain(sql, reservation, 'owned')
      await sql.query(`insert into source_execution_materializations
        (materialization_id,workspace_id,execution_id,attempt_id,operation_id,root_id,binding_revision,reservation_id,record,state)
        values($1,$2,$3,$4,$5,$6,1,$7,'{}','prepared') on conflict(execution_id,attempt_id) do nothing`,
      [materializationId, workspaceId, identity.executionId, identity.attemptId, identity.operationId,
        computer.candidate.profile.root.binding.rootId, reservation.reservationId])
      const original = (await sql.query<{ materialization_id: string }>(
        'select materialization_id from source_execution_materializations where operation_id=$1', [identity.operationId])).rows[0]!
      await sql.query('commit')
      return { ...spec, source: { ...spec.source, materializationId: original.materialization_id,
        materializationDigest: '1'.repeat(64) } }
    } catch (error) {
      await sql.query('rollback')
      throw error
    } finally { sql.release() }
  })
  const wake = vi.fn(async () => {})
  const cancel = vi.fn(async () => {})
  const queue: JobQueueConfiguration = { revision: 1,
    review: { reviewedByPrincipalId: principal.id, reviewedAt: new Date().toISOString(), decisionDigest: '1'.repeat(64) },
    limits: { maxPendingPerPrincipal: options.maxPendingPerPrincipal ?? 20, maxPendingPerWorkspace: 40,
      maxBackfillClaims: options.maxBackfillClaims ?? 0 },
    resources: async () => ({ schemaVersion: 1, limits: computers[0]!.candidate.profile.limits,
      mutableInodes: 100, controlTempBytes: 1024, scratchBytes: 1048576, scratchExecutable: false,
      shmBytes: 1024, spoolBytes: 4096, reportBytes: 4096 }),
  }
  const ports = { placement, workerExecution, queue,
    preparation: { accept, choices: async () => ({ targets: [], sources: [], policies: [] }),
      validate: async () => ({ valid: true, reasons: [], sideEffects: false as const }),
      revalidateAccepted: async () => {}, adoptFinalBinding: async () => {} },
    dispatch: { accept: async (_sql: JobSql, input: { operationId: string; attemptId: string }) => ({
      operationId: input.operationId, attemptId: input.attemptId, owner: { grantId: randomUUID(), epoch: '1' } }),
    wake, cancel, cancelForRunCleanup: async () => { throw new Error('No Run cleanup in the queue fixture') } },
    artifacts: { list: async () => [], read: async () => { throw new Error('No physical artifact fixture') } },
  }
  const createService = () => new JobService(pool, commands, ports, options.clock)
  const jobs = createService()
  const worker = new JobWorkerService(pool, { require: async () => {}, verifyPublication: async () => {} })
  async function complete(executionId: string) {
    const execution = await jobs.getExecution(principal, workspaceId, executionId)
    const fence = { attemptId: execution.attemptId, owner: execution.owner }
    if (execution.process.phase !== 'terminal') {
      await worker.settleProcess(workspaceId, executionId, fence, {
        process: { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true },
        startedAt: execution.createdAt, finishedAt: new Date().toISOString(),
      })
    }
    if (execution.publication !== 'complete') {
      await worker.publication(workspaceId, executionId, fence, { state: 'complete', issue: null })
    }
    await pool.query("update source_execution_materializations set state='closed' where execution_id=$1", [executionId])
    const reservation = (await pool.query<{ record: import('../../src/modules/sources/reservations.js').SourceReservation }>(
      "select record from source_storage_reservations where owner_kind='materialization' and owner_id=$1",
      [execution.operationId])).rows[0]!.record
    await reservations.reclaimed(pool, reservation, async () => true)
    await releaseClosedJobComputers(pool)
  }
  async function save(spec: import('@foreman-code/contracts/jobs').JobDefinitionSpec = computers[0]!.auto) {
    return JobDefinitionSchema.parse(await jobs.saveDefinition(principal, 'http', workspaceId, {
      commandId: randomUUID(), expectedRevision: null, name: 'Queued build', spec }))
  }
  function online(index = 0) {
    computers[index]!.candidate.ready = true
    computers[index]!.candidate.reasons = []
  }
  return { principal, workspaceId, computers, settings, commands, jobs, createService, accept, wake, cancel,
    inventory, worker, complete, save, online, queue }
}
