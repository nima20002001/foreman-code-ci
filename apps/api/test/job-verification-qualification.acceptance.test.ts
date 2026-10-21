import { readUntil } from './helpers/observableCondition.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { JobVerificationProfileInputSchema, JobVerificationProfileSchema,
  JobRuntimeQualificationReadRecordSchema } from '@foreman-code/contracts/job-verification-runtime'
import { ApprovedSourceSchema } from '@foreman-code/contracts/source-admission'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { createProductionJobs } from '../src/modules/jobs/production.js'
import { createJobRuntimeProfileService } from '../src/modules/jobs/runtimeProfileFactory.js'
import { createInstalledJobRuntimeHost, readProtectedRuntimeConfiguration } from '../src/modules/jobs/installedRuntimeHost.js'
import { InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES } from '../src/modules/jobs/installedVerificationConfiguration.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { ApprovedRootAllowlistSchema, WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { JobBuildQueueConfigurationSchema, JobAdmissionResultSchema } from '@foreman-code/contracts/job-admission'
import { JobDefinitionRecordSchema, JobVerificationReportSchema, JobAuthoringChoicesRecordSchema, JobExecutionRecordSchema, ResolvedVerificationJobSpecSchema } from '@foreman-code/contracts/job-verification'
import { jobRuntimeProfilePolicy } from '@foreman-code/contracts/job-verification-runtime'
import { buildComputerTarget } from '../src/modules/settings/buildComputers.js'
import { openPrivateRoot, identity } from '../src/modules/sources/privateFilesystem.js'
import { sourceSha256 } from '../src/modules/sources/manifest.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { registerJobRuntimeProfileRoutes } from '../src/routes/jobRuntimeProfiles.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

