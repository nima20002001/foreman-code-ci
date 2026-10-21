import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AgentMutationResultSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema, SavedManagedWorkflowSchema,
  SavedManagedWorkflowCommandResultSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { initialSave, setupWorkflowCreateIntegration } from './helpers/operatorWorkflowCreate.js'

const currentOperatorIntegration = setupWorkflowCreateIntegration()

it.each(['initialSave', 'workflow_save_v3'] as const)(
  'publishes Operator positions as manual through %s and preserves them on later saves', async (route) => {
    const f = await currentOperatorIntegration({ agentManagement: true,
      fixture: makeCurrentWorkflowFixture(randomUUID(), 'single') })
    const call = async (name: string, args: Record<string, unknown>) => {
      const reply = await f.client.callTool({ name, arguments: args })
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true)
      return decodeMcpToolResult(reply)
    }
    try {
      const workspaceId = f.f.scope.workspaceId
      const agentId = randomUUID()
      const agent = AgentMutationResultSchema.parse(await call('agent_create', {
        workspaceId, agentId, name: 'Worker',
        configuration: { harness: 'codex', model: 'recorded-model', reasoningEffort: 'low',
          sandbox: 'read-only', serviceTier: 'standard' }, prompt: {},
      })).value.agent
      const initial = initialSave(f.f.version.definition, { [agentId]: agent.configurationVersionId! })
      const nodeId = 'worker'
      const graph = { ...initial.graph, entryNodeId: nodeId, approval: { handler: 'native' }, edges: [],
        nodes: [{ id: nodeId, agentId, name: 'Worker', initialPrompt: 'Do the work', position: { x: 0, y: 0 } }] }
      const createInput = { workspaceId, name: 'Manual placement', commandId: randomUUID(),
        ...(route === 'initialSave' ? { initialSave: { ...initial, graph } } : {}) }
      const reader = await f.access.issue({ name: 'Workflow reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['workflows:read', 'graph:read'], scope: {} }] })
      const readClient = await f.connect(reader.token)
      const denied = await readClient.callTool({ name: 'workflow_create', arguments: createInput })
      expect(denied.isError).toBe(true)
      expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })

      const created = SavedManagedWorkflowCommandResultSchema.parse(await call('workflow_create', createInput))
      const workflowId = created.value.workflow.id
      const scope = { workspaceId, workflowId }
      let saved: ReturnType<typeof CurrentWorkflowReadResultSchema.parse>
      if (route === 'workflow_save_v3') {
        const input = { ...scope, executionSemanticsVersion: 3, commandId: randomUUID(),
          expectedRevision: created.value.revision, expectedWorkflowVersionId: null,
          expectedAgentConfigurationVersionIds: initial.expectedAgentConfigurationVersionIds,
          graph: { ...graph, id: workflowId, workspaceId, name: created.value.workflow.name } }
        const deniedSave = await readClient.callTool({ name: 'workflow_save_v3', arguments: input })
        expect(deniedSave.isError).toBe(true)
        expect(decodeMcpToolResult(deniedSave)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
        const first = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', input))
        expect(CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', input)))
          .toEqual({ ...first, replayed: true })
        saved = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', scope))
        expect(saved.version).toEqual(first.value.version)
      } else {
        expect(SavedManagedWorkflowCommandResultSchema.parse(await call('workflow_create', createInput)))
          .toEqual({ ...created, replayed: true })
        saved = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', scope))
        expect(saved.version.definition).toEqual(created.value.workflow)
      }
      const expectedPosition = { x: 0, y: 0, manual: true }
      expect(saved.version.definition.nodes[0]?.position).toEqual(expectedPosition)
      expect(SavedManagedWorkflowSchema.parse(await call('workflow_get', scope)).workflow.nodes[0]?.position)
        .toEqual(expectedPosition)

      const edited = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', {
        ...scope, executionSemanticsVersion: 3,
        expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
        expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
        graph: { ...saved.version.definition, nodes: saved.version.definition.nodes.map(node => ({
          ...node, initialPrompt: 'Updated work',
        })) },
      }))
      expect(edited.value.version.version).toBe(saved.version.version + 1)
      const persisted = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', scope))
      expect(persisted.version).toEqual(edited.value.version)
      expect(persisted.version.definition.nodes[0]?.position).toEqual(expectedPosition)
      expect(SavedManagedWorkflowSchema.parse(await call('workflow_get', scope)).workflow.nodes[0]?.position)
        .toEqual(expectedPosition)
    } finally {
      await f.close()
    }
  }, 120_000,
)
