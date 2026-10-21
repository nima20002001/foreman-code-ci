import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from './currentFixture.js'
import { CurrentWorkflowSaveInputSchema, CurrentWorkflowValidateInputSchema } from './currentAuthoring.js'
import { CurrentEditMutationToolInputSchema, CurrentEditStageInputSchema } from './currentEditIntent.js'

describe('workflow authoring', () => {
  it('accepts save, validation and MCP staging without presentation, geometry or location baselines', () => {
    const fixture = makeCurrentWorkflowFixture('authoring')
    const definition = {
      workspaceId: fixture.scope.workspaceId,
      workflowId: fixture.scope.workflowId,
      executionSemanticsVersion: 3,
      expectedRevision: 1,
      expectedWorkflowVersionId: fixture.version.id,
      expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
      graph: fixture.version.definition,
    }
    expect(CurrentWorkflowValidateInputSchema.safeParse(definition).success).toBe(true)
    const save = { ...definition, commandId: 'save-command' }
    expect(CurrentWorkflowSaveInputSchema.parse(save)).toEqual(save)
    const stage = { ...save, action: 'stage_edits', draftId: 'draft' }
    expect(CurrentEditStageInputSchema.parse(stage)).toEqual(stage)
    expect(CurrentEditMutationToolInputSchema.parse(stage)).toEqual(stage)
  })
})
