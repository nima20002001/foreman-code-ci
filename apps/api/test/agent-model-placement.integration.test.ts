import { createHash, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { AgentMutationResultSchema, ManagedAgentDetailSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HostHarnessOverrideSaveResultSchema, HostHarnessInstanceCheckResultSchema, HostHarnessOverrideListSchema,
  type HostHarnessOverride, type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { makeCurrentWorkflowFixture, CurrentWorkflowSaveResultSchema, CurrentWorkflowReadResultSchema,
  CurrentWorkflowValidationSchema, ManualRunStartResultSchema, canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { authorizeDeviceHost } from '../src/modules/devices/hostAuthorization.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { VersionHistoryService } from '../src/modules/workflows/historyManagement.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { AgentPlacementProducer } from '../src/modules/placement/agentProducer.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry } from '../src/modules/harnesses/installationRegistry.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { createCurrentNativeProductionFactory } from '../src/modules/runs/workflowProduction.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { mixedComputerPlacement } from './helpers/mixedComputerPlacement.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'

it('reconciles a changed Agent profile through authenticated MCP and admits the persisted placements', async () => {
  const base = await currentOperatorIntegration({ agentManagement: true,
    fixture: makeCurrentWorkflowFixture(randomUUID(), 'sequential') })
  const directory = await privateFixtureDirectory('agent-model-placement-')
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  let profiles: HostHarnessOverrideService | undefined
  try {
    const placement = await mixedComputerPlacement(base, directory)
    const pool = base.db.pool
    const repository = new HarnessInstanceSettingsRepository(pool)
    const evidence = new HostHarnessProfileEvidenceRepository(pool)
    // Native qualification is a typed provider-boundary fixture; authorization and persistence are real.
    const native = { qualify: async (value: HostHarnessOverride): Promise<HostHarnessProfileEvidence> => ({
      target: value.target, instanceRevision: value.instanceRevision,
      configurationFingerprint: value.configurationFingerprint, driverId: value.driverId, driverRevision: '1',
      protocolRevision: 'codex-native-adapter-v1', suiteRevision: 'codex-live-4', environmentGeneration: '1',
      connectionGeneration: '1', authenticated: true, compatible: true, qualified: true,
      checkedAt: new Date().toISOString(),
    }) }
    const hostAuthority = { authorize: async (
      principal: Parameters<typeof authorizeDeviceHost>[1], action: 'harnesses:read' | 'harnesses:update',
      host: Parameters<typeof authorizeDeviceHost>[3], installationId: string,
      sql?: import('pg').PoolClient,
    ) => {
      if (!sql) throw new Error('Host authorization requires its transaction')
      await authorizeDeviceHost(sql, principal, action, host, installationId)
    } }
    profiles = new HostHarnessOverrideService(repository, base.commands, hostAuthority, async (value, sql) => {
      const proof = await evidence.latest(value.instanceId, value.revision, sql)
      return proof ? { target: proof.target, configurationFingerprint: proof.configurationFingerprint,
        qualified: proof.authenticated === true && proof.compatible === true && proof.qualified } : null
    }, new HostHarnessInstanceProfileChecks(repository, evidence, base.commands, hostAuthority, native))
    const services = { ...base.services, harnessInstances: profiles, workflows: new WorkflowManagementService(
      pool, base.commands, { worktrees: { readyRoot: async () => undefined,
        sources: placement.sources, roots: placement.policies } }),
      extensions: { history: new VersionHistoryService(pool), agents: new OperatorAgentMutationService(
        pool, base.commands, base.services.harnesses, profiles) } }
    app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined },
      checkpoints: { ping: async () => undefined } }, operator: { access: base.access, services: services as OperatorServices } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'agent-model-placement', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const owner = await connect(base.writer.token)
    async function call(name: string, args: Record<string, unknown>, client = owner) {
      const reply = await client.callTool({ name, arguments: args })
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true)
      return decodeMcpToolResult(reply)
    }
    const workspaceId = base.f.scope.workspaceId
    const configuration = base.f.configurations[0]!.harness
    const mainId = placement.local.hostRef.mainId
    const target = { hostRef: placement.local.hostRef, applicationInstallationId: mainId,
      harnessInstallationId: placement.local.harnessInstallationId, installationFingerprint: 'a'.repeat(64) }
    async function saveProfile(model: string) {
      const saved = HostHarnessOverrideSaveResultSchema.parse(await call('harness_instance_save', {
        instanceId: randomUUID(), commandId: randomUUID(), expectedRevision: 0, target,
        presetId: 'codex', enabled: true, configuration: { ...configuration, model },
      })).value
      const checked = HostHarnessInstanceCheckResultSchema.parse(await call('harness_instance_check', {
        commandId: randomUUID(), instanceId: saved.instanceId, expectedRevision: saved.revision, target,
      }))
      expect(checked.value.qualification).toBe('qualified')
      return saved
    }
    const old = await saveProfile(configuration.model)
    const agentId = randomUUID()
    const created = AgentMutationResultSchema.parse(await call('agent_create', { workspaceId, agentId,
      commandId: randomUUID(), name: 'Model worker', configuration: old.configuration,
      harnessProfileSelection: { instanceId: old.instanceId, instanceRevision: old.instanceRevision, target },
    })).value
    const initial = await base.create()
    initial.expectedAgentConfigurationVersionIds = { [agentId]: created.agent.configurationVersionId! }
    initial.graph.nodes = initial.graph.nodes.map(node => ({ ...agentWorkflowNode(node), agentId,
      placement: { ...placement.local, instanceId: old.instanceId, instanceRevision: old.instanceRevision } }))
    const first = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', initial))
    const another = await base.create()
    const otherInput = { ...another, expectedAgentConfigurationVersionIds: initial.expectedAgentConfigurationVersionIds,
      graph: { ...another.graph, nodes: initial.graph.nodes } }
    const other = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', otherInput))
    const originalSelection = { instanceId: old.instanceId, instanceRevision: old.instanceRevision, target }
    for (const [selection, changedConfiguration, reason] of [
      [{ ...originalSelection, instanceRevision: '0' }, old.configuration, 'selection is stale'],
      [originalSelection, { ...old.configuration, model: 'changed-model' }, 'configuration changed'],
    ] as const) {
      const conflict = await owner.callTool({ name: 'agent_update', arguments: {
        workspaceId, agentId, commandId: randomUUID(), expectedRevision: created.metadataRevision,
        expectedConfigurationVersionId: created.agent.configurationVersionId,
        configuration: changedConfiguration, harnessProfileSelection: selection,
      } })
      expect(conflict.isError).toBe(true)
      const message = JSON.stringify(conflict.content)
      expect(message).toContain('HARNESS_PROFILE_SELECTION_CONFLICT')
      expect.soft(message).toContain(reason)
      if (reason === 'selection is stale') {
        expect.soft(message).toMatch(/harness_instances_list.*reuse the listed selection/)
        expect.soft(message).not.toContain('harness_instance_save')
      } else {
        expect.soft(message).toMatch(/harness_instances_list.*harness_instance_save.*returned selection/)
      }
      expect(ManagedAgentDetailSchema.parse(await call('agent_get', { workspaceId, agentId })).agent)
        .toEqual(created.agent)
    }
    const listed = HostHarnessOverrideListSchema.parse(await call('harness_instances_list', {
      hostRef: target.hostRef, applicationInstallationId: mainId,
    }))
    expect(listed.overrides.find(profile => profile.instanceId === old.instanceId)?.configuration)
      .toEqual(old.configuration)
    const listedProfile = listed.overrides.find(profile => profile.instanceId === old.instanceId)!
    const listedSelection = { instanceId: listedProfile.instanceId,
      instanceRevision: listedProfile.instanceRevision, target: listedProfile.target }
    const recoveredId = randomUUID()
    const recovered = AgentMutationResultSchema.parse(await call('agent_create', {
      workspaceId, agentId: recoveredId, name: 'Recovered selection', commandId: randomUUID(),
      configuration: listedProfile.configuration, harnessProfileSelection: listedSelection,
    }))
    expect(ManagedAgentDetailSchema.parse(await call('agent_get', { workspaceId, agentId: recoveredId })).agent)
      .toEqual(recovered.value.agent)
    expect(recovered.value.agent.harnessProfileSelection).toEqual(listedSelection)
    expect(HostHarnessOverrideListSchema.parse(await call('harness_instances_list', {
      hostRef: target.hostRef, applicationInstallationId: mainId,
    })).overrides.find(profile => profile.instanceId === old.instanceId)).toEqual(listedProfile)
    const tools = (await owner.listTools()).tools
    expect.soft(tools.find(tool => tool.name === 'agent_update')?.description)
      .toMatch(/harness_instances_list.*harness_instance_save.*returned selection/)
    expect.soft(tools.find(tool => tool.name === 'agent_update')?.description)
      .toMatch(/stale.*harness_instances_list.*reuse the listed selection/)
    const selected = await saveProfile('changed-model')
    const updateInput = { workspaceId, agentId, commandId: randomUUID(), expectedRevision: created.metadataRevision,
      expectedConfigurationVersionId: created.agent.configurationVersionId,
      configuration: selected.configuration, harnessProfileSelection: {
        instanceId: selected.instanceId, instanceRevision: selected.instanceRevision, target,
      } }
    const issued = await base.access.issue({ name: 'Read-only model inspector', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agents:read', 'workflows:read', 'graph:read'],
        scope: { workspaceIds: [workspaceId] } }] })
    const reader = await connect(issued.token)
    const deniedUpdate = await reader.callTool({ name: 'agent_update', arguments: updateInput })
    expect(deniedUpdate.isError).toBe(true)
    expect(JSON.stringify(deniedUpdate.content)).toContain('ACCESS_DENIED')
    expect(ManagedAgentDetailSchema.parse(await call('agent_get', { workspaceId, agentId }, reader)).agent)
      .toEqual(created.agent)
    const updated = AgentMutationResultSchema.parse(await call('agent_update', updateInput))
    expect(updated.value.affectedWorkflowIds).toEqual([initial.workflowId, another.workflowId].sort())
    expect(AgentMutationResultSchema.parse(await call('agent_update', updateInput))).toEqual({ ...updated, replayed: true })
    const agentRead = ManagedAgentDetailSchema.parse(await call('agent_get', { workspaceId, agentId }, reader))
    expect(agentRead.agent).toEqual(updated.value.agent)
    expect(agentRead.workflowIds).toEqual(updated.value.affectedWorkflowIds)
    const pins = { [agentId]: updated.value.agent.configurationVersionId! }
    const input = { ...initial, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId, expectedAgentConfigurationVersionIds: pins,
      graph: first.value.version.definition }
    const { commandId, ...validation } = input
    expect(CurrentWorkflowValidationSchema.parse(await call('workflow_validate_v3', validation)).valid).toBe(true)
    const deniedSave = await reader.callTool({ name: 'workflow_save_v3', arguments: input })
    expect(deniedSave.isError).toBe(true)
    expect(JSON.stringify(deniedSave.content)).toContain('ACCESS_DENIED')
    const saved = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', input))
    expect(CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', input)))
      .toEqual({ ...saved, replayed: true })
    const read = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', {
      workspaceId, workflowId: initial.workflowId,
    }, reader))
    expect(read.version).toEqual(saved.value.version)
    for (const node of read.version.definition.nodes) {
      expect(agentWorkflowNode(node).placement).toEqual({ ...placement.local, instanceId: selected.instanceId,
        instanceRevision: selected.instanceRevision })
    }
    const historical = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', {
      workspaceId, workflowId: initial.workflowId, workflowVersionId: first.value.currentVersionId,
    }))
    expect(historical.version).toEqual(first.value.version)
    const untouched = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', {
      workspaceId, workflowId: another.workflowId,
    }))
    expect(untouched.version).toEqual(other.value.version)
    const conflictGraph = { ...read.version.definition, nodes: read.version.definition.nodes.map((node, index) =>
      index === 0 ? { ...node, placement: placement.remote } : node) }
    for (const tool of ['workflow_validate_v3', 'workflow_save_v3']) {
      const invalid = await owner.callTool({ name: tool, arguments: { ...validation,
        ...(tool === 'workflow_save_v3' ? { commandId: randomUUID() } : {}),
        expectedRevision: read.revision, expectedWorkflowVersionId: read.currentVersionId, graph: conflictGraph,
      } })
      expect(invalid.isError).toBe(true)
      const message = JSON.stringify(invalid.content)
      expect(message).toContain('AGENT_PROFILE_PLACEMENT_CONFLICT')
      expect(message).toContain(conflictGraph.nodes[0]!.id)
    }
    expect(CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', {
      workspaceId, workflowId: initial.workflowId,
    }))).toEqual(read)
    // Seed an existing saved version whose configuration changed while its placements stayed stale.
    const staleInput = { ...otherInput, commandId: randomUUID(), graph: other.value.version.definition,
      expectedRevision: other.value.revision, expectedWorkflowVersionId: other.value.currentVersionId,
      expectedAgentConfigurationVersionIds: pins }
    const now = new Date().toISOString()
    const staleVersion = { ...other.value.version, id: `workflow-version-${randomUUID()}`,
      version: other.value.version.version + 1, agentConfigurationVersionIds: pins, createdAt: now,
      definition: { ...other.value.version.definition, version: other.value.version.version + 1, updatedAt: now } }
    const content = canonicalGraphJson({ definition: staleVersion.definition,
      configurations: pins, entryNodeId: staleVersion.entryNodeId })
    staleVersion.contentHash = `sha256:${createHash('sha256').update(content).digest('hex')}`
    const stale = await base.commands.execute({ principal: base.writer.principal, source: 'mcp',
      operation: 'workflow.save.v3', commandId: staleInput.commandId,
      targetKey: `workflow:${another.workflowId}:definition`, payload: staleInput,
      perform: async sql => {
        await sql.query(`insert into workflow_versions
          (id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
          values($1,$2,$3,$4,$5,$6::jsonb,3)`, [staleVersion.id, workspaceId, another.workflowId,
          staleVersion.version, staleVersion.entryNodeId, canonicalGraphJson(staleVersion)])
        const row = (await sql.query<{ revision: string }>(
          'select eng04_publish_current_workflow($1,$2,$3::jsonb,$4,$5,$6)::text as revision',
          [base.writer.principal.id, 'mcp', canonicalGraphJson(staleInput), commandInputHash(staleInput),
            staleVersion.id, content])).rows[0]!
        return { workspaceId, workflowId: another.workflowId, revision: Number(row.revision),
          currentVersionId: staleVersion.id, version: staleVersion }
      },
    })
    const repairInput = { ...staleInput, commandId: randomUUID(), graph: staleVersion.definition,
      expectedRevision: stale.value.revision, expectedWorkflowVersionId: staleVersion.id }
    const repaired = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', repairInput))
    expect(repaired.value.currentVersionId).not.toBe(staleVersion.id)
    for (const node of repaired.value.version.definition.nodes) {
      expect(agentWorkflowNode(node).placement?.instanceId).toBe(selected.instanceId)
    }
    expect(CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', {
      workspaceId, workflowId: another.workflowId,
    })).version).toEqual(repaired.value.version)
    expect(CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', repairInput)))
      .toEqual({ ...repaired, replayed: true })
    // Use the same admission producer as Run Start with persisted source/root and native qualification facts.
    const instances = new HarnessInstanceRegistry(localHarnessDrivers)
    instances.reload([old, selected].map(profile => ({ instanceId: profile.instanceId,
      instanceRevision: profile.instanceRevision, driverId: profile.driverId, enabled: true,
      configuration: profile.configuration })))
    const installations = new HarnessInstallationRegistry(instances)
    installations.refresh(placement.installations.list())
    const producer = new AgentPlacementProducer(pool, mainId, placement.sources, placement.policies, {
      installations, pinOverride: profile => installations.pin({ instanceId: profile.instanceId,
        hostRef: profile.target.hostRef, harnessInstallationId: profile.target.harnessInstallationId,
        environmentGeneration: '1', connectionGeneration: '1' }),
    }, { codex: 'codex-live-4' })
    const production = createCurrentNativeProductionFactory({ isRuntimeOpen: () => true,
      reportDispatchFailure: (_runId, code) => base.dispatchErrors.push(code) })({
      primaryPool: pool, commands: base.commands, runs: base.runs, workflows: base.workflows,
      locations: base.locations, engine: base.engine, nativeExecutions: base.native,
      interactions: base.service, checkpointer: base.checkpointer,
    })
    services.runs = new RunManagementService(pool, base.commands, base.runs, base.engine, base.locations, {
      ...production, startPublication: { ...production.startPublication, placementAdmission: producer },
    })
    const started = ManualRunStartResultSchema.parse(await call('run_start', { workspaceId,
      workflowId: initial.workflowId, commandId, executionSemanticsVersion: 3,
      workflowVersionId: read.currentVersionId, expectedWorkflowRevision: read.revision, input: {},
      expectedAgentConfigurationVersionIds: pins,
      expectedLocationRevision: placement.locationRevision,
    }))
    expect(started.accepted).toBe(true)
    for (const node of read.version.definition.nodes) {
      const persisted = await placement.reads.get(base.writer.principal, { workspaceId,
        workflowId: initial.workflowId, runId: started.run.id, nodeId: node.id })
      expect(persisted.readback).toMatchObject({ evidence: 'accepted', placement: {
        hostRef: placement.local.hostRef, payload: { instanceId: selected.instanceId,
          instanceRevision: selected.instanceRevision, agentConfigurationVersionId: pins[agentId] },
      } })
    }
    expect((await pool.query("select outcome from management_audit where principal_id=$1 and outcome='denied'",
      [issued.principal.id])).rows).toHaveLength(2)
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app?.close()
    await profiles?.closeChecks()
    await base.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