/** Requires an installed image, offline seed, real enforced quota pool and reviewed source/profile inputs. */
describe('installed ordinary verification qualification through authenticated MCP', () => {
  it('requests, human approves, runs every ordinary suite, and restores persisted readiness after host restart', async () => {
    const configurationPath = process.env.FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION
    const profilePath = process.env.FOREMAN_CODE_VERIFICATION_QUALIFICATION_PROFILE
    const queuePath = process.env.FOREMAN_CODE_VERIFICATION_QUALIFICATION_QUEUE
    if (!configurationPath || !profilePath || !queuePath) {
      throw new Error('Provide protected FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION, PROFILE and QUEUE inputs.')
    }
    const ownerUid = process.getuid!()
    const installed = await readProtectedRuntimeConfiguration({ path: configurationPath, ownerUid },
      InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES)
    const spec = await readProtectedRuntimeConfiguration({ path: profilePath, ownerUid }, JobVerificationProfileInputSchema)
    const queue = await readProtectedRuntimeConfiguration({ path: queuePath, ownerUid }, JobBuildQueueConfigurationSchema)
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8',
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    }).trim()
    expect(installed.qualificationSource.manifest.git?.commit).toBe(sourceCommit)
    expect(spec.suites).toEqual(['install', 'typecheck', 'lint', 'unit', 'build'])
    expect(installed.descriptor.target.hostRef.kind).toBe('main')
    const db = await currentDatabase()
    const clients: Client[] = []
    let app: ReturnType<typeof buildApp> | undefined
    let journal: RemoteOperationJournal | undefined
    let runtime: Awaited<ReturnType<typeof createProductionJobs>> | undefined
    try {
      const workspaceId = installed.root.binding.workspaceId
      const mainId = installed.descriptor.target.mainInstallationId
      const access = new PostgresAccessService(db.pool)
      const owner = await access.issue({ name: 'Physical verification owner', audience: 'operator',
        grants: [{ actions: ['job_definitions:read', 'job_definitions:write', 'sources:read', 'source_roots:read', 'jobs:start', 'jobs:cancel', 'jobs:read', 'job_artifacts:read'],
          scope: { workspaceIds: [workspaceId] } },
          { actions: ['settings:read', 'settings:update', 'workspace_locations:read'], scope: {} }], expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
      const reader = await access.issue({ name: 'Physical verification reader', audience: 'operator',
        grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [workspaceId] } }],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
      const root = { ...installed.root, ownerPrincipalId: owner.principal.id, authorizedByPrincipalId: owner.principal.id }
      const configuration = { ...installed, root }
      const location = { path: join(db.directory, 'job-runtime.json'), ownerUid }
      await writeFile(location.path, JSON.stringify(configuration), { mode: 0o600 })
      await writeFile(join(db.directory, 'job-queue.json'), JSON.stringify(queue), { mode: 0o600 })
      await db.pool.query('update application_installation set id=$1 where singleton=true', [mainId])
      await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
        [workspaceId, JSON.stringify({ id: workspaceId, name: 'Physical verification' })])
      const manifest = configuration.qualificationSource.manifest
      await db.pool.query(`insert into source_approvals(approved_source_id,snapshot_id,workspace_id,
        owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
        values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`, [manifest.approvedSourceId, manifest.snapshotId,
        workspaceId, owner.principal.id, randomUUID(), manifest.manifestDigest])
      const source = ApprovedSourceSchema.parse({ version: 1, workspaceId, ownerPrincipalId: owner.principal.id,
        approvedByPrincipalId: owner.principal.id, mainId, locationRevision: root.binding.locationRevision,
        originIdentityHash: `sha256:${manifest.manifestDigest}`, manifest,
        approvedAt: new Date().toISOString(), availability: 'retained' })
      await db.pool.query('insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record) values($1,$2,$3,$4,$5::jsonb)',
        [manifest.snapshotId, manifest.approvedSourceId, workspaceId, manifest.manifestDigest, JSON.stringify(source)])
      await db.pool.query('insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision) values($1,$2,$3,$4)',
        [root.binding.rootId, workspaceId, manifest.manifestDigest, root.binding.bindingRevision])
      await db.pool.query('insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record) values($1,$2,$3,$4,$5::jsonb)',
        [root.binding.rootId, root.binding.bindingRevision, workspaceId, manifest.snapshotId, JSON.stringify(root)])
      const commands = new PostgresCommandCoordinator(db.pool)
      const registry = new NativeProcessRegistry(join(db.directory, 'native-processes'))
      runtime = await createProductionJobs({ pool: db.pool, commands,
        locations: new WorkspaceLocationService(db.pool, commands), mainId,
        runtimeRoot: db.directory, storageRoot: join(db.directory, 'files'), nativeRegistry: registry,
        endpoint: () => { throw new Error('Main-local qualification and Jobs cannot contact a device.') } })
      const runtimeDirectory = await openPrivateRoot(configuration.descriptor.runtimeRoot)
      let runtimeFilesystem
      try { runtimeFilesystem = await identity(runtimeDirectory) } finally { await runtimeDirectory.close() }
      const roots = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef: root.selection.hostRef,
        applicationInstallationId: mainId, configurationRevision: '1',
        bases: [{ baseId: root.binding.rootId, canonicalPath: root.binding.canonicalPath,
          filesystem: root.binding.filesystem, accessModes: ['read-write'] }],
        managedRuntimeRoot: configuration.descriptor.runtimeRoot, runtimeFilesystem })
      await writeFile(join(db.directory, 'approved-roots.json'), JSON.stringify(roots), { mode: 0o600 })
      await runtime.policies.publishApprovedHostConfiguration(db.pool, roots, { mainId,
        hostRef: roots.hostRef, applicationInstallationId: mainId, configurationRevision: '1',
        configurationDigest: sourceSha256(Buffer.from(JSON.stringify(roots))) })
      const policy = WorkspaceRootPolicySchema.parse({ schemaVersion: 1, rootPolicyId: root.selection.rootPolicyId,
        rootPolicyRevision: root.selection.rootPolicyRevision, workspaceId, hostRef: root.selection.hostRef,
        applicationInstallationId: mainId, registration: null, locationRevision: root.selection.locationRevision,
        ownerPrincipalId: owner.principal.id, allowedBaseId: root.binding.rootId, configurationRevision: '1',
        relativePath: '', accessMode: 'read-write', canonicalProjectRoot: root.binding.canonicalPath,
        filesystem: root.binding.filesystem, directoryIdentityHash: sourceSha256(Buffer.from(JSON.stringify(root.binding.filesystem))),
        managedRuntimeRoot: roots.managedRuntimeRoot, runtimeFilesystem, attestationId: root.attestationId,
        attestationDigest: root.attestationDigest })
      await db.pool.query(`insert into workspace_root_policies(root_policy_id,root_policy_revision,
        workspace_id,host_scope,location_revision,record) values($1,$2,$3,$4,$5,$6::jsonb)`,
      [policy.rootPolicyId, policy.rootPolicyRevision, workspaceId, `main:${mainId}`,
        policy.locationRevision, JSON.stringify(policy)])
      for (const entry of manifest.entries) {
        await runtime.snapshots.write(manifest.snapshotId, entry,
          await readFile(join(configuration.qualificationSource.directory, entry.path)))
      }
      await runtime.snapshots.commit(manifest)
      const profiles = runtime.profiles
      const origin = 'http://127.0.0.1:5173'
      app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        localHuman: new PostgresLocalHumanAccess(db.pool, access), browserOrigin: origin,
        operator: { access, services: { commands, jobRuntimeProfiles: profiles, jobs: runtime.jobs } as OperatorServices } })
      registerJobRuntimeProfileRoutes(app, profiles)
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'physical verification', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { authProvider: { token: async () => token } }))
        return client
      }
      const operator = await connect(owner.token)
      const readonly = await connect(reader.token)
      const saved = await operator.callTool({ name: 'job_runtime_profile_save', arguments: {
        workspaceId, commandId: randomUUID(), expectedRevision: null, name: 'Complete ordinary verification', spec } })
      expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true)
      const profile = JobVerificationProfileSchema.parse((decodeMcpToolResult(saved) as { profile: unknown }).profile)
      const request = { workspaceId, commandId: randomUUID(), profileId: profile.id, expectedRevision: profile.revision }
      expect((await readonly.callTool({ name: 'job_runtime_qualification_request', arguments: request })).isError).toBe(true)
      const pending = await operator.callTool({ name: 'job_runtime_qualification_request', arguments: request })
      expect(pending.isError, JSON.stringify(pending.content)).not.toBe(true)
      const approvalId = (decodeMcpToolResult(pending) as { approval: { id: string } }).approval.id
      // The paired computer qualifies its captured candidate directly through MCP; no human step.
      const run = { workspaceId, approvalId, commandId: randomUUID() }
      expect((await readonly.callTool({ name: 'job_runtime_qualification_run', arguments: run })).isError).toBe(true)
      const qualified = await operator.callTool({ name: 'job_runtime_qualification_run', arguments: run },
        { timeout: 24 * 60 * 60 * 1000 })
      expect(qualified.isError, JSON.stringify(qualified.content)).not.toBe(true)
      const read = await operator.callTool({ name: 'job_runtime_qualification_get', arguments: { workspaceId, approvalId } })
      const completed = JobRuntimeQualificationReadRecordSchema.parse(decodeMcpToolResult(read))
      expect(completed.profile.status).toBe('qualified')
      expect(completed.measurement?.schemaVersion).toBe(2)
      expect(completed.readiness.ready).toBe(true)
      expect((await db.pool.query('select record from job_runtime_profiles where id=$1', [profile.id])).rows[0].record)
        .toEqual(completed.profile)
      const publications = completed.measurement!.schemaVersion === 2 ? completed.measurement!.publications! : []
      expect(publications).toHaveLength(7)
      for (const publication of publications) {
        const args = { workspaceId, executionId: publication.executionId }
        expect((await readonly.callTool({ name: 'job_get', arguments: args })).isError).toBe(true)
        const observed = await operator.callTool({ name: 'job_get', arguments: args })
        expect(observed.isError, JSON.stringify(observed.content)).not.toBe(true)
        const diagnostic = JobExecutionRecordSchema.parse((decodeMcpToolResult(observed) as { execution: unknown }).execution)
        expect(diagnostic.process.processStopped).toBe(true)
        expect(diagnostic.publication).toBe('complete')
        const listed = await operator.callTool({ name: 'job_artifacts_list', arguments: args })
        expect((decodeMcpToolResult(listed) as { artifacts: unknown }).artifacts).toEqual(publication.artifacts)
        const summary = publication.artifacts.find(artifact => artifact.path.endsWith('/summary.json'))!
        const readArgs = { ...args, fileId: summary.fileId, revisionId: summary.revisionId }
        expect((await readonly.callTool({ name: 'job_artifact_read', arguments: readArgs })).isError).toBe(true)
        const content = await operator.callTool({ name: 'job_artifact_read', arguments: readArgs })
        expect(content.isError, JSON.stringify(content.content)).not.toBe(true)
        const report = JobVerificationReportSchema.parse(JSON.parse(Buffer.from(
          (decodeMcpToolResult(content) as { content: string }).content, 'base64').toString('utf8')))
        expect(report.executionId).toBe(diagnostic.id)
        expect(report.outcome).toBe(diagnostic.process.outcome === 'succeeded' ? 'passed' : diagnostic.process.outcome)
      }
      const settings = await runtime.buildComputers.update(owner.principal, 'mcp', {
        target: buildComputerTarget({ hostRef: root.selection.hostRef, registration: null, mainInstallationId: mainId }),
        commandId: randomUUID(), expectedRevision: 0, buildEnabled: true, buildPriority: 100 })
      expect(settings.state).toBe('ready')
      const choicesRead = await operator.callTool({ name: 'job_choices_get', arguments: { workspaceId } })
      expect(choicesRead.isError, JSON.stringify(choicesRead.content)).not.toBe(true)
      const choices = JobAuthoringChoicesRecordSchema.parse(decodeMcpToolResult(choicesRead))
      const template = choices.verificationTemplates!.find(item => item.profileId === profile.id && item.suite === 'install')!
      expect(template.ready).toBe(true)
      const saveDefinition = { workspaceId,
        commandId: randomUUID(), expectedRevision: null, name: 'Main offline install', spec: ResolvedVerificationJobSpecSchema.parse({
          source: choices.sources[0]!, target: choices.targets[0]!.target, argv: template.argv,
          inputs: [], outputs: template.outputs!, policy: jobRuntimeProfilePolicy(completed.profile),
          verification: { suite: template.suite, resources: template.resources,
            parameters: template.parameters, credentialRefs: [] },
        }),
      }
      expect((await readonly.callTool({ name: 'job_definition_save', arguments: saveDefinition })).isError).toBe(true)
      const savedDefinition = await operator.callTool({ name: 'job_definition_save', arguments: saveDefinition })
      expect(savedDefinition.isError, JSON.stringify(savedDefinition.content)).not.toBe(true)
      const definition = JobDefinitionRecordSchema.parse((decodeMcpToolResult(savedDefinition) as { definition: unknown }).definition)
      const definitionRead = await operator.callTool({ name: 'job_definition_get', arguments: {
        workspaceId, definitionId: definition.id } })
      expect((decodeMcpToolResult(definitionRead) as { definition: unknown }).definition).toEqual(definition)
      expect((await readonly.callTool({ name: 'job_start', arguments: {
        workspaceId, commandId: randomUUID(), definitionId: definition.id, expectedRevision: definition.revision } })).isError).toBe(true)
      const started = await operator.callTool({ name: 'job_start', arguments: {
        workspaceId, commandId: randomUUID(), definitionId: definition.id, expectedRevision: definition.revision } },
      { timeout: template.policy.preparationTimeoutMs + 60000 })
      expect(started.isError, JSON.stringify(started.content)).not.toBe(true)
      const admission = JobAdmissionResultSchema.parse((decodeMcpToolResult(started) as { admission: unknown }).admission)
      let executionId: string
      if (admission.kind === 'pending-admission') executionId = admission.ticket.executionId
      else if (admission.kind === 'accepted') executionId = admission.executionId
      else executionId = admission.execution.id
      const waitForExecution = async (id: string, ready: (value: ReturnType<typeof JobExecutionRecordSchema.parse>) => boolean) => {
        const timeoutMs = template.policy.preparationTimeoutMs + template.policy.executionTimeoutMs
          + template.policy.publicationTimeoutMs + template.policy.cleanupTimeoutMs
        return readUntil(async () => {
          await runtime!.jobs.wakeQueue()
          const row = (await db.pool.query('select record from job_executions where id=$1', [id])).rows[0]
          if (row) {
            await runtime!.dispatch.wake(id)
            const read = await operator.callTool({ name: 'job_get', arguments: { workspaceId, executionId: id } })
            expect(read.isError, JSON.stringify(read.content)).not.toBe(true)
            const value = JobExecutionRecordSchema.parse((decodeMcpToolResult(read) as { execution: unknown }).execution)
            return value
          }
          return undefined
        }, value => value !== undefined && ready(value),
        { timeoutMs, description: 'the verification Job state within the saved deadline' }).then(value => value!)
      }
      const settled = (value: ReturnType<typeof JobExecutionRecordSchema.parse>) =>
        value.process.phase === 'terminal' && !['pending', 'collecting'].includes(value.publication)
      const execution = await waitForExecution(executionId, settled)
      expect(execution).toMatchObject({ schemaVersion: 2, process: { phase: 'terminal', outcome: 'succeeded', processStopped: true },
        publication: 'complete', acceptedSpec: { target: { hostRef: { kind: 'main' } } } })
      const executionReadback = await operator.callTool({ name: 'job_get', arguments: { workspaceId, executionId: execution!.id } })
      expect(executionReadback.isError, JSON.stringify(executionReadback.content)).not.toBe(true)
      expect((decodeMcpToolResult(executionReadback) as { execution: unknown }).execution).toEqual(execution)
      expect((await runtime.jobs.listArtifacts(owner.principal, workspaceId, execution!.id, 'mcp')).map(output => output.path).sort())
        .toEqual(template.outputs!.map(output => output.path).sort())
      const unitTemplate = choices.verificationTemplates!.find(item => item.profileId === profile.id && item.suite === 'unit')!
      const unitSave = await operator.callTool({ name: 'job_definition_save', arguments: { ...saveDefinition,
        commandId: randomUUID(), name: 'Cancel running offline unit verification',
        spec: { ...saveDefinition.spec, argv: unitTemplate.argv, outputs: unitTemplate.outputs,
          verification: { ...saveDefinition.spec.verification, suite: 'unit', parameters: unitTemplate.parameters } } } })
      expect(unitSave.isError, JSON.stringify(unitSave.content)).not.toBe(true)
      const unitDefinition = JobDefinitionRecordSchema.parse((decodeMcpToolResult(unitSave) as { definition: unknown }).definition)
      const unitStart = await operator.callTool({ name: 'job_start', arguments: { workspaceId,
        commandId: randomUUID(), definitionId: unitDefinition.id, expectedRevision: unitDefinition.revision } })
      expect(unitStart.isError, JSON.stringify(unitStart.content)).not.toBe(true)
      const unitAdmission = JobAdmissionResultSchema.parse((decodeMcpToolResult(unitStart) as { admission: unknown }).admission)
      let unitExecutionId: string
      if (unitAdmission.kind === 'pending-admission') unitExecutionId = unitAdmission.ticket.executionId
      else if (unitAdmission.kind === 'accepted') unitExecutionId = unitAdmission.executionId
      else unitExecutionId = unitAdmission.execution.id
      const active = await waitForExecution(unitExecutionId, value => value.process.phase === 'running')
      const cancel = { workspaceId, executionId: active.id, commandId: randomUUID() }
      expect((await readonly.callTool({ name: 'job_cancel', arguments: cancel })).isError).toBe(true)
      const stopped = await operator.callTool({ name: 'job_cancel', arguments: cancel },
        { timeout: template.policy.cancellationGraceMs + template.policy.publicationTimeoutMs
          + template.policy.cleanupTimeoutMs + 60000 })
      expect(stopped.isError, JSON.stringify(stopped.content)).not.toBe(true)
      const cancelled = await waitForExecution(active.id, settled)
      expect(cancelled).toMatchObject({ process: { outcome: 'cancelled', processStopped: true }, publication: 'complete' })
      const reports = await operator.callTool({ name: 'job_artifacts_list', arguments: { workspaceId, executionId: active.id } })
      const summary = (decodeMcpToolResult(reports) as { artifacts: Array<{ path: string; fileId: string; revisionId: string }> })
        .artifacts.find(artifact => artifact.path.endsWith('/summary.json'))!
      const reportRead = await operator.callTool({ name: 'job_artifact_read', arguments: { workspaceId,
        executionId: active.id, fileId: summary.fileId, revisionId: summary.revisionId } })
      expect(reportRead.isError, JSON.stringify(reportRead.content)).not.toBe(true)
      const cancelledReport = JobVerificationReportSchema.parse(JSON.parse(Buffer.from(
        (decodeMcpToolResult(reportRead) as { content: string }).content, 'base64').toString('utf8')))
      expect(cancelledReport).toMatchObject({ outcome: 'cancelled', executionId: active.id, attemptId: active.attemptId })
      expect((await readonly.callTool({ name: 'job_runtime_qualification_run', arguments: run })).isError).toBe(true)
      const replay = await operator.callTool({ name: 'job_runtime_qualification_run', arguments: run })
      expect(replay.isError).not.toBe(true)
      expect((decodeMcpToolResult(replay) as { profile: unknown }).profile).toEqual(completed.profile)
      const restarted = createInstalledJobRuntimeHost({ identity: db.pool, configuration: location,
        reserve: async () => { throw new Error('Metadata restart cannot reserve native work.') } })
      expect(await restarted.currentMetadata(db.pool, completed.profile)).toBeNull()
      await restarted.capture!(completed.profile)
      const restartedProfiles = createJobRuntimeProfileService({ pool: db.pool, commands,
        sources: runtime.sources, host: restarted })
      expect(await restartedProfiles.readiness(db.pool, completed.profile)).toEqual({ ready: true, reasons: [] })
      await runtime.close()
      runtime = undefined
      journal = await RemoteOperationJournal.open(join(db.directory, 'job-runtime-operations.json'))
      expect(await journal.pendingQualifications()).toEqual([])
      expect((await journal.qualificationStatus(completed.approval.qualificationId))?.phase).toBe('closed')
      expect((await journal.qualificationStatus(completed.approval.qualificationId))?.result?.outcome).toBe('qualified')
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      await app?.close()
      await runtime?.close()
      await journal?.close()
      await db.close()
    }
  }, 24 * 60 * 60 * 1000)
})
