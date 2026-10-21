import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { COORDINATION_RESULT_PROTOCOL, WorkflowHierarchyReadResultSchema, WorkflowReportsPageSchema } from '@foreman-code/contracts'
import { AgentMutationResultSchema } from '@foreman-code/contracts/management'
import { CurrentRunDetailsSchema, CurrentWorkflowSaveResultSchema, RunStartV3ResultSchema,
  SavedManagedWorkflowCommandResultSchema } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { workflowChatCall } from './helpers/workflowChatRequests.js'
import { graphRpc } from './eng04-graph-composition-fixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('single-computer hierarchy Start through authenticated MCP', () => {
  it('creates, saves and runs Master to Orchestrator to Worker, then reads both child reports and the Master result', async () => {
    const f = await currentOperatorIntegration({ agentManagement: true, workflowHierarchy: true, insertRun: false,
      approvalNodeIds: [], collaborationPorts: {}, outputFor: (node, request) => coordinationOutput(node, request,
        node === 'master' ? { select: ['build'] } : {}) })
    try {
      const workspaceId = f.f.scope.workspaceId
      const directory = await stat(f.db.directory, { bigint: true })
      await f.db.pool.query('update workspaces set execution_location_identity=$2::jsonb where id=$1',
        [workspaceId, JSON.stringify({ device: String(directory.dev), inode: String(directory.ino) })])
      const agents: ReturnType<typeof AgentMutationResultSchema.parse>['value']['agent'][] = []
      for (const productRole of ['master', 'orchestrator', 'coder'] as const) {
        agents.push(AgentMutationResultSchema.parse(await workflowChatCall(f, 'agent_create', {
          workspaceId, agentId: randomUUID(), name: productRole, productRole,
          configuration: f.f.configurations[0]!.harness,
        })).value.agent)
      }
      const created = SavedManagedWorkflowCommandResultSchema.parse(await workflowChatCall(f, 'workflow_create', {
        workspaceId, name: 'Single-computer hierarchy',
      })).value
      const workflowId = created.workflow.id
      const saved = CurrentWorkflowSaveResultSchema.parse(await workflowChatCall(f, 'workflow_save_v3', {
        workspaceId, workflowId, executionSemanticsVersion: 3,
        expectedRevision: created.revision, expectedWorkflowVersionId: null,
        expectedAgentConfigurationVersionIds: Object.fromEntries(agents.map(agent => [agent.id, agent.configurationVersionId!])),
        graph: { ...created.workflow, entryNodeId: 'master', approval: { handler: 'user' },
          executionCondition: { kind: 'manual' }, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 5 },
          handoffs: { contractVersion: 1 }, hierarchy: { version: 1, masterNodeId: 'master', parents: [
            { workflowNodeId: 'build', parentNodeId: 'master' }, { workflowNodeId: 'builder', parentNodeId: 'build' },
          ] }, nodes: ['master', 'build', 'builder'].map((id, index) => ({ id, agentId: agents[index]!.id, name: id,
            ...(index < 2 ? { choice: { outcomes: [{ outcome: index === 0 ? 'build' : 'builder',
              target: { kind: 'edge', relationshipId: `child-${index}` } }] } } : {}) })),
          edges: [{ id: 'child-0', kind: 'execution', source: 'master', target: 'build' },
            { id: 'child-1', kind: 'execution', source: 'build', target: 'builder' }],
        },
      })).value
      const start = { workspaceId, workflowId, workflowVersionId: saved.currentVersionId,
        expectedWorkflowRevision: saved.revision, expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
        expectedLocationRevision: f.f.run.executionLocation!.locationRevision,
        executionSemanticsVersion: 3, commandId: randomUUID(), input: { task: 'Deliver the implementation and report.' } }
      const reader = await f.access.issue({ name: 'Hierarchy reader', audience: 'operator',
        grants: [{ actions: ['runs:read', 'workflows:read'], scope: { workspaceIds: [workspaceId] } }] })
      const denied = await graphRpc(f.app, reader.token, 'tools/call', { name: 'run_start', arguments: start })
      expect(denied.result?.isError).toBe(true)
      const started = RunStartV3ResultSchema.parse(await workflowChatCall(f, 'run_start', start))
      const runId = started.run.id
      CurrentRunDetailsSchema.parse(await f.services.runs.get(f.writer.principal, workspaceId, runId))
      const read = async () => {
        expect(f.dispatchFailureDetails, inspect(f.dispatchFailureDetails, { depth: 8 })).toEqual([])
        CurrentRunDetailsSchema.parse(await f.services.runs.get(f.writer.principal, workspaceId, runId))
        return CurrentRunDetailsSchema.parse(await workflowChatCall(f, 'run_get', { workspaceId, runId, detail: 'full' }))
      }
      await expect.poll(async () => (await read()).run.executionState, { timeout: 30_000 }).toBe('completed')
      const result = await read()
      expect(result.run).toMatchObject({ outcome: 'succeeded', workflowVersionId: saved.currentVersionId })
      expect(result.run.resultProtocol).toBe(COORDINATION_RESULT_PROTOCOL)
      expect(result.executions).toHaveLength(5)
      expect(result.executions.every(execution => execution.result?.outcome === 'succeeded')).toBe(true)
      const reports = WorkflowReportsPageSchema.parse(await workflowChatCall(f, 'workflow_reports_read', { workspaceId, workflowId, runId }))
      expect(reports.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ agent: expect.objectContaining({ workflowNodeId: 'builder' }), parentNodeId: 'build', state: 'returned' }),
        expect.objectContaining({ agent: expect.objectContaining({ workflowNodeId: 'build' }), parentNodeId: 'master', state: 'returned' }),
      ]))
      const hierarchy = WorkflowHierarchyReadResultSchema.parse(await workflowChatCall(f, 'workflow_hierarchy_get', { workspaceId, workflowId, runId }))
      expect(hierarchy.run?.coordination).toMatchObject({ state: 'succeeded', summary: 'master finish' })
      const master = result.executions.find(execution => execution.id === hierarchy.run?.coordination?.sourceExecution?.executionId)
      expect(master?.result).toMatchObject({ outcome: 'succeeded', output: {
        routing: { kind: 'finish' }, data: { latestDeliverable: { completedBy: 'master' }, remainingFindings: [] },
      } })
      expect(await workflowChatCall(f, 'run_start', start)).toMatchObject({ replayed: true, run: { id: runId } })
      expect(f.provider.counts.starts).toBe(5)
      expect(await workflowChatCall(f, 'run_get', { workspaceId, runId })).toMatchObject({ detail: 'compact',
        run: { id: runId, executionState: 'completed', outcome: 'succeeded' } })
      expect(f.dispatchErrors).toEqual([])
    } finally { await f.close() }
  }, 90_000)
})
