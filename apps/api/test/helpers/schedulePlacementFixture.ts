import { randomUUID } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScheduleConfiguration } from '@foreman-code/contracts/schedules'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import { assertDeviceHostInstallation } from '../../src/modules/devices/hostAuthorization.js'
import { AgentPlacementProducer } from '../../src/modules/placement/agentProducer.js'
import { PostgresWorkspaceRootPolicies } from '../../src/modules/sources/rootPolicies.js'
import { InstalledWorkspaceRootHosts, type RootWorkerClient } from '../../src/modules/sources/rootHosts.js'
import { RegisteredWorkspaceSourceRoots } from '../../src/modules/sources/registeredSourceRoots.js'
import { qualifyApprovedRootAllowlist } from '../../src/modules/sources/rootAttestation.js'
import { PostgresSourceService } from '../../src/modules/sources/service.js'
import { PrivateSourceSnapshotStore } from '../../src/modules/sources/store.js'
import { qualifiedGit } from '../../src/modules/sources/capture.js'
import { sourceSha256 } from '../../src/modules/sources/manifest.js'
import { WorkspaceBoundLocationService } from '../../src/modules/workspace-roots/service.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { sch11Actions, type Sch11Fixture } from './sch11Fixture.js'
import { sch11Once } from './sch11ClockCases.js'
import { scheduleHarnessFixture } from './scheduleHarnessFixture.js'

