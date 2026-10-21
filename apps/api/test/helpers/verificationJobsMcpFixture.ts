import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { JobRuntimeApprovalRecordSchema, JobVerificationProfileSchema, JobVerificationRuntimeMeasurementSchema,
  type JobRuntimeFingerprintRecord, type JobVerificationProfile } from '@foreman-code/contracts/job-verification-runtime'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { createJobRuntimeProfileService } from '../../src/modules/jobs/runtimeProfileFactory.js'
import { CanonicalJobPreparationSources, CanonicalJobPreparationService,
  CanonicalJobPrivateRepositories } from '../../src/modules/jobs/sourcePreparation.js'
import { createProductionJobs, createReviewedBuildQueueConfiguration } from '../../src/modules/jobs/production.js'
import { JobService, jobDigest } from '../../src/modules/jobs/service.js'
import { JobComputerSelection } from '../../src/modules/jobs/computerSelection.js'
import { WorkerExecutionPolicy } from '../../src/modules/settings/workerExecution.js'
import type { DeviceEndpoint } from '../../src/modules/devices/deviceEndpoint.js'
import { currentDatabase } from './eng04CurrentDatabase.js'
import { retainedJobFixture } from './retainedJobFixture.js'
import { verificationRuntimeFixture } from './verificationRuntimeFixture.js'

const readActions: ManagementAction[] = ['job_definitions:read', 'jobs:read', 'job_logs:read',
  'job_artifacts:read', 'sources:read', 'source_roots:read', 'workspace_locations:read', 'settings:read']

/** PostgreSQL and canonical domain services; only installed runtime metadata is serialized fixture data. */
export async function verificationJobsMcpFixture() {
  const database = await currentDatabase()
  const access = new PostgresAccessService(database.pool)
  const writer = await access.issue({ name: 'Verification author', audience: 'operator',
    expiresAt: new Date(Date.now() + 3_600_000), grants: [{ scope: {}, actions: [...readActions,
      'job_definitions:write', 'jobs:start', 'jobs:cancel', 'settings:update'] }] })
  const retained = await retainedJobFixture(database.pool, database.directory, writer.principal)
  const reader = await access.issue({ name: 'Verification reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 3_600_000), grants: [{ actions: readActions,
      scope: { workspaceIds: [retained.workspaceId] } }] })
  const workerExecution = new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' })
  const runtime = await createProductionJobs({ pool: database.pool, commands: retained.commands,
    locations: retained.locations, mainId: retained.mainId, runtimeRoot: retained.runtimeRoot,
    storageRoot: join(retained.runtimeRoot, 'storage'), workerExecution,
    endpoint: () => ({ currentBinding: () => null, captureRequest: () => null }) as unknown as DeviceEndpoint,
    infrastructure: { installedConfiguration: null } })
  const metadata = new Map<string, JobRuntimeFingerprintRecord>([[retained.profile.id, retained.retained.fingerprint]])
  const unavailable = async (): Promise<never> => { throw new Error('MCP authoring does not invoke physical qualification') }
  const profiles = createJobRuntimeProfileService({ pool: database.pool, commands: retained.commands,
    sources: runtime.sources, host: { descriptor: unavailable, reserveQualification: unavailable,
      currentConnection: async () => null, currentMetadata: async (_sql, profile) => metadata.get(profile.id) ?? null } })
  const repositories = new CanonicalJobPrivateRepositories(database.pool, runtime.sources, runtime.executions,
    { preparePrivateRepository: unavailable })
  const sources = new CanonicalJobPreparationSources(runtime.sources, profiles, repositories, runtime.inputs, runtime.policies)
  const preparation = new CanonicalJobPreparationService(sources)
  const placement = new JobComputerSelection(runtime.buildComputers, sources, workerExecution)
  const seed = verificationRuntimeFixture()
  const policy = { schemaVersion: 1 as const, mainId: retained.mainId, revision: 1,
    limits: { maxPendingPerPrincipal: 20, maxPendingPerWorkspace: 40, maxBackfillClaims: 0 },
    envelopes: [seed.spec.verification.resources] }
  const queue = createReviewedBuildQueueConfiguration({ ...policy,
    review: { reviewedByPrincipalId: writer.principal.id, reviewedAt: new Date().toISOString(),
      decisionDigest: jobDigest(policy) } }, retained.mainId)
  const ports = { preparation, placement, dispatch: runtime.dispatch, artifacts: runtime.artifacts, queue, workerExecution }
  const createJobs = () => new JobService(database.pool, retained.commands, ports)
  return { database, access, writer, reader, retained, profiles, seed, runtime, createJobs, runtimeMetadata: metadata,
    qualify: (profile: JobVerificationProfile) => seedQualifiedMetadata(database, metadata, profile, seed, writer.principal.id) }
}

