import { sourceStorageCapacityFixture } from './sourceStorageCapacityFixture.js'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { ApprovedSourceSchema, SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { JobDefinitionSchema, JobExecutionSchema, AcceptedJobSpecSchema } from '@foreman-code/contracts/jobs'
import { jobSpecDigests } from '@foreman-code/contracts/jobs-node'
import { ApprovedRootAllowlistSchema, WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { buildComputerFixture } from './buildComputerFixture.js'
import { jobRuntimeMetadataFixture } from './jobRuntimeMetadataFixture.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { PostgresJobDispatch } from '../../src/modules/jobs/dispatch.js'
import { WorkerExecutionPolicy } from '../../src/modules/settings/workerExecution.js'
import { createProductionSources } from '../../src/modules/sources/production.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { PrivateSourceMaterializer } from '../../src/modules/sources/materialization.js'
import { createSourceManifest, sourceSha256 } from '../../src/modules/sources/manifest.js'
import { identity, openPrivateRoot } from '../../src/modules/sources/privateFilesystem.js'
import { sourceBindingHash, sourceMaterializationDigest } from '../../src/modules/sources/bindingHash.js'
import { verifiedSourceWorkingTree } from '../../src/modules/sources/nativeStamp.js'
import { PostgresSourceReservations } from '../../src/modules/sources/reservations.js'

/** Seeds accepted facts and a physical source claim; production owns all later closure and control. */
export async function retainedJobFixture(pool: pg.Pool, directory: string, principal: ManagementPrincipal,
  options: { workspaceId?: string } = {}) {
  const mainId = (await pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
  const workspaceId = options.workspaceId ?? randomUUID()
  if (!options.workspaceId) {
    await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Retained build' })])
  }
  const computer = buildComputerFixture(mainId, workspaceId)
  const runtimeRoot = join(directory, randomUUID())
  const root = computer.candidate.profile.root
  root.selection.hostRef = { kind: 'main', mainId }
  root.registration = null
  root.binding.deviceId = null
  root.binding.workerInstallationId = null
  root.binding.canonicalPath = join(runtimeRoot, 'source-materializations', root.selection.rootPolicyId)
  root.ownerPrincipalId = principal.id
  root.authorizedByPrincipalId = principal.id
  await mkdir(root.binding.canonicalPath, { mode: 0o700, recursive: true })
  const handle = await openPrivateRoot(root.binding.canonicalPath)
  try { root.binding.filesystem = await identity(handle) } finally { await handle.close() }
  const bytes = Buffer.from('export const retained = true\n')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip',
    git: { commit: '2'.repeat(40), tree: '3'.repeat(40), objectFormat: 'sha1' },
    entries: [{ path: 'app.mjs', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }],
    deletions: [] })
  root.source = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest }
  root.binding.snapshotId = manifest.snapshotId
  root.binding.manifestDigest = manifest.manifestDigest
  const spec = computer.candidate.spec
  spec.source = { ...root.source, commit: manifest.git!.commit }
  spec.target = { ...spec.target, hostRef: root.selection.hostRef, registration: null,
    destination: { ...spec.target.destination, canonicalProjectRoot: root.binding.canonicalPath,
      canonicalCwd: root.binding.canonicalPath, managedRuntimeRoot: runtimeRoot,
      directoryIdentityHash: sourceSha256(Buffer.from(JSON.stringify(root.binding.filesystem))) } }
  const retained = jobRuntimeMetadataFixture({ ...computer.candidate.profile, root, policy: spec.policy }, randomUUID())
  const profile = retained.profile
  const now = new Date().toISOString()
  const definition = JobDefinitionSchema.parse({ schemaVersion: 1, id: randomUUID(), workspaceId,
    versionId: randomUUID(), revision: 1, name: 'Retained build', spec, createdAt: now, updatedAt: now })
  await pool.query(`insert into job_definitions(id,workspace_id,revision,version_id,record,updated_by)
    values($1,$2,1,$3,$4::jsonb,$5)`,
  [definition.id, workspaceId, definition.versionId, JSON.stringify(definition), principal.id])
  await pool.query(`insert into job_definition_versions(id,definition_id,workspace_id,revision,record)
    values($1,$2,$3,1,$4::jsonb)`, [definition.versionId, definition.id, workspaceId, JSON.stringify(definition)])
  await pool.query(`insert into source_approvals
    (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
    values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
  [manifest.approvedSourceId, manifest.snapshotId, workspaceId, principal.id, randomUUID(), '1'.repeat(64)])
  const source = ApprovedSourceSchema.parse({ version: 1, workspaceId, ownerPrincipalId: principal.id,
    approvedByPrincipalId: principal.id, locationRevision: 1, mainId, originIdentityHash: `sha256:${'1'.repeat(64)}`,
    manifest, approvedAt: now, availability: 'retained' })
  await pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
    values($1,$2,$3,$4,$5::jsonb)`,
  [manifest.snapshotId, manifest.approvedSourceId, workspaceId, manifest.manifestDigest, JSON.stringify(source)])
  await pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
    values($1,$2,$3,1)`, [root.binding.rootId, workspaceId, randomUUID()])
  await pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
    values($1,1,$2,$3,$4::jsonb)`, [root.binding.rootId, workspaceId, manifest.snapshotId, JSON.stringify(root)])
  await pool.query(`insert into job_runtime_profiles(id,workspace_id,revision,root_id,binding_revision,record)
    values($1,$2,1,$3,1,$4::jsonb)`, [profile.id, workspaceId, root.binding.rootId, JSON.stringify(profile)])
  await pool.query('insert into job_runtime_profile_versions(profile_id,revision,record) values($1,1,$2::jsonb)',
    [profile.id, JSON.stringify(profile)])
  const measurement = profile.measurement!
  const approval = { schemaVersion: 1, id: measurement.approvalId, qualificationId: measurement.qualificationId,
    workspaceId, profileId: profile.id, profileRevision: 1, fingerprint: retained.fingerprint,
    fingerprintDigest: measurement.fingerprintDigest, requestedByPrincipalId: principal.id,
    status: 'complete', approvedByPrincipalId: principal.id, approvedAt: measurement.checkedAt, expiresAt: measurement.expiresAt }
  await pool.query(`insert into job_runtime_qualification_approvals
    (id,qualification_id,profile_id,profile_revision,workspace_id,record,measurement,requested_by,approved_by)
    values($1,$2,$3,1,$4,$5::jsonb,$6::jsonb,$7,$7)`, [approval.id, approval.qualificationId, profile.id,
    workspaceId, JSON.stringify(approval), JSON.stringify(measurement), principal.id])
  const commands = new PostgresCommandCoordinator(pool)
  const locations = new WorkspaceLocationService(pool, commands)
  const noCarrier = (): never => { throw new Error('This Main fixture has no Worker carrier') }
  const sourceRuntime = await createProductionSources({ pool, commands, locations, mainId, runtimeRoot,
    endpoint: noCarrier, dispatch: noCarrier })
  const head = (await pool.query<{ configuration_revision: string }>(
    'select configuration_revision from workspace_root_host_configuration_heads where host_scope=$1',
    [`main:${mainId}`])).rows[0]
  const configurationRevision = String(BigInt(head?.configuration_revision ?? '0') + 1n)
  const configuration = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef: root.selection.hostRef,
    applicationInstallationId: mainId, configurationRevision,
    bases: [{ baseId: root.binding.rootId, canonicalPath: runtimeRoot,
      filesystem: root.binding.filesystem, accessModes: ['read-write'] }],
    managedRuntimeRoot: runtimeRoot, runtimeFilesystem: root.binding.filesystem })
  await sourceRuntime.policies.publishApprovedHostConfiguration(pool, configuration, {
    mainId, hostRef: root.selection.hostRef, applicationInstallationId: mainId, configurationRevision,
    configurationDigest: sourceSha256(Buffer.from(JSON.stringify(configuration))) })
  const policy = WorkspaceRootPolicySchema.parse({ schemaVersion: 1, rootPolicyId: root.selection.rootPolicyId,
    rootPolicyRevision: '1', workspaceId, hostRef: root.selection.hostRef, applicationInstallationId: mainId,
    registration: null, locationRevision: '1', ownerPrincipalId: principal.id, allowedBaseId: root.binding.rootId,
    configurationRevision, relativePath: '', accessMode: 'read-write', canonicalProjectRoot: runtimeRoot,
    filesystem: root.binding.filesystem, directoryIdentityHash: spec.target.destination.directoryIdentityHash,
    managedRuntimeRoot: runtimeRoot, runtimeFilesystem: root.binding.filesystem,
    attestationId: root.attestationId, attestationDigest: root.attestationDigest })
  await pool.query(`insert into workspace_root_policies
    (root_policy_id,root_policy_revision,workspace_id,host_scope,location_revision,record)
    values($1,'1',$2,$3,'1',$4::jsonb)`,
  [policy.rootPolicyId, workspaceId, `main:${mainId}`, JSON.stringify(policy)])
  const executionId = randomUUID()
  const attemptId = randomUUID()
  const operationId = randomUUID()
  await pool.query(`insert into job_preparations
    (execution_id,attempt_id,operation_id,workspace_id,definition_version_id,principal_id,command_id,definition,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [executionId, attemptId, operationId, workspaceId,
    definition.versionId, principal.id, randomUUID(), JSON.stringify(definition), now])
  const attempt = { executionId, attemptId, keyRevision: null, authorizationRevision: null }
  const receipt = await new PrivateSourceMaterializer({ read: async () => bytes }, async () => {}).prepare({
    manifest, binding: root.binding, attempt: { ...attempt, placementHash: sourceBindingHash(root, attempt, operationId) } })
  const reservations = new PostgresSourceReservations(async () => sourceStorageCapacityFixture({
    totalBytes: 256 * 2 ** 30, availableBytes: 256 * 2 ** 30,
  }))
  const scopeId = `${mainId}:original-main:${mainId}:${root.binding.filesystem.device}:${root.binding.filesystem.mountId}`
  const reservation = await reservations.reserve(pool, { ownerKind: 'materialization', ownerId: operationId,
    scopeId, reservedBytes: 2097152 })
  await reservations.retain(pool, reservation, 'owned')
  const record = SourceMaterializationRecordSchema.parse({ receipt, rootPolicyId: root.selection.rootPolicyId,
    rootPolicyRevision: '1', operationId, reservationId: reservation.reservationId,
    sourceBindingHash: receipt.placementHash, finalDispatchBindingHash: null, state: 'prepared' })
  const tree = verifiedSourceWorkingTree(record, join(root.binding.canonicalPath, receipt.materializationId, 'tree'))
  const prepared = { ...spec, source: { ...spec.source, materializationId: receipt.materializationId,
    materializationDigest: sourceMaterializationDigest(record) },
    target: { ...spec.target, destination: { ...spec.target.destination,
      canonicalProjectRoot: tree.canonicalProjectRoot, canonicalCwd: tree.canonicalCwd,
      directoryIdentityHash: tree.directoryIdentityHash } } }
  const acceptedSpec = AcceptedJobSpecSchema.parse({ ...prepared, workflowInput: null, definitionId: definition.id,
    definitionVersionId: definition.versionId, definitionRevision: 1, ...jobSpecDigests(prepared, null) })
  const forbidden = async (): Promise<never> => { throw new Error('Fixture seeding cannot dispatch a Job') }
  const dispatch = new PostgresJobDispatch(pool, { deliver: forbidden, reconcile: forbidden, control: forbidden },
    { revalidate: forbidden, authorizeControl: forbidden, observe: forbidden }, new WorkerExecutionPolicy())
  const sql = await pool.connect()
  let execution: ReturnType<typeof JobExecutionSchema.parse>
  try {
    await sql.query('begin')
    const binding = await dispatch.accept(sql, { workspaceId, executionId, attemptId, operationId,
      spec: acceptedSpec, workflow: null, principal })
    execution = JobExecutionSchema.parse({ schemaVersion: 1, id: executionId, workspaceId, acceptedSpec,
      ...binding, workflow: null, process: { phase: 'queued', outcome: null, exitCode: null, signal: null, processStopped: false },
      transport: 'unknown', publication: 'pending', startedAt: null, finishedAt: null, lastSeenAt: null,
      resultIssue: null, cancelRequestedAt: null, createdAt: now, updatedAt: now })
    record.finalDispatchBindingHash = acceptedSpec.bindingHash
    await sql.query(`insert into job_executions
      (id,workspace_id,definition_version_id,operation_id,attempt_id,record,accepted_spec,accepted_by)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`, [executionId, workspaceId, definition.versionId,
      operationId, attemptId, JSON.stringify(execution), JSON.stringify(acceptedSpec), principal.id])
    await sql.query(`insert into source_execution_materializations
      (materialization_id,workspace_id,execution_id,attempt_id,operation_id,root_id,binding_revision,reservation_id,record,state)
      values($1,$2,$3,$4,$5,$6,1,$7,$8::jsonb,'prepared')`, [receipt.materializationId, workspaceId,
      executionId, attemptId, operationId, root.binding.rootId, reservation.reservationId, JSON.stringify(record)])
    await sql.query(`insert into job_computer_selections
      (execution_id,workspace_id,definition_version_id,attempt_id,operation_id,host_key,spec,limits,selection,source_scope,source_bytes)
      values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,2097152)`,
    [executionId, workspaceId, definition.versionId, attemptId, operationId, `${mainId}:main`, JSON.stringify(spec),
      JSON.stringify(profile.limits), JSON.stringify({ mode: 'fixed', buildPriority: 100, settingsRevision: 1 }), scopeId])
    await sql.query('commit')
  } catch (error) {
    await sql.query('rollback')
    throw error
  } finally { sql.release() }
  return { mainId, workspaceId, runtimeRoot, commands, locations, profile, retained, root, spec,
    definition, execution, record, sourceRuntime }
}
