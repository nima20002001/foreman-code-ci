import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  CurrentWorkflowCreateInputSchema, CurrentWorkflowReadResultSchema,
  SavedManagedWorkflowCommandResultSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { initialSave, setupWorkflowCreateIntegration } from './helpers/operatorWorkflowCreate.js'

const currentOperatorIntegration = setupWorkflowCreateIntegration()

it.each(['single', 'repeat'] as const)('publishes an initial $form graph through the shared service', async (form) => {
  const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), form) })
  try {
    const workspaceId = f.f.scope.workspaceId
    const input = CurrentWorkflowCreateInputSchema.parse({
      workspaceId,
      commandId: randomUUID(),
      name: 'Shared service creation',
      defaultWorktree: null,
      initialSave: initialSave(f.f.version.definition, f.f.version.agentConfigurationVersionIds),
    })
    // Call the public service directly so failures retain their original exception and stack.
    const created = SavedManagedWorkflowCommandResultSchema.parse(
      await f.services.workflows.create(f.writer.principal, 'mcp', input),
    )
    expect(created.replayed).toBe(false)
    expect(created.value.revision).toBe(2)
    expect(created.value.currentVersionId).not.toBeNull()
    expect(created.value.workflow).not.toHaveProperty('description')
    expect(created.value.workflow).not.toHaveProperty('defaultWorktree')
    const read = CurrentWorkflowReadResultSchema.parse(await f.services.workflows.current.read(f.writer.principal, {
      workspaceId,
      workflowId: created.value.workflow.id,
    }))
    expect(read.currentVersionId).toBe(created.value.currentVersionId)
    expect(read.version.definition).toEqual(created.value.workflow)
    expect(read.version.agentConfigurationVersionIds).toEqual(input.initialSave!.expectedAgentConfigurationVersionIds)
    expect(SavedManagedWorkflowCommandResultSchema.parse(
      await f.services.workflows.create(f.writer.principal, 'mcp', input),
    )).toEqual({ ...created, replayed: true })
  } finally {
    await f.close()
  }
}, 120_000)
