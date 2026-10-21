import { expect, it } from 'vitest'
import { CurrentWorkflowCreateInputSchema } from './currentAuthoring.js'
import { makeCurrentWorkflowFixture } from './currentFixture.js'

function request() {
  const fixture = makeCurrentWorkflowFixture('creation-contract', 'single')
  const graph = fixture.version.definition
  return {
    workspaceId: fixture.scope.workspaceId,
    commandId: 'create-with-save',
    name: 'Created workflow',
    initialSave: {
      graph: {
        executionSemanticsVersion: graph.executionSemanticsVersion,
        entryNodeId: graph.entryNodeId,
        executionCondition: graph.executionCondition,
        approval: graph.approval,
        executionPolicy: graph.executionPolicy,
        nodes: graph.nodes,
        edges: graph.edges,
      },
      expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
    },
  }
}

it('accepts initial graph settings and requires configuration references', () => {
  const input = request()
  expect(CurrentWorkflowCreateInputSchema.parse(input)).toEqual(input)
  for (const pin of ['expectedAgentConfigurationVersionIds'] as const) {
    const save: Record<string, unknown> = { ...input.initialSave }
    delete save[pin]
    expect(CurrentWorkflowCreateInputSchema.safeParse({ ...input, initialSave: save }).success).toBe(false)
  }
})

it('reserves workflow identity, metadata and default worktree for creation', () => {
  const input = request()
  const reserved = {
    id: 'caller-id', workspaceId: 'caller-workspace', name: 'Caller name', description: 'Caller description',
    defaultWorktree: { rootBinding: { rootId: 'root', bindingRevision: 1 } },
    version: 1, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
  }
  for (const [field, value] of Object.entries(reserved)) {
    const graph = { ...input.initialSave.graph, [field]: value }
    expect(CurrentWorkflowCreateInputSchema.safeParse({ ...input, initialSave: { ...input.initialSave, graph } }).success)
      .toBe(false)
  }
  expect(CurrentWorkflowCreateInputSchema.safeParse({ ...input, executionSemanticsVersion: 2 }).success).toBe(false)
  expect(CurrentWorkflowCreateInputSchema.safeParse({ ...input,
    initialSave: { ...input.initialSave, graph: { ...input.initialSave.graph, executionSemanticsVersion: 2 } },
  }).success).toBe(false)
})

it('preserves metadata-only workflow creation', () => {
  expect(CurrentWorkflowCreateInputSchema.parse({ workspaceId: 'workspace', commandId: 'create-empty', name: 'Empty' }))
    .toEqual({ workspaceId: 'workspace', commandId: 'create-empty', name: 'Empty' })
})
