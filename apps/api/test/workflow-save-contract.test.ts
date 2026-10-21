import { describe, expect, it } from 'vitest'
import { CurrentWorkflowSaveInputSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

describe('executable workflow save contract', () => {
  it('keeps repeat absent for ordinary saves and rejects empty repeat plans and retired execution tags', () => {
    for (const form of ['single', 'repeat'] as const) {
      const fixture = makeCurrentWorkflowFixture('publication-contract', form)
      const input = {
        workspaceId: fixture.scope.workspaceId,
        workflowId: fixture.scope.workflowId,
        commandId: 'publication-command',
        executionSemanticsVersion: 3,
        expectedRevision: 1,
        expectedWorkflowVersionId: null,
        expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
        graph: fixture.version.definition,
      }
      const parsed = CurrentWorkflowSaveInputSchema.parse(input)
      expect(parsed.graph).toEqual(fixture.version.definition)
      expect(Object.hasOwn(parsed.graph, 'repeat')).toBe(form === 'repeat')
      expect(CurrentWorkflowSaveInputSchema.safeParse({
        ...input, graph: { ...input.graph, repeat: { blocks: [] } },
      }).success).toBe(false)
      for (const executionSemanticsVersion of [1, 2, 4]) {
        expect(CurrentWorkflowSaveInputSchema.safeParse({ ...input, executionSemanticsVersion }).success).toBe(false)
        expect(CurrentWorkflowSaveInputSchema.safeParse({
          ...input, graph: { ...input.graph, executionSemanticsVersion },
        }).success).toBe(false)
      }
    }
  })
})
