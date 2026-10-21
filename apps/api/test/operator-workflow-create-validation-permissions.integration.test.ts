import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult, WorkflowSummaryPageSchema } from '@foreman-code/contracts/operator-mcp'
import {
  CurrentWorkflowReadResultSchema, SavedManagedWorkflowCommandResultSchema, makeCurrentWorkflowFixture,
  type CurrentWorkflowCreateInput,
} from '@foreman-code/contracts/wave25'
import { initialSave, setupWorkflowCreateIntegration } from './helpers/operatorWorkflowCreate.js'

const currentOperatorIntegration = setupWorkflowCreateIntegration()

it('leaves no empty workflow after validation failures and accepts a corrected retry', async () => {
  const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single') })
  try {
    const workspaceId = f.f.scope.workspaceId
    const input: CurrentWorkflowCreateInput = {
      workspaceId, commandId: randomUUID(), name: 'Atomic validation', defaultWorktree: null,
      initialSave: initialSave(f.f.version.definition, f.f.version.agentConfigurationVersionIds),
    }
    const list = async () => {
      const reply = await f.client.callTool({ name: 'workflow_list', arguments: { workspaceId, limit: 100 } })
      expect(reply.isError).not.toBe(true)
      return WorkflowSummaryPageSchema.parse(decodeMcpToolResult(reply))
    }
    const before = await list()
    for (const [save, code] of [
      [{ ...input.initialSave!, graph: { ...input.initialSave!.graph, entryNodeId: 'missing-node' } }, 'GRAPH_INVALID'],
      [{ ...input.initialSave!, expectedAgentConfigurationVersionIds: {} }, 'AGENT_CONFIGURATION_CONFLICT'],
    ] as const) {
      const rejected = await f.client.callTool({ name: 'workflow_create', arguments: { ...input, initialSave: save } })
      expect(rejected.isError).toBe(true)
      expect(decodeMcpToolResult(rejected)).toMatchObject({ error: { code } })
      expect(await list()).toEqual(before)
    }
    // A failed create has no receipt, so its corrected input can use the same command ID.
    const response = await f.client.callTool({ name: 'workflow_create', arguments: input })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    const created = SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(response))
    expect(created.replayed).toBe(false)
    expect((await list()).items.map(item => item.workflow.id)).toContain(created.value.workflow.id)
    const read = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
      workspaceId, workflowId: created.value.workflow.id,
    } })
    expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(read)).version.definition)
      .toEqual(created.value.workflow)
  } finally { await f.close() }
}, 120_000)

it('requires save grants for initial graphs while preserving metadata-only creation and HTTP parity', async () => {
  const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single') })
  try {
    const workspaceId = f.f.scope.workspaceId
    const input = {
      workspaceId, commandId: randomUUID(), name: 'Protected creation', defaultWorktree: null,
      initialSave: initialSave(f.f.version.definition, f.f.version.agentConfigurationVersionIds),
    }
    const issue = (actions: Array<(typeof ManagementActionSchema.options)[number]>) => f.access.issue({
      name: 'Restricted creator', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions, scope: { workspaceIds: [workspaceId] } }],
    })
    const createOnly = await issue(['workflows:create'])
    const reader = await issue(['workflows:read', 'graph:read'])
    for (const token of [createOnly.token, reader.token]) {
      const client = await f.connect(token)
      const denied = await client.callTool({ name: 'workflow_create', arguments: input })
      expect(denied.isError).toBe(true)
      expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    }
    const createClient = await f.connect(createOnly.token)
    const empty = await createClient.callTool({ name: 'workflow_create', arguments: {
      workspaceId, commandId: randomUUID(), name: 'Intentionally unsaved', defaultWorktree: null,
    } })
    expect(empty.isError).not.toBe(true)
    expect(SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(empty)).value.currentVersionId).toBeNull()
    const scoped = await f.access.issue({ name: 'Other workflow only', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [
        { actions: ['workflows:create'], scope: { workspaceIds: [workspaceId] } },
        { actions: ManagementActionSchema.options, scope: { workspaceIds: [workspaceId], workflowIds: [f.f.scope.workflowId] } },
      ] })
    const scopedClient = await f.connect(scoped.token)
    const deniedScope = await scopedClient.callTool({ name: 'workflow_create', arguments: input })
    expect(decodeMcpToolResult(deniedScope)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    const list = await f.client.callTool({ name: 'workflow_list', arguments: { workspaceId, limit: 100 } })
    expect(WorkflowSummaryPageSchema.parse(decodeMcpToolResult(list)).items.some(item => item.workflow.name === input.name))
      .toBe(false)

    const http = await f.app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/workflows`,
      headers: { authorization: `Bearer ${f.writer.token}` }, payload: input,
    })
    expect(http.statusCode, http.body).toBe(201)
    const created = SavedManagedWorkflowCommandResultSchema.parse(http.json())
    expect(created.value.workflow).not.toHaveProperty('description')
    expect(created.value.workflow).not.toHaveProperty('defaultWorktree')
    const read = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
      workspaceId, workflowId: created.value.workflow.id,
    } })
    expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(read)).version.definition)
      .toEqual(created.value.workflow)
    const replay = await f.client.callTool({ name: 'workflow_create', arguments: input })
    expect(SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(replay)))
      .toEqual({ ...created, replayed: true })
    const deniedReplay = await createClient.callTool({ name: 'workflow_create', arguments: input })
    expect(decodeMcpToolResult(deniedReplay)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    const deniedHttp = await f.app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/workflows`,
      headers: { authorization: `Bearer ${createOnly.token}` }, payload: { ...input, commandId: randomUUID() },
    })
    expect(deniedHttp.statusCode).toBe(403)
  } finally { await f.close() }
}, 120_000)
