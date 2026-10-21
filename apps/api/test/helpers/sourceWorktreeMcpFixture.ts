import { randomUUID } from 'node:crypto'
import type { HarnessExecution } from '@foreman-code/contracts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, vi } from 'vitest'
import { HostHarnessOverrideSchema, HostHarnessProfileEvidenceSchema,
  type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { HarnessQualificationSchema } from '@foreman-code/contracts/harness-qualification'
import { CurrentWorkflowSaveResultSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import { buildApp } from '../../src/app.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../../src/modules/harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry, type HarnessInstallationRecord } from '../../src/modules/harnesses/installationRegistry.js'
import { harnessHostKey } from '../../src/modules/harnesses/instanceSettings/repository.js'
import { HarnessQualificationRepository } from '../../src/modules/harnesses/qualification/repository.js'
import { AgentPlacementProducer } from '../../src/modules/placement/agentProducer.js'
import { AgentExecutionPreparation } from '../../src/modules/placement/agentExecutionPreparation.js'
import { placedContinuationValidator } from '../../src/modules/placement/continuation.js'
import { readDispatchIntent, readExecutionPlacement, readNativePlacement } from '../../src/modules/placement/persistence.js'
import { RunPlacementReadService } from '../../src/modules/placement/readService.js'
import { readLiveManagementPrincipal } from '../../src/modules/access/liveManagementPrincipal.js'
import { interactionConnection } from '../../src/modules/interactions/connection.js'
import { credentialAuthority } from '../../src/modules/interactions/wave25/credentialAuthority.js'
import * as continuation from '../../src/modules/runs/continuation.js'
import { readRemoteObservations } from '../../src/modules/runs/remote/persistence.js'
import { RunManagementService } from '../../src/modules/runs/management.js'
import { createCurrentNativeProductionFactory } from '../../src/modules/runs/workflowProduction.js'
import { WorkerExecutionPolicy } from '../../src/modules/settings/workerExecution.js'
import * as gitWorktree from '../../src/modules/sources/gitWorktree.js'
import { createProductionSources } from '../../src/modules/sources/production.js'
import { qualifyApprovedRootAllowlist } from '../../src/modules/sources/rootAttestation.js'
import { sourceSha256 } from '../../src/modules/sources/manifest.js'
import { WorkspaceBoundLocationService } from '../../src/modules/workspace-roots/service.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { agentWorkflowNode } from './agentWorkflowFixture.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { gitFixtureEnvironment } from './gitFixture.js'
import { fixtureGit } from './workspaceRepository.js'

type Base = Awaited<ReturnType<typeof currentOperatorIntegration>>

/** Qualification and provider transport are fixture facts; source and placement writes use production services. */
async function harnessRegistry(base: Base, mainId: string, project: string) {
  const hostRef = { kind: 'main' as const, mainId }
  const fingerprint = 'a'.repeat(64)
  const installationId = 'fixture-codex'
  const target = { hostRef, applicationInstallationId: mainId,
    harnessInstallationId: installationId, installationFingerprint: fingerprint }
  const instances = new HarnessInstanceRegistry(localHarnessDrivers)
  const configurations: Parameters<HarnessInstanceRegistry['reload']>[0][number][] = []
  const overrides: HostHarnessOverride[] = []
  for (const configuration of base.f.configurations) {
    const override = HostHarnessOverrideSchema.parse({ instanceId: randomUUID(), revision: 1,
      instanceRevision: '1', target, presetId: 'codex', enabled: true, driverId: 'codex',
      configuration: configuration.harness, configurationFingerprint: fingerprint, qualification: 'qualified' })
    const proof = HostHarnessProfileEvidenceSchema.parse({ target, instanceRevision: '1',
      configurationFingerprint: fingerprint, driverId: 'codex', driverRevision: '1',
      protocolRevision: 'codex-native-adapter-v1', suiteRevision: 'codex-live-4',
      environmentGeneration: '1', connectionGeneration: '1', authenticated: true,
      compatible: true, qualified: true, checkedAt: base.f.createdAt })
    await base.db.pool.query(`insert into harness_instance_settings(instance_id,revision,host_key,
      application_installation_id,record,configuration_fingerprint,created_by)
      values($1,1,$2,$3,$4::jsonb,$5,$6)`, [override.instanceId, harnessHostKey(hostRef), mainId,
      JSON.stringify(override), fingerprint, base.writer.principal.id])
    await base.db.pool.query(`insert into harness_instance_profile_evidence
      (check_id,instance_id,instance_revision,record) values($1,$2,1,$3::jsonb)`,
    [randomUUID(), override.instanceId, JSON.stringify(proof)])
    configurations.push({ instanceId: override.instanceId, instanceRevision: '1',
      driverId: 'codex', enabled: true, configuration: configuration.harness })
    overrides.push(override)
  }
  instances.reload(configurations)
  const installations = new HarnessInstallationRegistry(instances)
  const installation: HarnessInstallationRecord = { hostRef, harnessInstallationId: installationId,
    installationFingerprint: fingerprint, driverId: 'codex', driverRevision: '1',
    protocolRevision: 'codex-native-adapter-v1', environmentGeneration: '1', connectionGeneration: '1',
    observedVersion: '0.156.1', installed: true, authenticated: null, compatible: null, qualified: null,
    launcher: { requested: '/fixture/codex', resolvedLauncher: '/fixture/codex', fingerprint,
      payloadFingerprints: [{ path: '/fixture/codex', fingerprint }], status: 'installed',
      interpreter: null, diagnostics: [], checkedAt: base.f.createdAt,
      environment: { generation: '1', provenance: 'worker', cwd: project, path: '/fixture' } } }
  installations.refresh([installation])
  const pinOverride = (value: HostHarnessOverride) => installations.pin({
    instanceId: value.instanceId, hostRef: value.target.hostRef,
    harnessInstallationId: value.target.harnessInstallationId, connectionGeneration: '1', environmentGeneration: '1' })
  const qualification = HarnessQualificationSchema.parse({ harness: 'codex', version: '0.156.1',
    binarySha256: fingerprint, suiteRevision: 'codex-live-4', profile: 'codex-0.156', status: 'qualified',
    checks: [{ id: 'fixture-provider', passed: true, detail: null }], failureReason: null,
    startedAt: base.f.createdAt, checkedAt: base.f.createdAt })
  await new HarnessQualificationRepository(base.db.pool).save(qualification, { qualificationIdentity: {
    schemaVersion: 1, selection: pinOverride(overrides[0]!).selection,
    driverRevision: installation.driverRevision, protocolRevision: installation.protocolRevision,
    suiteRevision: qualification.suiteRevision, environmentGeneration: installation.environmentGeneration,
    connectionGeneration: installation.connectionGeneration, launcher: installation.launcher.resolvedLauncher,
    payloadFingerprints: installation.launcher.payloadFingerprints,
  } })
  return { overrides, installations, pinOverride }
}

export async function sourceWorktreeMcpFixture(options: {
  approvalNodeIds?: string[]; fixture?: ReturnType<typeof makeCurrentWorkflowFixture>
  beforePrepareExecution?: (execution: HarnessExecution) => Promise<void>
} = {}) {
  let producer: AgentPlacementProducer
  let preparation: AgentExecutionPreparation
  let validatePlacement: ReturnType<typeof placedContinuationValidator>
  // The shared provider fixture composes unplaced continuation by default.
  const continuationSpy = vi.spyOn(continuation, 'continuationValidator').mockImplementation(
    () => (executionId, signal) => validatePlacement(executionId, signal))
  let base: Base
  try {
    base = await currentOperatorIntegration({
      fixture: makeCurrentWorkflowFixture(randomUUID(), 'sequential'), insertRun: false,
      ...options,
      admitPlacementExecutionLocked: async (sql, owner, run, execution, ref, inputDigest) => {
        await producer.admitExecution(sql, owner, execution, ref, inputDigest, run.authorizationPrincipalId)
      },
      preparePlacementExecution: async (owner, run, execution) => {
        await options.beforePrepareExecution?.(execution)
        return preparation.prepare(owner, run, execution)
      },
    })
  } finally {
    continuationSpy.mockRestore()
  }
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  let restoreGit: (() => void) | undefined
  try {
    const project = join(base.db.directory, 'project')
    const runtimeRoot = join(base.db.directory, 'runtime')
    await mkdir(project, { mode: 0o700 })
    await mkdir(runtimeRoot, { mode: 0o700 })
    fixtureGit(project, 'init', '--template=', '-q', '-b', 'main')
    await writeFile(join(project, 'app.txt'), 'approved source\n')
    fixtureGit(project, 'add', '.')
    fixtureGit(project, 'commit', '-qm', 'Source')
    const commit = fixtureGit(project, 'rev-parse', 'HEAD')
    const system = gitWorktree.systemGitWorktreePorts(gitFixtureEnvironment())
    const ports: gitWorktree.GitWorktreePorts = {
      cloneDirectory: () => join(base.db.directory, 'clone'),
      git: (args, options) => system.git([
        '-c', `url.${project}.insteadOf=https://github.com/fixture/project.git`, ...args,
      ], { ...options, env: { ...options.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }),
    }
    const gitSpy = vi.spyOn(gitWorktree, 'systemGitWorktreePorts').mockReturnValue(ports)
    restoreGit = () => gitSpy.mockRestore()
    const mainId = (await base.db.pool.query<{ id: string }>(
      'select id from application_installation where singleton=true')).rows[0]!.id
    const hostRef = { kind: 'main' as const, mainId }
    const allowlist = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef,
      applicationInstallationId: mainId, configurationRevision: '1',
      bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-only', 'read-write'] }],
      managedRuntimeRoot: runtimeRoot })
    await writeFile(join(runtimeRoot, 'approved-roots.json'), JSON.stringify(allowlist), { mode: 0o600 })
    const production = await createProductionSources({ pool: base.db.pool, commands: base.commands,
      locations: base.locations, mainId, runtimeRoot,
      endpoint: () => { throw new Error('Main source preparation cannot call a remote endpoint') },
      dispatch: () => { throw new Error('Agent source preparation cannot create a Job') } })
    await withTransaction(base.db.pool, async sql => {
      await production.policies.publishApprovedHostConfiguration(sql, allowlist, { mainId, hostRef,
        applicationInstallationId: mainId, configurationRevision: '1',
        configurationDigest: sourceSha256(Buffer.from(JSON.stringify(allowlist))) })
    })
    base.locations.setRootPolicies(production.policies)
    const roots = new WorkspaceBoundLocationService(base.db.pool, base.commands, production.policies,
      base.locations.runnerId)
    const located = (await roots.set(base.writer.principal, 'mcp', { workspaceId: base.f.scope.workspaceId,
      commandId: randomUUID(), hostRef, allowedBaseId: allowlist.bases[0]!.baseId,
      configurationRevision: '1', relativePath: '', accessMode: 'read-write',
      expectedLocationRevision: 1, expectedRootPolicyRevision: 0 })).value
    if (located.evidence !== 'bound') throw new Error('Expected a persisted workspace root')
    const policy = located.binding
    const workspace = await base.services.workspaces.get(base.writer.principal, base.f.scope.workspaceId)
    await base.services.workspaces.update(base.writer.principal, 'mcp', {
      workspaceId: base.f.scope.workspaceId, commandId: randomUUID(), expectedRevision: workspace.revision,
      repository: { provider: 'github', owner: 'fixture', name: 'project', defaultBranch: 'main' },
    })
    const approved = (await production.sources.approve(base.writer.principal, 'mcp', {
      workspaceId: base.f.scope.workspaceId, commandId: randomUUID(), expectedLocationRevision: located.locationRevision,
      commit, executablePolicy: 'strip',
    })).value
    const source = { approvedSourceId: approved.manifest.approvedSourceId,
      snapshotId: approved.manifest.snapshotId, manifestDigest: approved.manifest.manifestDigest }
    const selection = { hostRef, rootPolicyId: policy.rootPolicyId,
      rootPolicyRevision: policy.rootPolicyRevision, locationRevision: policy.locationRevision }
    const root = (await production.sources.bindRoot(base.writer.principal, 'mcp', {
      workspaceId: base.f.scope.workspaceId, commandId: randomUUID(), source, selection,
      expectedBindingRevision: 0, accessMode: 'exclusive-write',
    })).value
    const registry = await harnessRegistry(base, mainId, project)
    const workerExecution = new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' })
    producer = new AgentPlacementProducer(base.db.pool, mainId, production.sources, production.policies,
      registry, { codex: 'codex-live-4' }, workerExecution)
    preparation = new AgentExecutionPreparation(production.sources, producer)
    validatePlacement = placedContinuationValidator(base.db.pool, base.locations, {
      async prepare(executionId) {
        const sql = interactionConnection.getStore() ?? base.db.pool
        const placement = await readExecutionPlacement(sql, executionId)
        if (!placement) return null
        const intent = await readDispatchIntent(sql, executionId)
        if (!intent) throw new Error('Accepted Agent placement requires its dispatch intent')
        const executionPlacement = await readNativePlacement(sql, executionId)
        if (!executionPlacement) throw new Error('Accepted Agent placement requires native preparation')
        return { placement, intent, executionPlacement }
      },
    }, {
      async assertCurrent(binding, signal) {
        const sql = interactionConnection.getStore() ?? base.db.pool
        const run = await base.runs.get(binding.intent.runId)
        if (!run) throw new Error('Accepted Agent placement requires its Run')
        const current = await credentialAuthority(sql, binding.intent.executionId, 'workflow')
        await producer.assertPinsCurrent(sql, binding.placement,
          await readLiveManagementPrincipal(sql, run.authorizationPrincipalId), run.workspaceId,
          current.nativeSessionId ? { purpose: 'resident' } : undefined)
        signal?.throwIfAborted()
      },
    })
    const workflows = new WorkflowManagementService(base.db.pool, base.commands, { worktrees: {
      readyRoot: async () => ({ rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision }),
      sources: production.sources, roots: production.policies,
    } })
    const binding = createCurrentNativeProductionFactory({ isRuntimeOpen: () => true,
      reportDispatchFailure: (_id, code) => base.dispatchErrors.push(code),
    })({ primaryPool: base.db.pool, commands: base.commands, runs: base.runs, workflows: base.workflows,
      locations: base.locations, engine: base.engine, nativeExecutions: base.native,
      interactions: base.service, checkpointer: base.checkpointer })
    const runs = new RunManagementService(base.db.pool, base.commands, base.runs, base.engine, base.locations, {
      ...binding, startPublication: { ...binding.startPublication, placementAdmission: producer, workerExecution },
    })
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access: base.access, services: { ...base.services, runs, workflows, sources: production.sources,
        workspaceRoots: roots, runPlacements: new RunPlacementReadService(base.db.pool, readRemoteObservations) } } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'source-worktree', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(base.writer.token)
    const workflow = await workflows.get(base.writer.principal, base.f.scope.workspaceId, base.f.scope.workflowId)
    const graph = structuredClone(base.f.version.definition)
    for (const node of graph.nodes) {
      const instance = registry.overrides[base.f.configurations.findIndex(item => item.agentId === node.agentId)]!
      agentWorkflowNode(node).placement = { schemaVersion: 1, ...selection, projectRoot: project,
        cwdPolicy: 'project-root', relativeCwd: '', instanceId: instance.instanceId,
        instanceRevision: instance.instanceRevision, harnessInstallationId: instance.target.harnessInstallationId,
        source, rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision } }
    }
    const savedResponse = await client.callTool({ name: 'workflow_save_v3', arguments: {
      workspaceId: base.f.scope.workspaceId, workflowId: base.f.scope.workflowId, commandId: randomUUID(),
      executionSemanticsVersion: 3, expectedRevision: workflow.revision,
      expectedWorkflowVersionId: base.f.version.id,
      expectedAgentConfigurationVersionIds: base.f.version.agentConfigurationVersionIds, graph,
    } })
    expect(savedResponse.isError, JSON.stringify(savedResponse)).not.toBe(true)
    const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(savedResponse)).value
    return { base, app, client, connect, source, root, production, saved, input: {
      workspaceId: base.f.scope.workspaceId, workflowId: base.f.scope.workflowId,
      workflowVersionId: saved.currentVersionId, executionSemanticsVersion: 3,
      expectedWorkflowRevision: saved.revision, expectedLocationRevision: located.locationRevision,
      expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds, input: {},
    }, async close() {
      await Promise.allSettled(clients.map(client => client.close()))
      await app!.close()
      try {
        await base.close()
      } finally {
        restoreGit?.()
      }
    } }
  } catch (error) {
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    try {
      await base.close()
    } finally {
      restoreGit?.()
    }
    throw error
  }
}
