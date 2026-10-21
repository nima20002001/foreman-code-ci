import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { DeviceApplicationRequestOptions } from '../../src/modules/devices/deviceApplicationChannel.js'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { NodePlacementChoicesResultSchema } from '@foreman-code/contracts/placement-readback'
import { SourceRootListResultSchema } from '@foreman-code/contracts/source-admission'
import type { WorkspaceRootPolicy } from '@foreman-code/contracts/workspace-root-policies'
import { expect } from 'vitest'
import { buildApp } from '../../src/app.js'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import type { DeviceEndpoint } from '../../src/modules/devices/deviceEndpoint.js'
import { HostHarnessProfileEvidenceRepository } from '../../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HarnessInstanceSettingsRepository } from '../../src/modules/harnesses/instanceSettings/repository.js'
import { ProductionCiEnrollmentInventory } from '../../src/modules/jobs/ciEnrollmentInventory.js'
import { ProductionPlacementChoiceDiscovery } from '../../src/modules/placement/choiceDiscovery.js'
import { NodePlacementChoicesService } from '../../src/modules/placement/choicesService.js'
import { WorkerExecutionPolicy } from '../../src/modules/settings/workerExecution.js'
import { createProductionRootPolicies } from '../../src/modules/sources/productionRootAuthority.js'
import { PostgresSourceService } from '../../src/modules/sources/service.js'
import { PrivateSourceSnapshotStore } from '../../src/modules/sources/store.js'
import { ManagedWorkspaceRootService } from '../../src/modules/workspace-roots/managedRoot.js'
import { WorkspaceBoundLocationService } from '../../src/modules/workspace-roots/service.js'
import { agentWorkflowNode } from './agentWorkflowFixture.js'
import { fixture } from './nodePlacementStartFixture.js'
import { expectMcpAccessDenied } from './deniedMcpTool.js'

