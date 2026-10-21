import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AutoJobDefinitionSpecSchema, jobPolicyRequirements } from '@foreman-code/contracts/jobs'
import { ApprovedRootAllowlistSchema, WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { revokeDevice } from '@foreman-code/contracts/device-identity'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { CanonicalJobPreparationSources, CanonicalJobPreparationService } from '../src/modules/jobs/sourcePreparation.js'
import { createJobRuntimeProfileService } from '../src/modules/jobs/runtimeProfileFactory.js'
import { JobComputerSelection } from '../src/modules/jobs/computerSelection.js'
import { createProductionJobs } from '../src/modules/jobs/production.js'
import { JobService } from '../src/modules/jobs/service.js'
import { buildComputerTarget } from '../src/modules/settings/buildComputers.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { sourceSha256 } from '../src/modules/sources/manifest.js'
import type { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { retainedJobFixture } from './helpers/retainedJobFixture.js'
import { buildComputerFixture, buildQueueConfigurationFixture } from './helpers/buildComputerFixture.js'
import { jobRuntimeMetadataFixture } from './helpers/jobRuntimeMetadataFixture.js'

describe.skipIf(!postgresEnabled)('canonical build candidate inventory', () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  let principal: Awaited<ReturnType<PostgresAccessService['issue']>>['principal']
  beforeEach(async () => {
    database = await currentDatabase()
    principal = (await new PostgresAccessService(database.pool).issue({ name: 'Inventory writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ scope: {}, actions: [
        'jobs:start', 'jobs:read', 'jobs:cancel', 'job_definitions:read', 'job_definitions:write',
        'sources:read', 'source_roots:read', 'settings:read', 'settings:update', 'workspace_locations:read',
      ] }] })).principal
  }, 60000)
  afterEach(async () => { await database?.close() })
  async function fixture() {
    const f = await retainedJobFixture(database.pool, database.directory, principal)
    const workerExecution = new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' })
    const runtime = await createProductionJobs({ pool: database.pool, commands: f.commands,
      locations: f.locations, mainId: f.mainId, runtimeRoot: f.runtimeRoot, storageRoot: join(f.runtimeRoot, 'storage'),
      endpoint: () => ({ currentBinding: () => null, captureRequest: () => null }) as unknown as DeviceEndpoint,
      infrastructure: { installedConfiguration: null }, workerExecution })
    // Host metadata is the boundary fixture; profile, fingerprint, root, device and selection checks run unchanged.
    const metadata = new Map([[f.profile.id, structuredClone(f.retained.fingerprint)]])
    const forbidden = async (): Promise<never> => { throw new Error('Inventory reads cannot launch or inspect a runtime') }
    const profiles = createJobRuntimeProfileService({ pool: database.pool, commands: f.commands, sources: runtime.sources,
      host: { descriptor: forbidden, reserveQualification: forbidden, currentConnection: async () => null,
        currentMetadata: async (_sql, profile) => metadata.get(profile.id) ?? null } })
    const sources = new CanonicalJobPreparationSources(runtime.sources, profiles, { prepare: forbidden },
      runtime.inputs, runtime.policies)
    const preparation = new CanonicalJobPreparationService(sources)
    const placement = new JobComputerSelection(runtime.buildComputers, sources, workerExecution)
    const queue = buildQueueConfigurationFixture(principal, f.profile.limits)
    const jobs = new JobService(database.pool, f.commands, { preparation, placement,
      dispatch: runtime.dispatch, artifacts: runtime.artifacts, queue, workerExecution })
    return { ...f, runtime, metadata, profiles, sources, preparation, placement, jobs }
  }

  it('claims and validates a fixed request against its retained qualified version after an actual profile edit', async () => {
    const f = await fixture()
    try {
      await f.runtime.buildComputers.update(principal, 'http', { target: buildComputerTarget(f.spec.target),
        commandId: randomUUID(), expectedRevision: 0, buildEnabled: true, buildPriority: 100 })
      const result = await f.jobs.enqueue(principal, 'mcp', f.workspaceId, { commandId: randomUUID(),
        definitionId: f.definition.id, expectedRevision: 1 })
      if (result.kind !== 'pending-admission') throw new Error('The occupied computer must keep this request waiting')
      await f.jobs.wakeQueue()
      const ticket = await f.jobs.getQueueTicket(principal, f.workspaceId, result.ticket.id)
      expect(ticket).toMatchObject({ state: 'waiting', waitingReasons: ['busy'] })
      await f.jobs.closeQueue()
      const edited = await f.profiles.save(principal, 'mcp', f.workspaceId, { commandId: randomUUID(),
        id: f.profile.id, expectedRevision: 1, name: 'Edited profile', spec: {
          rootId: f.root.binding.rootId, bindingRevision: 1, limits: f.profile.limits,
          policy: { ...jobPolicyRequirements(f.profile.policy), maxWorkerSpoolBytes: 131072 },
        } })
      expect(edited).toMatchObject({ revision: 2, status: 'unqualified', measurement: null })
      await f.runtime.jobs.cancel(principal, 'http', f.workspaceId, f.execution.id, randomUUID())
      const sql = await database.pool.connect()
      try {
        await sql.query('begin')
        const claim = await f.placement.claim(sql, principal, f.definition, ticket)
        expect(claim.spec).toMatchObject({ target: f.spec.target,
          policy: { isolationPolicyId: f.profile.id, isolationPolicyRevision: 1 } })
        await sql.query('commit')
        expect(await f.preparation.validate(sql, principal, f.workspaceId, claim.spec!))
          .toEqual({ valid: true, reasons: [], sideEffects: false })
        const original = f.metadata.get(f.profile.id)!
        f.metadata.set(f.profile.id, { ...original, configurationDigest: '9'.repeat(64) })
        expect(await f.preparation.validate(sql, principal, f.workspaceId, claim.spec!))
          .toEqual({ valid: false, reasons: ['JOB_RUNTIME_CONTEXT_CHANGED'], sideEffects: false })
        f.metadata.set(f.profile.id, original)
        await database.pool.query('update job_runtime_profiles set record=$2::jsonb where id=$1',
          [edited.id, JSON.stringify({ ...edited, status: 'revoked' })])
        await expect(f.sources.candidates(sql, principal, f.workspaceId, f.definition.spec))
          .rejects.toMatchObject({ code: 'AUTH_REVOKED', status: 403 })
        await expect(f.preparation.validate(sql, principal, f.workspaceId, claim.spec!))
          .rejects.toMatchObject({ code: 'AUTH_REVOKED', status: 403 })
      } finally { sql.release() }
      expect((await f.jobs.getQueueTicket(principal, f.workspaceId, ticket.id)).definition).toEqual(f.definition)
    } finally { await f.jobs.closeQueue(); await f.runtime.close() }
  })

  it.each([true, false])('retains canonical device revocation diagnostics with all matching devices revoked=%s', async allRevoked => {
    const f = await fixture()
    try {
      const computers = Array.from({ length: 2 }, () => buildComputerFixture(f.mainId, f.workspaceId))
      for (const [index, computer] of computers.entries()) {
        const root = computer.candidate.profile.root
        const spec = computer.candidate.spec
        spec.source = f.spec.source
        spec.policy.imageDigest = `sha256:${'9'.repeat(64)}`
        const managedRuntimeRoot = `/approved/${computer.registration.deviceId}`
        root.binding.canonicalPath = join(managedRuntimeRoot, 'source-materializations', root.selection.rootPolicyId)
        root.source = f.root.source
        root.binding.snapshotId = f.root.source.snapshotId
        root.binding.manifestDigest = f.root.source.manifestDigest
        spec.target.destination.canonicalProjectRoot = root.binding.canonicalPath
        spec.target.destination.canonicalCwd = root.binding.canonicalPath
        spec.target.destination.managedRuntimeRoot = managedRuntimeRoot
        spec.target.destination.directoryIdentityHash = sourceSha256(Buffer.from(JSON.stringify(root.binding.filesystem)))
        const retained = jobRuntimeMetadataFixture({ ...computer.candidate.profile, root, policy: spec.policy }, randomUUID())
        const profile = retained.profile
        f.metadata.set(profile.id, retained.fingerprint)
        await database.pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
          values($1,$2,$3,'fixture',$4::jsonb)`, [computer.registration.deviceId, f.mainId,
          computer.registration.workerInstallationId, JSON.stringify(computer.registration)])
        await database.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
          values($1,$2,$3,1)`, [root.binding.rootId, f.workspaceId, randomUUID()])
        await database.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
          values($1,1,$2,$3,$4::jsonb)`, [root.binding.rootId, f.workspaceId, root.source.snapshotId, JSON.stringify(root)])
        await database.pool.query(`insert into job_runtime_profiles(id,workspace_id,revision,root_id,binding_revision,record)
          values($1,$2,1,$3,1,$4::jsonb)`, [profile.id, f.workspaceId, root.binding.rootId, JSON.stringify(profile)])
        await database.pool.query('insert into job_runtime_profile_versions(profile_id,revision,record) values($1,1,$2::jsonb)',
          [profile.id, JSON.stringify(profile)])
        const measurement = profile.measurement!
        await database.pool.query(`insert into job_runtime_qualification_approvals
          (id,qualification_id,profile_id,profile_revision,workspace_id,record,measurement,requested_by,approved_by)
          values($1,$2,$3,1,$4,'{"status":"complete"}',$5::jsonb,$6,$6)`, [measurement.approvalId,
          measurement.qualificationId, profile.id, f.workspaceId, JSON.stringify(measurement), principal.id])
        const configuration = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef: root.selection.hostRef,
          applicationInstallationId: computer.registration.workerInstallationId, configurationRevision: '1',
          bases: [{ baseId: root.binding.rootId, canonicalPath: '/approved', filesystem: root.binding.filesystem,
            accessModes: ['read-write'] }], managedRuntimeRoot, runtimeFilesystem: root.binding.filesystem })
        await f.runtime.policies.publishApprovedHostConfiguration(database.pool, configuration, { mainId: f.mainId,
          hostRef: configuration.hostRef, applicationInstallationId: configuration.applicationInstallationId,
          configurationRevision: '1', configurationDigest: sourceSha256(Buffer.from(JSON.stringify(configuration))) })
        const policy = WorkspaceRootPolicySchema.parse({ schemaVersion: 1, rootPolicyId: root.selection.rootPolicyId,
          rootPolicyRevision: '1', workspaceId: f.workspaceId, hostRef: root.selection.hostRef,
          applicationInstallationId: computer.registration.workerInstallationId, registration: root.registration,
          locationRevision: '1', ownerPrincipalId: principal.id, allowedBaseId: root.binding.rootId,
          configurationRevision: '1', relativePath: '', accessMode: 'read-write', canonicalProjectRoot: '/approved',
          filesystem: root.binding.filesystem, directoryIdentityHash: spec.target.destination.directoryIdentityHash,
          managedRuntimeRoot, runtimeFilesystem: root.binding.filesystem, attestationId: root.attestationId,
          attestationDigest: root.attestationDigest })
        await database.pool.query(`insert into workspace_root_policies
          (root_policy_id,root_policy_revision,workspace_id,host_scope,location_revision,record)
          values($1,'1',$2,$3,'1',$4::jsonb)`, [policy.rootPolicyId, f.workspaceId,
          `main:${f.mainId}:device:${computer.registration.deviceId}`, JSON.stringify(policy)])
        await f.runtime.buildComputers.update(principal, 'http', { target: computer.target,
          commandId: randomUUID(), expectedRevision: 0, buildEnabled: true, buildPriority: 100 })
        if (allRevoked || index === 0) await database.pool.query('update device_registrations set record=$2::jsonb where id=$1',
          [computer.registration.deviceId, JSON.stringify(revokeDevice(computer.registration))])
      }
      const spec = AutoJobDefinitionSpecSchema.parse({ ...computers[0]!.candidate.spec, target: { kind: 'auto' },
        limits: computers[0]!.candidate.profile.limits, policy: jobPolicyRequirements(computers[0]!.candidate.spec.policy) })
      const definition = await f.jobs.saveDefinition(principal, 'mcp', f.workspaceId, { commandId: randomUUID(),
        expectedRevision: null, name: 'Device build', spec })
      const discovery = await f.sources.candidates(database.pool, principal, f.workspaceId, spec)
      expect(discovery.diagnosticCodes).toContain('revoked')
      if (allRevoked) {
        const result = await f.jobs.enqueue(principal, 'mcp', f.workspaceId, { commandId: randomUUID(),
          definitionId: definition.id, expectedRevision: 1 })
        if (result.kind !== 'pending-admission') throw new Error('Revoked devices cannot accept execution')
        await f.jobs.wakeQueue()
        expect(await f.jobs.getQueueTicket(principal, f.workspaceId, result.ticket.id))
          .toMatchObject({ state: 'terminal', terminalReason: 'authorization_revoked', reservationId: null })
      } else {
        const sql = await database.pool.connect()
        try {
          await sql.query('begin')
          const claim = await f.placement.claim(sql, principal, definition,
            { executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID() })
          expect(claim.spec?.target.hostRef).toEqual(computers[1]!.candidate.spec.target.hostRef)
          expect(claim.reasons).toEqual([])
          await sql.query('commit')
        } finally { sql.release() }
      }
    } finally { await f.jobs.closeQueue(); await f.runtime.close() }
  })
})