async function seedQualifiedMetadata(database: Awaited<ReturnType<typeof currentDatabase>>,
  metadata: Map<string, JobRuntimeFingerprintRecord>, profile: JobVerificationProfile,
  seed: ReturnType<typeof verificationRuntimeFixture>, principalId: string) {
  const original = seed.measurement
  const approvalExpiresAt = new Date(Date.parse(original.approvedAt)
    + profile.approvalConfig.approvalLifetimeMs).toISOString()
  const fingerprint = { ...original.fingerprint, profileId: profile.id, profileRevision: profile.revision,
    specDigest: profile.specDigest, root: profile.root, hostRef: profile.root.selection.hostRef,
    registration: profile.root.registration, mainInstallationId: profile.root.binding.mainId,
    approvalConfig: profile.approvalConfig, sourceCommit: profile.sourceCommit,
    ...(original.fingerprint.quotaPool ? { quotaPool: { ...original.fingerprint.quotaPool,
      slots: original.fingerprint.quotaPool.slots.map(slot => ({ ...slot,
        filesystem: { ...profile.root.binding.filesystem, inode: slot.filesystem.inode } })) } } : {}) }
  const measurement = JobVerificationRuntimeMeasurementSchema.parse({ ...original, fingerprint,
    identity: { ...original.identity, approvalId: randomUUID(), qualificationId: randomUUID(),
      profileId: profile.id, profileRevision: profile.revision,
      rootId: profile.root.binding.rootId, bindingRevision: profile.root.binding.bindingRevision,
      fingerprintDigest: jobDigest(fingerprint), approvalExpiresAt },
    suites: original.suites.map(suite => ({ ...suite, maxUnitWorkers: 16 })),
  })
  const qualified = JobVerificationProfileSchema.parse({ ...profile, status: 'qualified', measurement })
  metadata.set(profile.id, measurement.fingerprint)
  await database.pool.query('update job_runtime_profiles set record=$2::jsonb where id=$1',
    [profile.id, JSON.stringify(qualified)])
  const approval = JobRuntimeApprovalRecordSchema.parse({ schemaVersion: 2,
    id: measurement.identity.approvalId, qualificationId: measurement.identity.qualificationId,
    workspaceId: profile.workspaceId, profileId: profile.id, profileRevision: profile.revision,
    fingerprint, fingerprintDigest: measurement.identity.fingerprintDigest,
    requestedByPrincipalId: principalId, status: 'complete', approvedByPrincipalId: principalId,
    approvedAt: measurement.approvedAt, requestedAt: measurement.approvedAt, expiresAt: approvalExpiresAt })
  await database.pool.query(`insert into job_runtime_qualification_approvals
    (id,qualification_id,profile_id,profile_revision,workspace_id,record,measurement,requested_by,approved_by)
    values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$8)`, [approval.id, approval.qualificationId,
    profile.id, profile.revision, profile.workspaceId, JSON.stringify(approval), JSON.stringify(measurement), principalId])
  return qualified
}
