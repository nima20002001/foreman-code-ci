import { describe, expect, it } from 'vitest'
import { RepeatWorkflowReadbackSchema } from './repeatReadback.js'

describe('repeat readback transport contract', () => {
  it('rejects mismatched persisted version identity', () => {
    expect(() => RepeatWorkflowReadbackSchema.parse({
      contractVersion: 1, executionSemanticsVersion: 3,
      workspaceId: 'workspace-1', workflowId: 'workflow-1', revision: 2,
      currentVersionId: 'other-version',
      version: {},
    })).toThrow()
  })
})
