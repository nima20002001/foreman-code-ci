import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { NodePlacementChoicesResultSchema } from '@foreman-code/contracts/placement-readback'
import { SourceRootListResultSchema } from '@foreman-code/contracts/source-admission'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { ProductionCiEnrollmentInventory } from '../src/modules/jobs/ciEnrollmentInventory.js'
import { ProductionPlacementChoiceDiscovery } from '../src/modules/placement/choiceDiscovery.js'
import { NodePlacementChoicesService } from '../src/modules/placement/choicesService.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { requireWorkerBundleReady, workerBundleErrorMessage } from '../src/modules/computers/workerBundleReadiness.js'
import { ManagedWorkspaceRootService } from '../src/modules/workspace-roots/managedRoot.js'
import { WorkspaceBoundLocationService } from '../src/modules/workspace-roots/service.js'
import { fixture, toolError } from './helpers/nodePlacementStartFixture.js'
import { workerBundleReadinessFixture } from './helpers/workerBundleReadinessFixture.js'

it.each(['http', 'mcp'] as const)('keeps Main choices with remote execution disabled through %s', async via => {
  await checkChoices(via, 'disabled')
}, 120_000)

it.each(['http', 'mcp'] as const)('marks outdated Worker choices unavailable through %s', async via => {
  await checkChoices(via, 'outdated')
}, 120_000)

it.each(['http', 'mcp'] as const)('marks updating Worker choices unavailable through %s', async via => {
  await checkChoices(via, 'updating')
}, 120_000)

async function checkChoices(via: 'http' | 'mcp', condition: 'disabled' | 'outdated' | 'updating') {
  const f = await fixture({ gitSource: true })
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const saved = await f.save('mcp')
    const input = { workspaceId: saved.version.workspaceId, workflowId: saved.workflowId,
      nodeId: saved.version.definition.nodes[0]!.id,
      agentConfigurationVersionId: f.base.f.configurations[0]!.id }
    const pool = f.base.db.pool
    const bundle = workerBundleReadinessFixture()
    bundle.worker.contentSha256 = 'c'.repeat(64)
    if (condition === 'updating') bundle.worker.state = 'installing'
    const workerExecution = new WorkerExecutionPolicy({ enabled: condition !== 'disabled', managedBy: 'startup' })
    const workspaceRoots = new WorkspaceBoundLocationService(pool, f.base.commands, f.placement.policies)
    const inventory = new ProductionCiEnrollmentInventory(pool, f.placement.sources,
      () => { throw new Error('Existing root discovery needs no device transport') }, () => undefined,
      workerExecution, new ManagedWorkspaceRootService(f.base.commands, workspaceRoots, f.placement.policies))
    const evidence = new HostHarnessProfileEvidenceRepository(pool)
    const discovery = new ProductionPlacementChoiceDiscovery(pool, () => ({
      roots: f.placement.policies, sources: f.placement.sources,
      profiles: new HarnessInstanceSettingsRepository(pool),
      registry: { installations: f.placement.installations,
        profileEvidence: (profile, sql) => evidence.latest(profile.instanceId, profile.revision, sql) },
      provisionRoot: (...args: Parameters<ProductionCiEnrollmentInventory['root']>) => inventory.root(...args),
      ensureComputerReady: async (host: { kind: 'main' | 'device' }) => {
        workerExecution.requireEnabled(host)
        if (host.kind === 'device') requireWorkerBundleReady(bundle.read())
      },
    }))
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access: f.base.access, services: { ...f.base.services, sources: f.placement.sources,
        placementChoices: new NodePlacementChoicesService(pool, discovery) } },
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'placement-readiness', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const owner = await connect(f.base.writer.token)
    const rootsBefore = SourceRootListResultSchema.parse(decodeMcpToolResult(await owner.callTool({
      name: 'source_root_list', arguments: { workspaceId: input.workspaceId } })))
    const path = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}`
      + `/nodes/${input.nodeId}/placement-choices?agentConfigurationVersionId=${input.agentConfigurationVersionId}`
    async function read() {
      if (via === 'http') {
        const response = await app!.inject({ method: 'GET', url: path, headers: f.headers })
        expect(response.statusCode, response.body).toBe(200)
        return NodePlacementChoicesResultSchema.parse(response.json())
      }
      const response = await owner.callTool({ name: 'workflow_node_placement_choices', arguments: input })
      expect(response.isError, JSON.stringify(response)).not.toBe(true)
      return NodePlacementChoicesResultSchema.parse(decodeMcpToolResult(response))
    }
    const result = await read()
    expect(result.pending).toBe(false)
    expect(result.choices).toHaveLength(2)
    expect(result.choices).toContainEqual(expect.objectContaining({ availability: 'ready', reason: null,
      placement: expect.objectContaining({ hostRef: f.placement.local.hostRef }) }))
    const reason = condition === 'disabled'
      ? 'Execution on connected computers is disabled. Ask the Operator to update remote execution settings on Main.'
      : workerBundleErrorMessage(bundle.read())
    expect(result.choices).toContainEqual(expect.objectContaining({ availability: 'unavailable', reason,
      placement: expect.objectContaining({ hostRef: f.placement.remote.hostRef }) }))
    expect(await read()).toEqual(result)
    const rootsAfter = await owner.callTool({ name: 'source_root_list', arguments: { workspaceId: input.workspaceId } })
    expect(SourceRootListResultSchema.parse(decodeMcpToolResult(rootsAfter))).toEqual(rootsBefore)

    const denied = await f.base.access.issue({ name: 'Unrelated workflow reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 120_000), grants: [{ actions: ['workflows:read'],
        scope: { workspaceIds: [input.workspaceId], workflowIds: [randomUUID()] } }] })
    const deniedClient = await connect(denied.token)
    expect(toolError(await deniedClient.callTool({ name: 'workflow_node_placement_choices', arguments: input })))
      .toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    expect((await app.inject({ method: 'GET', url: path,
      headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)

    workerExecution.apply({ enabled: true, managedBy: 'startup' })
    bundle.worker.contentSha256 = bundle.expected.contentSha256
    bundle.worker.state = 'current'
    const recovered = await read()
    expect(recovered.choices).toHaveLength(2)
    expect(recovered.choices.map(choice => choice.id)).toEqual(result.choices.map(choice => choice.id))
    expect(recovered.choices.every(choice => choice.availability === 'ready' && choice.reason === null)).toBe(true)
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    await f.close()
  }
}