/** Admission uses persisted authorities and physical host discovery. */
export async function schedulePlacementFixture(f: Sch11Fixture) {
  const pool = f.database.pool
  const mainId = (await pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
  const hostRef = { kind: 'main' as const, mainId }
  const writer = await f.access.issue({ name: 'Schedule placement owner', audience: 'operator',
    expiresAt: new Date(Date.now() + 3_600_000), grants: [
      { actions: [...sch11Actions, 'sources:read', 'sources:approve', 'source_roots:read', 'source_roots:bind',
        'workspace_locations:update', 'workspace_locations:validate'], scope: { workspaceIds: [f.scope.workspaceId] } },
      { actions: ['harnesses:read', 'harnesses:update'], scope: {} },
    ] })
  const location = f.fixture.run.executionLocation
  if (!location) throw new Error('Schedule placement fixture requires an execution location.')
  const project = location.rootPath
  const canonical = join(f.database.directory, `schedule-source-${randomUUID()}`)
  await mkdir(canonical, { mode: 0o700 })
  await chmod(f.runtimeRoot, 0o700)
  await qualifiedGit(project, ['init', '--template='])
  await writeFile(join(project, 'source.ts'), 'export const scheduled = true\n')
  await qualifiedGit(project, ['add', 'source.ts'])
  await qualifiedGit(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source'])
  const commit = (await qualifiedGit(project, ['rev-parse', 'HEAD'])).toString().trim()
  const allowlist = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef, applicationInstallationId: mainId,
    configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: project,
      accessModes: ['read-only', 'read-write'] }], managedRuntimeRoot: f.runtimeRoot })
  const unused = async (): Promise<never> => { throw new Error('Scheduled Start admission does not execute a provider.') }
  let rootWorker: RootWorkerClient = { request: unused }
  const createAuthorities = () => {
    const hosts = new InstalledWorkspaceRootHosts(allowlist,
      async (sql, _principal, host, installationId) => {
        const registration = await assertDeviceHostInstallation(sql, host, installationId)
        return registration ? { workerInstallationId: registration.workerInstallationId,
          keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision } : null
      }, { request: (...args) => rootWorker.request(...args) })
    const policies = new PostgresWorkspaceRootPolicies(mainId, hosts)
    const sources = new PostgresSourceService(pool, f.commands, f.locations, new PrivateSourceSnapshotStore(canonical),
      mainId, new RegisteredWorkspaceSourceRoots(policies, hosts),
      { authorize: unused, prepare: unused, verifyWorkingDirectory: unused, verify: unused,
        releaseClaim: unused, authorizeFinal: unused }, { confirmedClosed: unused })
    return { policies, sources }
  }
  let authorities = createAuthorities()
  const publishConfiguration = async (configurationRevision: string) => withTransaction(pool, sql => {
    const configuration = { ...allowlist, configurationRevision }
    return authorities.policies.publishApprovedHostConfiguration(sql, configuration, { mainId, hostRef,
      applicationInstallationId: mainId, configurationRevision,
      configurationDigest: sourceSha256(Buffer.from(JSON.stringify(configuration))) })
  })
  await publishConfiguration('1')
  const locations = new WorkspaceBoundLocationService(pool, f.commands, authorities.policies, f.locations.runnerId)
  const bound = (await locations.set(writer.principal, 'http', { workspaceId: f.scope.workspaceId,
    commandId: randomUUID(), hostRef, allowedBaseId: allowlist.bases[0]!.baseId, configurationRevision: '1',
    relativePath: '', accessMode: 'read-write', expectedLocationRevision: 1, expectedRootPolicyRevision: 0 })).value
  if (bound.evidence !== 'bound') throw new Error('Expected a persisted workspace root policy.')
  const policy = bound.binding
  const approved = (await authorities.sources.approve(writer.principal, 'http', { workspaceId: f.scope.workspaceId,
    commandId: randomUUID(), expectedLocationRevision: bound.locationRevision, commit,
    executablePolicy: 'strip' })).value
  const source = { approvedSourceId: approved.manifest.approvedSourceId, snapshotId: approved.manifest.snapshotId,
    manifestDigest: approved.manifest.manifestDigest }
  const selection = { hostRef, rootPolicyId: policy.rootPolicyId,
    rootPolicyRevision: policy.rootPolicyRevision, locationRevision: policy.locationRevision }
  const root = (await authorities.sources.bindRoot(writer.principal, 'http', { workspaceId: f.scope.workspaceId,
    commandId: randomUUID(), source, selection, expectedBindingRevision: 0, accessMode: 'exclusive-write' })).value
  const harness = await scheduleHarnessFixture(f, mainId, writer.principal)
  f.workflows = new WorkflowManagementService(pool, f.commands, { worktrees: {
    readyRoot: async () => ({ rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision }),
    get sources() { return authorities.sources },
    get roots() { return authorities.policies },
  } })
  const workflow = await f.workflows.get(writer.principal, f.scope.workspaceId, f.scope.workflowId)
  const graph = structuredClone(f.fixture.version.definition)
  for (const node of graph.nodes) {
    const configurationIndex = f.fixture.configurations.findIndex(item => item.agentId === node.agentId)
    const instance = harness.settings[configurationIndex]!
    node.placement = { schemaVersion: 1, ...selection, projectRoot: policy.canonicalProjectRoot,
      cwdPolicy: 'project-root', relativeCwd: '', instanceId: instance.instanceId,
      instanceRevision: instance.instanceRevision, harnessInstallationId: instance.target.harnessInstallationId,
      source, rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision } }
  }
  await f.workflows.current.save(writer.principal, 'http', { ...f.scope, commandId: randomUUID(),
    executionSemanticsVersion: 3, expectedRevision: workflow.revision,
    expectedWorkflowVersionId: f.fixture.version.id,
    expectedAgentConfigurationVersionIds: f.fixture.version.agentConfigurationVersionIds, graph })
  const producer = () => new AgentPlacementProducer(pool, mainId, authorities.sources, authorities.policies,
    harness.registry, harness.suites)
  return {
    writer, source, root, policy, harness, allowlist,
    get policies() { return authorities.policies },
    connectRootWorker: (worker: RootWorkerClient) => { rootWorker = worker },
    get sources() { return authorities.sources },
    get producer() { return producer() },
    save: async (schedule: ScheduleConfiguration = sch11Once) =>
      (await f.service.save(writer.principal, 'http', { ...f.command(0), schedule })).value,
    changeInstance: () => harness.changeInstance(),
    changeHostConfiguration: () => publishConfiguration('2'),
    restart: () => { authorities = createAuthorities(); harness.restart() },
    recover: () => harness.recover(),
  }
}
