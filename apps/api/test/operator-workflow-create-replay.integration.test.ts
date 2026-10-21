import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  CurrentWorkflowCreateInputSchema, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema,
  SavedManagedWorkflowCommandResultSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { initialSave, setupWorkflowCreateIntegration } from './helpers/operatorWorkflowCreate.js'

const currentOperatorIntegration = setupWorkflowCreateIntegration()

it.each([
  { form: 'single', description: 'Initial graph' },
  { form: 'repeat', description: 'Initial graph' },
  { form: 'single' },
  { form: 'repeat' },
] as const)('creates and replays a saved $form workflow (description: $description)', async (metadata) => {
  const { form } = metadata
  const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), form) })
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await f.client.callTool({ name, arguments: args })
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true)
    return decodeMcpToolResult(reply)
  }
  try {
    const workspaceId = f.f.scope.workspaceId
    const input = CurrentWorkflowCreateInputSchema.parse({
      workspaceId, commandId: randomUUID(), name: 'Saved at creation', defaultWorktree: null,
      ...('description' in metadata ? { description: metadata.description } : {}),
      initialSave: initialSave(f.f.version.definition, f.f.version.agentConfigurationVersionIds),
    })
    const catalog = await f.client.listTools()
    expect(catalog.tools.find(tool => tool.name === 'workflow_create')?.inputSchema.properties)
      .toHaveProperty('initialSave')
    const schema = await call('operator_tool_schema_get', { name: 'workflow_create' })
    expect(schema).toMatchObject({ permissionRequirements: {
      actions: expect.arrayContaining(['workflows:create']),
      detail: expect.stringContaining('graph:read/edit/save'),
    } })
    const capabilities = await call('operator_get_capabilities', {})
    expect(capabilities).toMatchObject({ runtimeLimits: expect.arrayContaining([
      expect.objectContaining({ feature: 'workflow_create_initial_save' }),
    ]) })
    const created = SavedManagedWorkflowCommandResultSchema.parse(await call('workflow_create', input))
    expect(created.replayed).toBe(false)
    expect(created.value.currentVersionId).not.toBeNull()
    expect(created.value.revision).toBe(2)
    const read = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', {
      workspaceId, workflowId: created.value.workflow.id,
    }))
    expect(read.currentVersionId).toBe(created.value.currentVersionId)
    expect(read.version.definition).toEqual(created.value.workflow)
    expect(read.version.definition.name).toBe(input.name)
    expect(read.version.definition.description).toBe(input.description)
    if (!('description' in metadata)) expect(read.version.definition).not.toHaveProperty('description')
    expect(read.version.definition).not.toHaveProperty('defaultWorktree')
    expect(read.version.agentConfigurationVersionIds).toEqual(input.initialSave!.expectedAgentConfigurationVersionIds)
    expect(read.version.definition.repeat).toEqual(input.initialSave!.graph.repeat)
    expect(read.version.definition).not.toHaveProperty('handoffs')
    expect(SavedManagedWorkflowCommandResultSchema.parse(await call('workflow_create', input)))
      .toEqual({ ...created, replayed: true })

    const saved = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', {
      workspaceId, workflowId: created.value.workflow.id, commandId: randomUUID(), executionSemanticsVersion: 3,
      expectedRevision: read.revision, expectedWorkflowVersionId: read.currentVersionId,
      expectedAgentConfigurationVersionIds: read.version.agentConfigurationVersionIds,
      graph: { ...read.version.definition, description: 'Edited after creation' },
    }))
    expect(saved.value.revision).toBe(read.revision + 1)
    expect(SavedManagedWorkflowCommandResultSchema.parse(await call('workflow_create', input)))
      .toEqual({ ...created, replayed: true })
    const persisted = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', {
      workspaceId, workflowId: created.value.workflow.id,
    }))
    expect(persisted.version).toEqual(saved.value.version)
    const conflict = await f.client.callTool({ name: 'workflow_create', arguments: { ...input, name: 'Changed retry' } })
    expect(conflict.isError).toBe(true)
    expect(decodeMcpToolResult(conflict)).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } })
    const audits = await f.db.pool.query<{ action: string; outcome: string }>(
      'select action,outcome from management_audit where principal_id=$1 and target_key=any($2::text[])',
      [f.writer.principal.id, [`workspace:${workspaceId}:workflows:new`, `workflow:${created.value.workflow.id}:definition`]],
    )
    expect(audits.rows.filter(row => row.action === 'workflow.create' && row.outcome === 'succeeded')).toHaveLength(1)
    expect(audits.rows.filter(row => row.action === 'workflow.save.v3' && row.outcome === 'succeeded')).toHaveLength(2)
    expect(audits.rows).toEqual(expect.arrayContaining([
      { action: 'workflow.create', outcome: 'succeeded' },
      { action: 'workflow.save.v3', outcome: 'succeeded' },
    ]))
  } finally { await f.close() }
}, 120_000)
