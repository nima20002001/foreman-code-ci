import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ApprovedRootAllowlistSchema, type ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { makeCurrentWorkflowFixture, CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HostHarnessProfileEvidenceSchema } from '@foreman-code/contracts/harness-registry'
import { sourceSha256 } from '../../src/modules/sources/manifest.js'
import { type ManagementAction } from '@foreman-code/contracts/management'
import { buildApp } from '../../src/app.js'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import { HarnessInstanceSettingsRepository } from '../../src/modules/harnesses/instanceSettings/repository.js'
import { ProductionCiEnrollmentInventory } from '../../src/modules/jobs/ciEnrollmentInventory.js'
import { ProductionPlacementChoiceDiscovery } from '../../src/modules/placement/choiceDiscovery.js'
import { NodePlacementChoicesService } from '../../src/modules/placement/choicesService.js'
import { placementChoiceRequirements } from '../../src/modules/placement/choicesService.js'
import { WorkerExecutionPolicy } from '../../src/modules/settings/workerExecution.js'
import { rootAttestationDigest, rootSelectionDigest } from '../../src/modules/sources/rootAttestation.js'
import type { AuthorizedWorkspaceRoot } from '../../src/modules/sources/rootPolicyPorts.js'
import { ManagedWorkspaceRootService } from '../../src/modules/workspace-roots/managedRoot.js'
import { WorkspaceBoundLocationService } from '../../src/modules/workspace-roots/service.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { mixedComputerPlacement } from './mixedComputerPlacement.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { removeFixtureDirectory } from './testResources.js'

export async function pairedAgentRootsFixture(options: { managedBase?: boolean } = {}) {
  const base = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'sequential') })
  const directory = await privateFixtureDirectory('paired-agent-roots-')
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const placement = await mixedComputerPlacement(base, directory, { unconfiguredDeviceRoot: true })
    const pool = base.db.pool
    const configurations = (await pool.query<{ record: unknown }>(
      'select record from workspace_root_host_configurations',
    )).rows.map(row => ApprovedRootAllowlistSchema.parse(row.record))
    const device = configurations.find(value => value.hostRef.kind === 'device')!
    if (options.managedBase === false) {
      device.configurationRevision = '2'
      delete device.bases[0]!.managedBy
      await withTransaction(pool, sql => placement.policies.publishApprovedHostConfiguration(sql, device, {
        mainId: device.hostRef.mainId, hostRef: device.hostRef,
        applicationInstallationId: device.applicationInstallationId, configurationRevision: '2',
        configurationDigest: sourceSha256(Buffer.from(JSON.stringify(device))),
      }))
    }
    const prepared: AuthorizedWorkspaceRoot[] = []
    function attest(root: AuthorizedWorkspaceRoot) {
      const facts = { schemaVersion: 1 as const, attestationId: randomUUID(),
        requestDigest: rootSelectionDigest(root.selection), hostRef: root.selection.hostRef,
        applicationInstallationId: root.allowlist.applicationInstallationId,
        configurationRevision: root.selection.configurationRevision, allowedBaseId: root.selection.allowedBaseId,
        relativePath: root.selection.relativePath, accessMode: root.selection.accessMode,
        canonicalProjectRoot: join(root.allowlist.bases[0]!.canonicalPath, root.selection.relativePath),
        filesystem: root.allowlist.bases[0]!.filesystem, directoryIdentityHash: 'a'.repeat(64),
        managedRuntimeRoot: root.allowlist.managedRuntimeRoot, runtimeFilesystem: root.allowlist.runtimeFilesystem }
      return { ...facts, attestationDigest: rootAttestationDigest(facts) }
    }
    // Only the paired Worker filesystem/carrier and harness qualification are fixtures.
    Object.assign(placement.hosts, {
      configurations: async () => configurations,
      configuration: async (_sql: unknown, host: ApprovedRootAllowlist['hostRef']) =>
        configurations.find(value => value.hostRef.kind === host.kind)!,
      attest: async (root: AuthorizedWorkspaceRoot) => attest(root),
      prepareManaged: async (root: AuthorizedWorkspaceRoot) => {
        prepared.push(root)
        return attest(root)
      },
    })
    const workspaceRoots = new WorkspaceBoundLocationService(pool, base.commands, placement.policies)
    const noCarrier = (): never => { throw new Error('No native Worker execution in this fixture') }
    const inventory = new ProductionCiEnrollmentInventory(pool, placement.sources, noCarrier, () => undefined,
      new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }),
      new ManagedWorkspaceRootService(base.commands, workspaceRoots, placement.policies))
    const discoveryServices = {
      roots: placement.policies, sources: placement.sources,
      profiles: new HarnessInstanceSettingsRepository(pool),
      registry: { installations: placement.installations, profileEvidence: async () => {
        const row = (await pool.query<{ record: unknown }>('select record from harness_instance_profile_evidence limit 1')).rows[0]!
        return HostHarnessProfileEvidenceSchema.parse(row.record)
      } },
      provisionRoot: inventory.root.bind(inventory),
    }
    const discovery = new ProductionPlacementChoiceDiscovery(pool, () => discoveryServices)
    const saveInput = await base.create()
    const response = await base.client.callTool({ name: 'workflow_save_v3', arguments: saveInput })
    const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(response)).value
    const input = { workspaceId: saveInput.workspaceId, workflowId: saveInput.workflowId,
      nodeId: saved.version.definition.nodes[1]!.id,
      agentConfigurationVersionId: base.f.configurations[1]!.id }
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access: base.access, services: { ...base.services, sources: placement.sources, workspaceRoots,
        placementChoices: new NodePlacementChoicesService(pool, discovery) } },
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token = base.writer.token) {
      const client = new Client({ name: 'paired-agent-roots', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    async function reader(actions: ManagementAction[] = placementChoiceRequirements.map(value => value.action)) {
      return base.access.issue({ name: 'Placement reader', audience: 'operator',
        grants: [{ actions, scope: {} }] })
    }
    return { base, placement, workspaceRoots, prepared, device, input, app, connect, reader,
      headers: { authorization: `Bearer ${base.writer.token}` },
      async close() {
        await Promise.allSettled(clients.map(client => client.close()))
        await app!.close()
        await base.close()
        await removeFixtureDirectory(directory)
      },
    }
  } catch (error) {
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    await base.close()
    await removeFixtureDirectory(directory)
    throw error
  }
}
