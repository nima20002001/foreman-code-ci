import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { ApprovedRootAllowlistSchema } from '@foreman-code/contracts/workspace-root-policies'
import { WorkspaceBoundLocationReadbackSchema, WorkspaceBoundLocationSetResultSchema }
  from '@foreman-code/contracts/workspace-bound-location'
import { NodePlacementChoicesResultSchema } from '@foreman-code/contracts/placement-readback'
import { SourceRootListResultSchema } from '@foreman-code/contracts/source-admission'
import { HostHarnessProfileEvidenceSchema } from '@foreman-code/contracts/harness-registry'
import { JobRuntimeProfileListRecordSchema, JobVerificationProfileSchema, type JobVerificationProfile }
  from '@foreman-code/contracts/job-verification-runtime'
import { JobAuthoringChoicesRecordSchema } from '@foreman-code/contracts/job-verification'
import { buildApp } from '../src/app.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { JobRuntimeProfiles, verificationProfileReadiness } from '../src/modules/jobs/runtimeProfiles.js'
import { JobService, jobDigest } from '../src/modules/jobs/service.js'
import { CanonicalJobPreparationSources } from '../src/modules/jobs/sourcePreparation.js'
import { ProductionPlacementChoiceDiscovery } from '../src/modules/placement/choiceDiscovery.js'
import { NodePlacementChoicesService } from '../src/modules/placement/choicesService.js'
import { resolveLocalMainPlacement } from '../src/modules/placement/localMainPlacement.js'
import { PostgresWorkspaceRootPolicies } from '../src/modules/sources/rootPolicies.js'
import type { WorkspaceRootHostPort } from '../src/modules/sources/rootPolicyPorts.js'
import { rootAttestationDigest, rootSelectionDigest } from '../src/modules/sources/rootAttestation.js'
import { WorkspaceBoundLocationService } from '../src/modules/workspace-roots/service.js'
import { DomainError } from '../src/modules/errors.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { mixedComputerPlacement } from './helpers/mixedComputerPlacement.js'
import { verificationCapacityFixture } from './helpers/verificationCapacityFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

