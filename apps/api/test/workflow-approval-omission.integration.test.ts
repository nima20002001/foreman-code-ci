import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import {
  CurrentWorkflowCreateInputSchema, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema,
  RunStartV3ResultSchema, SavedManagedWorkflowCommandResultSchema, SavedManagedWorkflowSchema,
  makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { graphHeaders } from './eng04-graph-composition-fixture.js'
import { setupWorkflowCreateIntegration } from './helpers/operatorWorkflowCreate.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

function nativeFixture() {
  const fixture = makeCurrentWorkflowFixture(randomUUID())
  const approval = { handler: 'native' as const }
  fixture.version.approval = approval
  fixture.version.definition.approval = approval
  fixture.run.approval = approval
  return fixture
}

function value(result: Parameters<typeof decodeMcpToolResult>[0] & { isError?: boolean | undefined }) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  return decodeMcpToolResult(result)
}

describe.runIf(postgresEnabled)('workflow approval defaults through authenticated MCP', () => {
  const integration = setupWorkflowCreateIntegration()

  it('creates, reads and starts a Codex-only initial save with no approval field', async () => {
    const f = await integration({ fixture: nativeFixture(), approvalNodeIds: [], insertRun: false })
    try {
      const workspaceId = f.f.scope.workspaceId
      const input = CurrentWorkflowCreateInputSchema.parse({ workspaceId, name: 'Native Codex workflow',
        commandId: randomUUID(), initialSave: {
          graph: { executionSemanticsVersion: 3, entryNodeId: f.f.version.entryNodeId,
            executionCondition: { kind: 'manual' }, nodes: f.f.version.definition.nodes,
            edges: f.f.version.definition.edges, executionPolicy: f.f.version.definition.executionPolicy },
          expectedAgentConfigurationVersionIds: f.f.version.agentConfigurationVersionIds,
        } })
      expect(input.initialSave?.graph).not.toHaveProperty('approval')
      const created = SavedManagedWorkflowCommandResultSchema.parse(value(
        await f.client.callTool({ name: 'workflow_create', arguments: input })))
      const scope = { workspaceId, workflowId: created.value.workflow.id }
      expect(created.value.workflow.approval).toEqual({ handler: 'native' })
      expect(created.value.currentVersionId).toEqual(expect.any(String))
      const managed = SavedManagedWorkflowSchema.parse(value(
        await f.client.callTool({ name: 'workflow_get', arguments: scope })))
      expect(managed).toEqual(created.value)
      const read = CurrentWorkflowReadResultSchema.parse(value(
        await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: scope })))
      expect(read.version.approval).toEqual({ handler: 'native' })
      expect(read.version.definition.approval).toEqual(read.version.approval)
      expect(read.version.definition.nodes).toEqual(input.initialSave!.graph.nodes)
      expect(read.version.agentConfigurationVersionIds).toEqual(f.f.version.agentConfigurationVersionIds)
      expect(value(await f.client.callTool({ name: 'workflow_create', arguments: input })))
        .toEqual({ ...created, replayed: true })

      const reader = await f.access.issue({ name: 'Workflow reader', audience: 'operator', grants: [{
        actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [workspaceId] },
      }] })
      const client = await f.connect(reader.token)
      await expectMcpAccessDenied(client.callTool({ name: 'workflow_create', arguments: {
        ...input, commandId: randomUUID(),
      } }))
      expect(value(await client.callTool({ name: 'workflow_saved_get_v3', arguments: scope }))).toEqual(read)

      const location = await f.db.pool.query<{ root: string }>(
        "select execution_location->>'rootPath' as root from workspaces where id=$1", [workspaceId])
      const identity = await stat(location.rows[0]!.root, { bigint: true })
      await f.db.pool.query('update workspaces set execution_location_identity=$2::jsonb where id=$1',
        [workspaceId, JSON.stringify({ device: String(identity.dev), inode: String(identity.ino) })])
      const workspace = ManagedWorkspaceSchema.parse(value(
        await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId } })))
      const started = RunStartV3ResultSchema.parse(value(await f.client.callTool({ name: 'run_start', arguments: {
        ...scope, workflowVersionId: read.currentVersionId, executionSemanticsVersion: 3,
        expectedWorkflowRevision: read.revision, expectedAgentConfigurationVersionIds: read.version.agentConfigurationVersionIds,
        expectedLocationRevision: workspace.locationRevision,
        commandId: randomUUID(), input: { message: 'Complete the task.' },
      } })))
      expect(started.run.approval).toEqual({ handler: 'native' })
      expect(started.run.workflowVersionId).toBe(read.currentVersionId)
      const persisted = value(await f.client.callTool({ name: 'run_get', arguments: {
        workspaceId, runId: started.run.id, detail: 'full',
      } }))
      expect(persisted).toMatchObject({ run: { id: started.run.id, approval: { handler: 'native' } } })
    } finally {
      await f.close()
    }
  }, 30_000)

  it.each(['mcp', 'http'] as const)('saves the Board creation default through %s when approval is omitted', async (source) => {
    const f = await integration({ fixture: nativeFixture(), insertRun: false })
    try {
      const input = await f.create()
      delete input.graph.approval
      const response = source === 'mcp'
        ? value(await f.client.callTool({ name: 'workflow_save_v3', arguments: input }))
        : await f.app.inject({ method: 'PUT',
          url: `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/definition`,
          headers: graphHeaders(f.writer.token), payload: input,
        }).then(reply => {
          expect(reply.statusCode, reply.body).toBe(200)
          return reply.json()
        })
      const saved = CurrentWorkflowSaveResultSchema.parse(response)
      expect(saved.value.version.approval).toEqual({ handler: 'native' })
      const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId }
      const read = CurrentWorkflowReadResultSchema.parse(value(
        await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: scope })))
      expect(read.version).toEqual(saved.value.version)
      expect(value(await f.client.callTool({ name: 'workflow_save_v3', arguments: input })))
        .toEqual({ ...saved, replayed: true })
    } finally {
      await f.close()
    }
  }, 30_000)

  it('preserves explicit orchestrator defaults and rejects routed approvals without a designated reviewer', async () => {
    const f = await integration({ fixture: nativeFixture(), insertRun: false })
    try {
      await new PostgresFoundationSettingsRepository(f.db.pool).updateWorkflowDefaults({ approvalHandler: 'orchestrator' }, 0)
      const input = await f.create()
      const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId }
      const created = SavedManagedWorkflowSchema.parse(value(
        await f.client.callTool({ name: 'workflow_get', arguments: scope })))
      expect(created.workflow.approval).toEqual({ handler: 'orchestrator' })
      input.graph.approval = created.workflow.approval
      input.graph.edges.push({ id: 'review', kind: 'approval',
        source: input.graph.nodes[0]!.id, target: input.graph.nodes[1]!.id })
      const result = await f.client.callTool({ name: 'workflow_save_v3', arguments: input })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain('ORCHESTRATOR_REQUIRED')
      const managed = SavedManagedWorkflowSchema.parse(value(await f.client.callTool({ name: 'workflow_get',
        arguments: { workspaceId: input.workspaceId, workflowId: input.workflowId } })))
      expect(managed.currentVersionId).toBeNull()
      expect(managed.workflow.approval).toEqual({ handler: 'orchestrator' })
    } finally {
      await f.close()
    }
  }, 30_000)
})
