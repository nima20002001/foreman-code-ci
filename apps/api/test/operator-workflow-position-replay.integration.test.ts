import { createHash, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  CurrentWorkflowSaveResultSchema, canonicalGraphJson, preserveWorkflowGeometry, type WorkflowDefinitionV3,
} from '@foreman-code/contracts/wave25'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { setup } from './helpers/workflowWorktreeMcp.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'

it('replays an existing profile-reconciled save without retroactively marking retained coordinates manual', async () => {
  const f = await setup()
  try {
    const { saveInput } = await f.create()
    saveInput.graph.nodes = saveInput.graph.nodes.map(node => ({ ...agentWorkflowNode(node),
      placement: f.placement.local, position: { x: 10, y: 20 } }))
    const first = CurrentWorkflowSaveResultSchema.parse(await f.base.services.workflows.current.save(
      f.base.writer.principal, 'http', saveInput))
    const selectedInstanceId = randomUUID()
    const originalConfiguration = f.base.f.configurations[0]!
    const configuration = AgentConfigurationVersionSchema.parse({ ...originalConfiguration,
      id: randomUUID(), version: 2, harnessProfileSelection: {
        instanceId: selectedInstanceId, instanceRevision: '1', target: {
          hostRef: f.placement.local.hostRef,
          applicationInstallationId: f.placement.local.hostRef.mainId,
          harnessInstallationId: f.placement.local.harnessInstallationId,
          installationFingerprint: 'a'.repeat(64),
        },
      } })
    await f.base.db.pool.query(`insert into agent_configuration_versions(id,workspace_id,agent_id,version,record)
      values($1,$2,$3,$4,$5::jsonb)`, [configuration.id, f.workspaceId,
      configuration.agentId, configuration.version, canonicalGraphJson(configuration)])
    const input = { ...saveInput, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId,
      expectedAgentConfigurationVersionIds: { ...first.value.version.agentConfigurationVersionIds,
        [configuration.agentId]: configuration.id },
      graph: { ...first.value.version.definition, nodes: first.value.version.definition.nodes.map(node => ({
        ...node, position: { x: 100, y: 200 },
      })) } }
    const graph: WorkflowDefinitionV3 = { ...input.graph, nodes: input.graph.nodes.map(node => {
      const agentNode = agentWorkflowNode(node)
      return agentNode.agentId === configuration.agentId
        ? { ...agentNode, placement: { ...f.placement.local, instanceId: selectedInstanceId } } : node
    }) }
    // Seed a successful historical command through the unchanged publication guard.
    const now = new Date().toISOString()
    const version = { ...first.value.version, id: randomUUID(), version: first.value.version.version + 1,
      createdAt: now, agentConfigurationVersionIds: input.expectedAgentConfigurationVersionIds,
      definition: { ...preserveWorkflowGeometry(graph, first.value.version.definition),
        version: first.value.version.version + 1, updatedAt: now } }
    const content = canonicalGraphJson({ definition: version.definition,
      configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId })
    version.contentHash = `sha256:${createHash('sha256').update(content).digest('hex')}`
    const historical = await f.base.commands.execute({ principal: f.base.writer.principal, source: 'mcp',
      operation: 'workflow.save.v3', commandId: input.commandId,
      targetKey: `workflow:${input.workflowId}:definition`, payload: input,
      perform: async sql => {
        await sql.query(`insert into workflow_versions
          (id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
          values($1,$2,$3,$4,$5,$6::jsonb,3)`, [version.id, f.workspaceId, input.workflowId,
          version.version, version.entryNodeId, canonicalGraphJson(version)])
        const row = (await sql.query<{ revision: string }>(
          'select eng04_publish_current_workflow($1,$2,$3::jsonb,$4,$5,$6)::text as revision',
          [f.base.writer.principal.id, 'mcp', canonicalGraphJson({ ...input, graph }), commandInputHash(input),
            version.id, content])).rows[0]!
        return { workspaceId: f.workspaceId, workflowId: input.workflowId, revision: Number(row.revision),
          currentVersionId: version.id, version }
      },
    })
    expect(await f.save(input)).toEqual({ ...historical, replayed: true })
    expect((await f.read(input.workflowId)).version).toEqual(version)
    const conflict = await f.base.client.callTool({ name: 'workflow_save_v3', arguments: {
      ...input, graph: { ...input.graph, name: 'Changed request' },
    } })
    expect(conflict.isError).toBe(true)
    expect(decodeMcpToolResult(conflict)).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } })
    expect((await f.read(input.workflowId)).version).toEqual(version)
  } finally {
    await f.close()
  }
}, 120_000)