// Host attestations and qualification metadata are fixtures; authorization, location changes,
// persisted bindings and placement discovery use the production services over authenticated MCP.
async function fixture() {
  const base = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'sequential') })
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const sourceCommit = 'b'.repeat(40)
    const placement = await mixedComputerPlacement(base, base.db.directory, {
      git: { commit: sourceCommit, tree: 'c'.repeat(40), objectFormat: 'sha1' },
      sourceAccessMode: 'exclusive-write',
    })
    const workspaceId = base.f.scope.workspaceId
    const originalPolicies = await placement.policies.read(base.db.pool, base.writer.principal, workspaceId)
    const allowlists = (await base.db.pool.query<{ record: unknown }>(
      'select record from workspace_root_host_configurations',
    )).rows.map(row => ApprovedRootAllowlistSchema.parse(row.record))
    const unused = async (): Promise<never> => { throw new Error('No native execution in location regression') }
    let disconnected = false
    const hosts: WorkspaceRootHostPort = {
      ...placement.hosts,
      authorize: async (...args) => {
        if (disconnected && args[2].kind === 'device') {
          throw new DomainError('ROOT_HOST_UNAVAILABLE', 'The selected computer is disconnected.', 503)
        }
        return placement.hosts.authorize(...args)
      },
      configurations: async () => allowlists,
      browse: unused,
      sourceNamespace: unused,
      attest: async root => {
        const original = originalPolicies.find(policy => sameWorkflowValue(policy.hostRef, root.selection.hostRef))!
        const facts = { schemaVersion: 1 as const, attestationId: randomUUID(),
          requestDigest: rootSelectionDigest(root.selection), hostRef: root.selection.hostRef,
          applicationInstallationId: root.allowlist.applicationInstallationId,
          configurationRevision: root.selection.configurationRevision, allowedBaseId: root.selection.allowedBaseId,
          relativePath: root.selection.relativePath, accessMode: root.selection.accessMode,
          canonicalProjectRoot: original.canonicalProjectRoot, filesystem: original.filesystem,
          directoryIdentityHash: original.directoryIdentityHash, managedRuntimeRoot: original.managedRuntimeRoot,
          runtimeFilesystem: root.allowlist.runtimeFilesystem }
        return { ...facts, attestationDigest: rootAttestationDigest(facts) }
      },
    }
    const policies = new PostgresWorkspaceRootPolicies(placement.local.hostRef.mainId, hosts)
    base.locations.setRootPolicies(policies)
    const createLocations = () => new WorkspaceBoundLocationService(base.db.pool, base.commands, policies)
    const createChoices = () => new NodePlacementChoicesService(base.db.pool,
      new ProductionPlacementChoiceDiscovery(base.db.pool, () => ({ roots: policies, sources: placement.sources,
        profiles: new HarnessInstanceSettingsRepository(base.db.pool),
        registry: { installations: placement.installations, profileEvidence: async (profile, sql) => {
          const row = (await sql!.query<{ record: unknown }>(
            'select record from harness_instance_profile_evidence where instance_id=$1 and instance_revision=$2',
            [profile.instanceId, profile.instanceRevision],
          )).rows[0]
          return row ? HostHarnessProfileEvidenceSchema.parse(row.record) : null
        } },
      })))
    const roots = await placement.sources.rootList(base.writer.principal, 'http', { workspaceId })
    const savedProfiles: JobVerificationProfile[] = []
    for (const root of roots.items) {
      const profile = verificationCapacityFixture(root.selection.hostRef.kind)
      profile.id = randomUUID()
      profile.workspaceId = workspaceId
      profile.root = root
      profile.sourceCommit = sourceCommit
      profile.spec.rootId = root.binding.rootId
      profile.spec.bindingRevision = root.binding.bindingRevision
      profile.specDigest = jobDigest({ workspaceId, id: profile.id, revision: profile.revision,
        root, sourceCommit: profile.sourceCommit, spec: profile.spec, approvalConfig: profile.approvalConfig })
      const measurement = profile.measurement!
      const fingerprint = measurement.fingerprint
      Object.assign(fingerprint, { profileId: profile.id, specDigest: profile.specDigest,
        root, sourceCommit, hostRef: root.selection.hostRef, registration: root.registration,
        mainInstallationId: root.binding.mainId })
      for (const slot of fingerprint.quotaPool!.slots) {
        slot.filesystem.device = root.binding.filesystem.device
        slot.filesystem.mountId = root.binding.filesystem.mountId
      }
      Object.assign(measurement.identity, { profileId: profile.id, rootId: root.binding.rootId,
        bindingRevision: root.binding.bindingRevision, fingerprintDigest: jobDigest(fingerprint) })
      savedProfiles.push(JobVerificationProfileSchema.parse(profile))
      await base.db.pool.query(`insert into job_runtime_profiles
        (id,workspace_id,revision,root_id,binding_revision,record) values($1,$2,1,$3,$4,$5::jsonb)`,
      [profile.id, workspaceId, root.binding.rootId, root.binding.bindingRevision, JSON.stringify(profile)])
    }
    const installedFingerprints = new Map(savedProfiles.map(profile => [
      profile.id, structuredClone(profile.measurement!.fingerprint),
    ]))
    const createProfiles = () => new JobRuntimeProfiles(base.db.pool, base.commands, placement.sources, {
      capture: unused, run: unused,
      revalidate: async (sql, profile) => {
        await policies.resolve(sql, base.writer.principal, { workspaceId, ...profile.root.selection })
        await placement.sources.resolveRootBinding(sql, base.writer.principal, {
          workspaceId, rootId: profile.root.binding.rootId,
          bindingRevision: profile.root.binding.bindingRevision, source: profile.root.source,
        })
        return verificationProfileReadiness({
          profile: JobVerificationProfileSchema.parse(profile),
          currentFingerprint: installedFingerprints.get(profile.id) ?? null,
        })
      },
    })
    const profiles = createProfiles()
    const jobSources = new CanonicalJobPreparationSources(placement.sources, profiles,
      { prepare: unused }, { validateDeclaredJobInputs: unused }, policies)
    const jobs = new JobService(base.db.pool, base.commands, {
      preparation: {
        choices: (sql, principal, id) => jobSources.choices(sql, principal, id),
        accept: unused, validate: unused, revalidateAccepted: unused, adoptFinalBinding: unused,
      },
      dispatch: { accept: unused, wake: unused, cancel: unused, cancelForRunCleanup: unused },
      artifacts: { list: unused, read: unused },
    })
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: base.access, services: { ...base.services, workspaceRoots: createLocations(),
        placementChoices: createChoices(), sources: placement.sources, jobRuntimeProfiles: profiles, jobs } },
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'Location binding regression', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(base.writer.token)
    const input = { workspaceId, workflowId: base.f.scope.workflowId, nodeId: base.f.version.definition.nodes[0]!.id,
      agentConfigurationVersionId: base.f.configurations[0]!.id }
    return { base, placement, workspaceId, roots, savedProfiles, jobs, originalPolicies, input,
      client, connect, createLocations, createChoices, createProfiles, app,
      disconnect: (value: boolean) => { disconnected = value },
      async close() {
        await Promise.allSettled(clients.map(client => client.close()))
        await app!.close()
        await base.close()
      } }
  } catch (error) {
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    await base.close()
    throw error
  }
}

