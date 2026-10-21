import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SupportedHarnessConfigurationSchema } from '@foreman-code/contracts'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { regressionAuthoringFixture } from './helpers/executionRegressions.js'

describe.skipIf(!postgresEnabled)('current execution authoring regressions', () => {
  const authoring = regressionAuthoringFixture()

  it('saves authored immutable Agent snapshots after the Agent head changes', async () => {
    const f = await authoring()
    const original = f.f.configurations[0]!
    const agents = new OperatorAgentMutationService(f.db.pool, f.commands, { qualifyConfiguration: async (configuration) => ({
      harness: configuration.harness, version: 'fixture', authenticated: true, ready: true, structuredEvents: true,
      supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true, supportsStartupPrompt: true,
      supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [],
    }) })
    const revision = Number((await f.db.pool.query('select metadata_revision from agents where id=$1', [original.agentId])).rows[0].metadata_revision)
    const updated = await agents.update(f.writer.principal, { workspaceId: original.workspaceId, agentId: original.agentId,
      commandId: randomUUID(), expectedRevision: revision, expectedConfigurationVersionId: original.id,
      configuration: SupportedHarnessConfigurationSchema.parse({ ...original.harness, model: 'new-current-model' }) })
    const id = updated.value.agent.configurationVersionId!
    expect(id).not.toBe(original.id)
    expect((await f.db.pool.query('select record from agent_configuration_versions where id=$1', [original.id])).rows[0].record).toEqual(original)
    const edited = { ...f.input, graph: { ...f.input.graph, executionPolicy: { maxParallelism: 2, maxNodeExecutions: 1 } } }
    const retained = await f.workflows.current.save(f.writer.principal, 'mcp', edited)
    expect(retained.value.version.agentConfigurationVersionIds[original.agentId]).toBe(original.id)
    const saved = await f.workflows.current.save(f.writer.principal, 'mcp', { ...edited, commandId: randomUUID(),
      expectedRevision: retained.value.revision, expectedWorkflowVersionId: retained.value.currentVersionId,
      graph: retained.value.version.definition, expectedAgentConfigurationVersionIds: { [original.agentId]: id } })
    expect(saved.value.version.agentConfigurationVersionIds[original.agentId]).toBe(id)
  })

  it('rejects a workflow ID from another workspace without changing immutable versions', async () => {
    const f = await authoring()
    const before = (await f.db.pool.query('select id,record from workflow_versions order by id')).rows
    await expect(f.workflows.current.save(f.writer.principal, 'mcp', { ...f.input,
      workspaceId: 'foreign-workspace', graph: { ...f.input.graph, workspaceId: 'foreign-workspace' } })).rejects.toThrow()
    expect((await f.db.pool.query('select id,record from workflow_versions order by id')).rows).toEqual(before)
  })

})
