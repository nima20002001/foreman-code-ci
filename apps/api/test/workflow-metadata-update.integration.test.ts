import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  CurrentWorkflowReadResultSchema, SavedManagedWorkflowCommandResultSchema, SavedManagedWorkflowSchema,
  makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { setupWorkflowCreateIntegration } from './helpers/operatorWorkflowCreate.js'

const metadataIntegration = setupWorkflowCreateIntegration()

it.each([
  { label: 'rename', name: 'Renamed workflow' },
  { label: 'change description', description: 'Updated description' },
  { label: 'remove description', description: null },
])('persists a metadata $label through authenticated MCP while retaining the saved version', async ({ label, ...metadata }) => {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  fixture.version.definition.description = 'Original description'
  const f = await metadataIntegration({ fixture })
  const scope = { workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId }
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await f.client.callTool({ name, arguments: args })
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true)
    return decodeMcpToolResult(reply)
  }
  try {
    const original = SavedManagedWorkflowSchema.parse(await call('workflow_get', scope))
    const saved = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', scope))
    const input = { ...scope, commandId: randomUUID(), expectedRevision: original.revision, ...metadata }
    const reader = await f.access.issue({ name: `Workflow metadata reader (${label})`, audience: 'operator',
      grants: [{ actions: ['workflows:read'], scope: {
        workspaceIds: [scope.workspaceId], workflowIds: [scope.workflowId],
      } }], expiresAt: new Date(Date.now() + 60_000) })
    const deniedClient = await f.connect(reader.token)
    await expectMcpAccessDenied(deniedClient.callTool({ name: 'workflow_update', arguments: input }))
    expect(SavedManagedWorkflowSchema.parse(await call('workflow_get', scope))).toEqual(original)

    const updated = SavedManagedWorkflowCommandResultSchema.parse(await call('workflow_update', input))
    const readback = SavedManagedWorkflowSchema.parse(await call('workflow_get', scope))
    expect(readback).toEqual(updated.value)
    expect(readback.revision).toBe(original.revision + 1)
    expect(readback.currentVersionId).toBe(saved.currentVersionId)
    expect(readback.workflow.name).toBe(metadata.name ?? original.workflow.name)
    const description = metadata.description === null ? undefined : metadata.description ?? original.workflow.description
    expect(readback.workflow.description).toBe(description)
    const immutable = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', scope))
    expect(immutable.revision).toBe(readback.revision)
    expect(immutable.version).toEqual(saved.version)
    expect(SavedManagedWorkflowCommandResultSchema.parse(await call('workflow_update', input)))
      .toEqual({ ...updated, replayed: true })
  } finally {
    await f.close()
  }
}, 120_000)