/** Root provisioning uses the production authorities; the device request boundary supplies filesystem replies. */
export async function placementDiscoveryFixture(options: {
  deviceCount?: 1 | 2
  mainOnlyWorkflow?: boolean
  missingWorkerRoot?: boolean
  missingWorkerPolicy?: boolean
  configurationRequest?: (payload: unknown, options: DeviceApplicationRequestOptions | undefined,
    binding: DeviceSessionBinding) => Promise<DeviceApplicationResult>
  ensureComputerReady?: (host: CanonicalMachineReference) => Promise<void>
} = {}) {
  const native = await fixture({ gitSource: true, deviceCount: options.deviceCount ?? 1,
    unboundFirstDeviceSource: options.missingWorkerRoot ?? false,
    unconfiguredFirstDeviceRoot: options.missingWorkerPolicy ?? false })
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  try {
    if (options.mainOnlyWorkflow || options.missingWorkerRoot || options.missingWorkerPolicy) {
      const node = agentWorkflowNode(native.saveInput.graph.nodes[0])
      native.saveInput.graph.nodes = [node]
      native.saveInput.graph.edges = []
      native.saveInput.expectedAgentConfigurationVersionIds = {
        [node.agentId]: native.saveInput.expectedAgentConfigurationVersionIds[node.agentId]!,
      }
    }
    const saved = await native.save('mcp')
    const input = { workspaceId: saved.version.workspaceId, workflowId: saved.workflowId,
      nodeId: saved.version.definition.nodes[0]!.id,
      agentConfigurationVersionId: native.base.f.configurations[0]!.id }
    const pool = native.base.db.pool
    const state = { disconnected: false, rootFailure: undefined as Error | undefined }
    const profiles = new HarnessInstanceSettingsRepository(pool)
    const evidence = new HostHarnessProfileEvidenceRepository(pool)
    const worker = (await profiles.list(native.placement.remote.hostRef,
      (await pool.query<{ worker_installation_id: string }>('select worker_installation_id from device_registrations where id=$1',
        [native.placement.remote.hostRef.kind === 'device' ? native.placement.remote.hostRef.deviceId : ''])).rows[0]!
        .worker_installation_id))[0]!
    if (worker.target.hostRef.kind !== 'device') throw new Error('Expected a Worker profile')
    const registration: DeviceSessionBinding = { mainId: worker.target.hostRef.mainId,
      deviceId: worker.target.hostRef.deviceId, bootId: randomUUID(), connectionEpoch: randomUUID(),
      connectionGeneration: 1,
      workerInstallationId: worker.target.applicationInstallationId, keyRevision: 1, authorizationRevision: 1 }
    const endpoint = {
      currentBinding: () => state.disconnected ? null : registration,
      captureRequest: () => options.configurationRequest ? { binding: registration,
        request: (payload: unknown, requestOptions?: DeviceApplicationRequestOptions) =>
          options.configurationRequest!(payload, requestOptions, registration),
      } : undefined,
      request: async (_deviceId: string, _namespace: string, request: { policy: WorkspaceRootPolicy }) => {
        if (state.rootFailure) throw state.rootFailure
        return { payload: await native.placement.hosts.sourceNamespace(request.policy, request.policy.rootPolicyId) }
      },
    } as unknown as DeviceEndpoint
    const rootServices = createProductionRootPolicies({ pool, mainId: registration.mainId,
      runtimeRoot: native.base.db.directory, endpoint: () => endpoint })
    const unused = async (): Promise<never> => { throw new Error('No source execution in discovery') }
    const sources = new PostgresSourceService(pool, native.base.commands, native.base.locations,
      new PrivateSourceSnapshotStore(join(native.base.db.directory, 'discovery-snapshots')),
      registration.mainId, rootServices.roots,
      { authorize: unused, prepare: unused, verify: unused, verifyWorkingDirectory: unused,
        releaseClaim: unused, authorizeFinal: unused }, { confirmedClosed: unused })
    const locations = new WorkspaceBoundLocationService(pool, native.base.commands, rootServices.policies)
    const inventory = new ProductionCiEnrollmentInventory(pool, sources, () => endpoint, () => undefined,
      new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }),
      new ManagedWorkspaceRootService(native.base.commands, locations, rootServices.policies))
    const discovery = new ProductionPlacementChoiceDiscovery(pool, () => ({
      roots: rootServices.policies, sources, profiles,
      registry: { installations: native.placement.installations,
        profileEvidence: (profile, sql) => evidence.latest(profile.instanceId, profile.revision, sql) },
      provisionRoot: (...args: Parameters<ProductionCiEnrollmentInventory['root']>) => inventory.root(...args),
      ...(options.ensureComputerReady ? { ensureComputerReady: options.ensureComputerReady } : {}),
    }))
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access: native.base.access, services: { ...native.services, sources,
        placementChoices: new NodePlacementChoicesService(pool, discovery) } },
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'discovery-isolation', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const owner = await connect(native.base.writer.token)
    const path = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}`
      + `/nodes/${input.nodeId}/placement-choices?agentConfigurationVersionId=${input.agentConfigurationVersionId}`
    async function read(via: 'http' | 'mcp') {
      if (via === 'http') {
        const response = await app!.inject({ method: 'GET', url: path, headers: native.headers })
        expect(response.statusCode, response.body).toBe(200)
        return NodePlacementChoicesResultSchema.parse(response.json())
      }
      const result = await owner.callTool({ name: 'workflow_node_placement_choices', arguments: input })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return NodePlacementChoicesResultSchema.parse(decodeMcpToolResult(result))
    }
    return { native, saved, pool, input, state, worker, read, owner, app,
      async roots() {
        return SourceRootListResultSchema.parse(decodeMcpToolResult(await owner.callTool({
          name: 'source_root_list', arguments: { workspaceId: input.workspaceId } })))
      },
      async addMatchingWorkerProfile() {
        const duplicate = { ...worker, instanceId: randomUUID() }
        const proof = (await evidence.latest(worker.instanceId, worker.revision))!
        await withTransaction(pool, async sql => {
          await profiles.append(sql, native.base.writer.principal.id, 0, duplicate)
          await evidence.append(sql, randomUUID(), duplicate, proof)
        })
      },
      async expectDenied() {
        const denied = await native.base.access.issue({ name: 'Unrelated reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 120_000), grants: [{ actions: ['workflows:read'],
            scope: { workspaceIds: [input.workspaceId], workflowIds: [randomUUID()] } }] })
        await expectMcpAccessDenied((await connect(denied.token)).callTool({
          name: 'workflow_node_placement_choices', arguments: input }))
        expect((await app!.inject({ method: 'GET', url: path,
          headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
      },
      async close() {
        await Promise.allSettled(clients.map(client => client.close()))
        await app!.close()
        await native.close()
      },
    }
  } catch (error) {
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    await native.close()
    throw error
  }
}
