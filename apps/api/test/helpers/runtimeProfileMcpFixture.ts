import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { JobRuntimeFingerprintSchema } from '@foreman-code/contracts/job-runtime'
import { ApprovedSourceSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import type { JobRuntimeProfileRecord, JobRuntimeApprovalRecord } from '@foreman-code/contracts/job-verification-runtime'
import { JobPolicySchema } from '@foreman-code/contracts/jobs'
import { JobVerificationProfileSchema, JobVerificationRuntimeFingerprintSchema,
  JobVerificationRuntimeMeasurementSchema, QualifiedVerificationJobRuntimeSchema } from '@foreman-code/contracts/job-verification-runtime'
import { afterAll, beforeAll, expect, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import type { JobSql } from '../../src/modules/jobs/repository.js'
import { JobRuntimeProfiles } from '../../src/modules/jobs/runtimeProfiles.js'
import type { JobRuntimeQualificationProducer } from '../../src/modules/jobs/runtimeProfilePorts.js'
import { createProductionSources } from '../../src/modules/sources/production.js'
import { createSourceManifest, sourceSha256 } from '../../src/modules/sources/manifest.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { registerJobRuntimeProfileRoutes } from '../../src/routes/jobRuntimeProfiles.js'
import { currentDatabase } from './eng04CurrentDatabase.js'
import { jobSpec } from './jobFixture.js'
import { verificationRuntimeFixture } from './verificationRuntimeFixture.js'

export function runtimeProfileFixture() {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  beforeAll(async () => {
    database = await currentDatabase()
  }, 120_000)
  afterAll(async () => {
    await database?.close()
  }, 120_000)
  return async () => {
    // Cases use fresh servers and mocks while sharing the migrated schema.
    await database.pool.query(`truncate job_runtime_profiles, job_runtime_profile_versions,
      job_runtime_qualification_approvals, source_root_catalog, source_root_bindings,
      source_snapshots, source_approvals cascade`)
    return createFixture(database)
  }
}

const origin = 'http://127.0.0.1:5173', browserHeaders = { host: '127.0.0.1:3000', origin }
/** Real migrated PostgreSQL, domain writes, browser approval and authenticated MCP.
 * Producer records are contract fixtures; physical ordinary qualification has separate acceptance coverage. */
async function createFixture(db: Awaited<ReturnType<typeof currentDatabase>>) {
  const access = new PostgresAccessService(db.pool), workspaceId = randomUUID()
  const owner = await access.issue({ name: 'Runtime fixture owner', audience: 'operator',
    grants: [{ actions: ['job_definitions:read', 'job_definitions:write', 'sources:read', 'source_roots:read',
      'jobs:start', 'job_artifacts:read'], scope: { workspaceIds: [workspaceId] } }], expiresAt: new Date(Date.now() + 3_600_000) })
  const mainId = (await db.pool.query('select id from application_installation')).rows[0].id
  const sourceId = randomUUID(), snapshotId = randomUUID(), rootId = randomUUID()
  const sourceBytes = Buffer.from('{}')
  const manifest = createSourceManifest({ version: 1, approvedSourceId: sourceId, snapshotId,
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip',
    git: { commit: '2'.repeat(40), tree: '3'.repeat(40), objectFormat: 'sha1' },
    entries: [{ path: 'package.json', kind: 'file', executable: false,
      byteSize: sourceBytes.length, sha256: sourceSha256(sourceBytes) }], deletions: [] })
  const digest = manifest.manifestDigest
  const root = SourceRootRecordSchema.parse({ version: 1, source: { approvedSourceId: sourceId, snapshotId, manifestDigest: digest },
    selection: { hostRef: { kind: 'main', mainId }, rootPolicyId: rootId, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId, deviceId: null, workerInstallationId: null, workspaceId, rootId, bindingRevision: 1,
      locationRevision: 1, canonicalPath: '/owned-metadata-fixture', filesystem: { device: '1', inode: '2', mountId: '3' },
      accessMode: 'exclusive-write', snapshotId, manifestDigest: digest }, ownerPrincipalId: owner.principal.id,
    authorizedByPrincipalId: owner.principal.id, registration: null, attestationId: randomUUID(), attestationDigest: digest, boundAt: new Date().toISOString() })
  await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId, JSON.stringify({ id: workspaceId, name: 'Runtime metadata fixture' })])
  await db.pool.query("insert into source_approvals(approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request) values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')", [sourceId, snapshotId, workspaceId, owner.principal.id, randomUUID(), digest])
  const approvedSource = ApprovedSourceSchema.parse({ version: 1, workspaceId, ownerPrincipalId: owner.principal.id,
    approvedByPrincipalId: owner.principal.id, mainId, locationRevision: 1,
    originIdentityHash: `sha256:${digest}`, manifest, approvedAt: root.boundAt, availability: 'retained' })
  await db.pool.query('insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record) values($1,$2,$3,$4,$5::jsonb)',
    [snapshotId, sourceId, workspaceId, digest, JSON.stringify(approvedSource)])
  await db.pool.query('insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision) values($1,$2,$3,1)', [rootId, workspaceId, digest])
  await db.pool.query('insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record) values($1,1,$2,$3,$4::jsonb)', [rootId, workspaceId, snapshotId, JSON.stringify(root)])
  const producer = { capture: vi.fn(async (profile: JobRuntimeProfileRecord) => {
    if (profile.schemaVersion === 2) {
      const metadata = verificationRuntimeFixture().measurement.fingerprint
      return JobVerificationRuntimeFingerprintSchema.parse({ ...metadata, profileId: profile.id,
        profileRevision: profile.revision, specDigest: profile.specDigest, root: profile.root,
        hostRef: profile.root.selection.hostRef, registration: profile.root.registration, mainInstallationId: mainId,
        resources: profile.spec.resources, limits: profile.spec.resources.limits, sourceCommit: profile.sourceCommit,
        network: profile.spec.policy.network, approvalConfig: profile.approvalConfig,
        imageDigest: profile.spec.policy.imageDigest, toolchainDigest: profile.spec.policy.toolchainDigest,
        quotaPool: { ...metadata.quotaPool!, slots: metadata.quotaPool!.slots.map(slot => ({
          ...slot, filesystem: { ...profile.root.binding.filesystem, inode: slot.filesystem.inode },
        })) } })
    }
    return JobRuntimeFingerprintSchema.parse({ schemaVersion: 1,
    profileId: profile.id, profileRevision: profile.revision, specDigest: profile.specDigest, hostRef: root.selection.hostRef,
    registration: null, mainInstallationId: mainId, bootId: randomUUID(), root, runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: digest,
    ociExecutable: '/usr/bin/crun', ociBinarySha256: digest, configurationDigest: digest, imageDigest: profile.policy.imageDigest,
    toolchainDigest: profile.policy.toolchainDigest, limits: profile.limits }) }),
    reconcile: vi.fn<JobRuntimeQualificationProducer['run']>(async () => ({ outcome:'denied',closure:'unconfirmed',
      reasons:['JOB_RUNTIME_QUALIFICATION_FAILED'] })),
    run: vi.fn<JobRuntimeQualificationProducer['run']>(async (approval: JobRuntimeApprovalRecord) => {
      if (approval.schemaVersion === 1) throw new Error('private producer failure /secret/path token=do-not-expose')
      const fixture = verificationRuntimeFixture()
      const profile = JobVerificationProfileSchema.parse((await db.pool.query(
        'select record from job_runtime_profile_versions where profile_id=$1 and revision=$2',
        [approval.profileId, approval.profileRevision])).rows[0].record)
      const fingerprint = approval.fingerprint
      const measurement = JobVerificationRuntimeMeasurementSchema.parse({ ...fixture.measurement, fingerprint,
        approvedAt: approval.approvedAt ?? approval.requestedAt,
        checkedAt: new Date().toISOString(), expiresAt: approval.expiresAt,
        identity: { ...fixture.measurement.identity, profileId: profile.id, profileRevision: profile.revision,
          rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision,
          qualificationId: approval.qualificationId, fingerprintDigest: approval.fingerprintDigest,
          imageDigest: fingerprint.imageDigest, toolchainDigest: fingerprint.toolchainDigest, network: fingerprint.network,
          approvalId: approval.id, approvalExpiresAt: approval.expiresAt, qualificationExpiresAt: approval.expiresAt },
        suites: profile.spec.suites.map(suite => ({ ...fixture.measurement.suites[0], suite,
          resources: profile.spec.resources })),
      })
      const runtime = QualifiedVerificationJobRuntimeSchema.parse({ ...fixture.runtime, ...fingerprint.limits,
        policyId: profile.id, policyRevision: profile.revision, qualificationId: approval.qualificationId,
        imageDigest: fingerprint.imageDigest, toolchainDigest: fingerprint.toolchainDigest, network: fingerprint.network,
        quota: fingerprint.quota, deviceLimits: fingerprint.deviceLimits, provisioningSuite: fingerprint.provisioningSuite,
        aggregateCgroupIdentityDigest: fingerprint.aggregateCgroupIdentityDigest, imageManifestDigest: fingerprint.imageManifestDigest,
        imageConfigDigest: fingerprint.imageConfigDigest, resourcePolicyRevision: fingerprint.resourcePolicyRevision,
        resourcePolicyDigest: fingerprint.resourcePolicyDigest, runtimeApprovalId: fingerprint.runtimeApprovalId,
        runtimeApprovalRevision: fingerprint.runtimeApprovalRevision })
      return { outcome: 'qualified' as const, measurement, runtime }
    }),
    revalidate: vi.fn(async (_sql: JobSql, profile: JobRuntimeProfileRecord) => profile.schemaVersion === 2
      ? { ready: true, reasons: [] } : { ready: false, reasons: ['UNQUALIFIED'] }) }
  const commands = new PostgresCommandCoordinator(db.pool)
  const noCarrier = (): never => { throw new Error('Source snapshot readback cannot contact a worker') }
  const sourceRuntime = await createProductionSources({ pool: db.pool, commands,
    locations: new WorkspaceLocationService(db.pool, commands), mainId, runtimeRoot: db.directory,
    endpoint: noCarrier, dispatch: noCarrier })
  vi.spyOn(sourceRuntime.sources, 'resolveRootBinding').mockResolvedValue(root)
  const service = new JobRuntimeProfiles(db.pool, commands, sourceRuntime.sources, producer)
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    localHuman: { current: () => access.currentOperator(owner.principal.id) }, browserOrigin: origin,
    operator: { access, services: { commands, jobRuntimeProfiles: service } as OperatorServices } })
  registerJobRuntimeProfileRoutes(app, service)
  const clients: Client[] = [], close = async () => { await Promise.allSettled(clients.map(client => client.close())); await app.close() }
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 }), auth = { authorization: `Bearer ${owner.token}` }
    const base = `/api/management/workspaces/${workspaceId}/jobs`
    const policy = JobPolicySchema.omit({ isolationPolicyId: true, isolationPolicyRevision: true }).strip().parse(jobSpec().policy)
    const input = { commandId: randomUUID(), expectedRevision: null, name: 'Candidate runtime', spec: { rootId, bindingRevision: 1,
      limits: { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 64, diskBytes: 134217728 }, policy: { ...policy, maxWorkerSpoolBytes: 131072 } } }
    const saved = await app.inject({ method: 'POST', url: `${base}/runtime-profiles`, headers: auth, payload: input })
    expect(saved.statusCode, saved.body).toBe(200)
    const profile = saved.json().profile
    const requested = await app.inject({ method: 'POST', url: `${base}/runtime-profiles/${profile.id}/qualification-requests`, headers: auth,
      payload: { commandId: randomUUID(), expectedRevision: 1 } })
    expect(requested.statusCode, requested.body).toBe(200)
    const approval = requested.json().approval
    const connect = async (token = owner.token) => {
      const client = new Client({ name: 'runtime profile parity', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const browser = async () => browserHeaders
    return { db, access, owner, app, auth, base, workspaceId, profile, approval, input, producer, connect, browser, close,
      service, createService: () => new JobRuntimeProfiles(db.pool,new PostgresCommandCoordinator(db.pool),
        sourceRuntime.sources,producer) }
  } catch (error) { await close(); throw error }
}