describe.skipIf(!postgresEnabled)('workspace location preserves host bindings', () => {
  it('keeps both hosts placeable across an MCP round trip without rewriting roots or qualified profiles', async () => {
    const f = await fixture()
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await f.client.callTool({ name, arguments: args })
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
        return decodeMcpToolResult(result)
      }
      const choices = () => call('workflow_node_placement_choices', f.input)
        .then(value => NodePlacementChoicesResultSchema.parse(value))
      const jobChoices = () => call('job_choices_get', { workspaceId: f.workspaceId })
        .then(value => JobAuthoringChoicesRecordSchema.parse(value))
      const before = await choices()
      expect(before.choices).toHaveLength(2)
      expect(before.choices.every(choice => choice.availability === 'ready')).toBe(true)
      const jobsBefore = await jobChoices()
      expect(jobsBefore.targets).toHaveLength(2)
      expect(jobsBefore.targets.every(target => target.ready)).toBe(true)
      expect(jobsBefore.verificationTemplates).toHaveLength(2)
      expect(jobsBefore.verificationTemplates!.every(template => template.ready)).toBe(true)
      let revision = f.placement.locationRevision
      for (const host of ['device', 'main'] as const) {
        const policy = f.originalPolicies.find(policy => policy.hostRef.kind === host)!
        const input = { workspaceId: f.workspaceId, commandId: randomUUID(), hostRef: policy.hostRef,
          allowedBaseId: policy.allowedBaseId, configurationRevision: policy.configurationRevision,
          relativePath: policy.relativePath, accessMode: policy.accessMode,
          expectedLocationRevision: revision, expectedRootPolicyRevision: Number(policy.rootPolicyRevision) }
        const saved = WorkspaceBoundLocationSetResultSchema.parse(await call('workspace_root_location_set', input))
        if (host === 'main') revision++
        expect(saved.value).toMatchObject({ evidence: 'bound', locationRevision: revision,
          binding: { hostRef: policy.hostRef, rootPolicyRevision: '2' } })
        expect(await call('workspace_root_location_set', input)).toEqual({ ...saved, replayed: true })
        const stale = await f.client.callTool({ name: 'workspace_root_location_set', arguments: {
          ...input, commandId: randomUUID(),
        } })
        expect(stale.isError).toBe(true)
        expect(stale.content).toEqual([{
          type: 'text', text: expect.stringContaining(host === 'main'
            ? '"code":"LOCATION_REVISION_CONFLICT"' : '"code":"ROOT_POLICY_REVISION_CONFLICT"'),
        }])
        expect(await choices()).toEqual(before)
        expect(await jobChoices()).toEqual(jobsBefore)
        expect(SourceRootListResultSchema.parse(await call('source_root_list', { workspaceId: f.workspaceId })))
          .toEqual(f.roots)
        const profiles = JobRuntimeProfileListRecordSchema.parse(await call('job_runtime_profile_list', {
          workspaceId: f.workspaceId,
        }))
        expect(profiles.profiles).toHaveLength(2)
        for (const savedProfile of f.savedProfiles) {
          expect(profiles.profiles.find(value => value.profile.id === savedProfile.id))
            .toMatchObject({ profile: savedProfile, ready: true })
        }
        const read = WorkspaceBoundLocationReadbackSchema.parse(await call('workspace_root_location_get', {
          workspaceId: f.workspaceId,
        }))
        if (host === 'main') expect(read).toEqual(saved.value)
        else expect(read).toMatchObject({ evidence: 'bound', locationRevision: revision,
          binding: { hostRef: f.placement.local.hostRef, rootPolicyRevision: '1' } })
        expect(await call('workspace_get', { workspaceId: f.workspaceId })).toMatchObject({
          executionLocation: read.executionLocation, locationRevision: read.locationRevision,
          locationValidation: { status: 'ready' },
        })
        const genericHttp = await f.app.inject({ method: 'GET',
          url: `/api/management/workspaces/${f.workspaceId}`,
          headers: { authorization: `Bearer ${f.base.writer.token}` },
        })
        expect(genericHttp.statusCode).toBe(200)
        expect(genericHttp.json()).toMatchObject({ executionLocation: read.executionLocation,
          locationValidation: { status: 'ready' } })
        if (host === 'device') {
          f.disconnect(true)
          expect(await call('workspace_get', { workspaceId: f.workspaceId })).toMatchObject({
            executionLocation: read.executionLocation,
            locationValidation: { status: 'ready' },
          })
          f.disconnect(false)
          expect(await call('workspace_get', { workspaceId: f.workspaceId }))
            .toMatchObject({ locationValidation: { status: 'ready' } })
        }
        const genericList = await call('workspace_list', { limit: 100, detail: 'full' }) as { items: unknown[] }
        expect(genericList.items).toContainEqual(expect.objectContaining({
          workspace: expect.objectContaining({ id: f.workspaceId }),
          executionLocation: read.executionLocation, locationValidation: expect.objectContaining({ status: 'ready' }),
        }))
        expect(await f.createLocations().get(f.base.writer.principal, { workspaceId: f.workspaceId })).toEqual(read)
        expect(await f.createChoices().get(f.base.writer.principal, f.input)).toEqual(before)
        expect(await f.createProfiles().list(f.base.writer.principal, f.workspaceId)).toEqual(profiles)
        expect(await f.jobs.choices(f.base.writer.principal, f.workspaceId)).toEqual(jobsBefore)
        const main = await resolveLocalMainPlacement({ sql: f.base.db.pool, principal: f.base.writer.principal,
          mainId: policy.hostRef.mainId, workspaceId: f.workspaceId, configuration: f.base.f.configurations[0]!,
          roots: f.placement.policies, installations: f.placement.installations,
          qualificationSuites: { codex: 'codex-live-4' } })
        expect(main).toEqual(f.placement.local)
      }
      const reader = await f.base.access.issue({ name: 'Read-only location caller', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['workspaces:read', 'workspace_locations:read', 'source_roots:read'],
          scope: { workspaceIds: [f.workspaceId] } }] })
      const denied = await f.connect(reader.token)
      expect(decodeMcpToolResult((await denied.callTool({ name: 'workspace_get', arguments: { workspaceId: f.workspaceId } }))))
        .toMatchObject({ locationRevision: revision, locationValidation: { status: 'ready' } })
      const policy = f.originalPolicies.find(policy => policy.hostRef.kind === 'main')!
      const forbidden = await denied.callTool({ name: 'workspace_root_location_set', arguments: {
        workspaceId: f.workspaceId, commandId: randomUUID(), hostRef: policy.hostRef,
        allowedBaseId: policy.allowedBaseId, configurationRevision: policy.configurationRevision,
        relativePath: policy.relativePath, accessMode: policy.accessMode,
        expectedLocationRevision: revision, expectedRootPolicyRevision: 2,
      } })
      expect(forbidden.isError).toBe(true)
      const forbiddenChoices = await denied.callTool({ name: 'workflow_node_placement_choices', arguments: f.input })
      expect(forbiddenChoices.isError).toBe(true)
      const forbiddenJobs = await denied.callTool({
        name: 'job_choices_get', arguments: { workspaceId: f.workspaceId },
      })
      expect(forbiddenJobs.isError).toBe(true)
      expect(await f.createLocations().get(f.base.writer.principal, { workspaceId: f.workspaceId }))
        .toMatchObject({ locationRevision: revision })
      expect(await choices()).toEqual(before)
      expect(await jobChoices()).toEqual(jobsBefore)
      const deniedAudit = await f.base.db.pool.query<{ count: number }>(
        "select count(*)::int as count from management_audit where principal_id=$1 and outcome='denied'",
        [reader.principal.id],
      )
      expect(deniedAudit.rows[0]!.count).toBeGreaterThan(0)
      const savedMain = WorkspaceBoundLocationReadbackSchema.parse(await call('workspace_root_location_get', {
        workspaceId: f.workspaceId,
      }))
      if (savedMain.evidence !== 'bound') throw new Error('Expected the saved Main root binding.')
      expect(savedMain.binding).toMatchObject({
        rootPolicyId: policy.rootPolicyId, rootPolicyRevision: '2', hostRef: policy.hostRef,
      })
      await f.base.db.pool.query(`update workspace_root_policies set revoked_at=now()
        where root_policy_id=$1 and root_policy_revision=$2`, [policy.rootPolicyId, policy.rootPolicyRevision])
      expect(await call('workspace_get', { workspaceId: f.workspaceId })).toMatchObject({
        executionLocation: savedMain.executionLocation,
        locationRevision: revision, locationValidation: { status: 'ready' },
      })
      await f.base.db.pool.query(`update workspace_root_policies set revoked_at=now()
        where root_policy_id=$1 and root_policy_revision=$2`,
      [savedMain.binding.rootPolicyId, savedMain.binding.rootPolicyRevision])
      expect(await call('workspace_get', { workspaceId: f.workspaceId })).toMatchObject({
        executionLocation: savedMain.executionLocation,
        locationRevision: revision, locationValidation: { status: 'unavailable' },
      })
      const remaining = await choices()
      expect(remaining.choices).toHaveLength(2)
      const ready = remaining.choices.filter(choice => choice.availability === 'ready')
      expect(ready).toHaveLength(1)
      expect(ready[0]).toEqual(before.choices.find(choice => choice.placement.hostRef.kind === 'device'))
      expect(remaining.choices.find(choice => choice.placement.hostRef.kind === 'main')).toMatchObject({
        availability: 'unavailable', reason: expect.any(String),
        placement: { hostRef: policy.hostRef, rootPolicyId: policy.rootPolicyId,
          rootPolicyRevision: policy.rootPolicyRevision, source: f.placement.source,
          rootBinding: f.placement.local.rootBinding },
      })
      await expect(resolveLocalMainPlacement({
        sql: f.base.db.pool, principal: f.base.writer.principal, mainId: policy.hostRef.mainId,
        workspaceId: f.workspaceId, configuration: f.base.f.configurations[0]!,
        roots: f.placement.policies, installations: f.placement.installations,
        qualificationSuites: { codex: 'codex-live-4' },
      })).rejects.toMatchObject({ code: 'ROOT_POLICY_UNAVAILABLE' })
    } finally { await f.close() }
  }, 120_000)
})
