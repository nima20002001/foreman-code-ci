import { describe, expect, it } from 'vitest'
import { GraphDraftV3Schema, GraphDraftOperationV3Schema, WorkflowChoiceSchema,
  WorkflowVersionV3Schema, ChoiceResultEnvelopeSchema } from '@foreman-code/contracts/wave25'
import { fixture } from './core.cases'
import { draftOperations, removeRelationship } from './model'

function version() {
  const { draft } = fixture()
  return { id: 'workflow-version-1', workspaceId: draft.workspaceId, workflowId: draft.workflowId,
    version: 1, entryNodeId: 'node-0', executionSemanticsVersion: 3 as const, definition: draft.graph,
    agentConfigurationVersionIds: { 'agent-0': 'configuration-0', 'agent-1': 'configuration-1' },
    approval: { handler: 'user' as const }, contentHash: `sha256:${'0'.repeat(64)}`, createdAt: '2026-09-22T00:00:00Z' }
}
describe('Agent 6 consumes frozen S2 schemas without a private contract', () => {
  it('fixture draft and generated typed removal operations round-trip', () => {
    const context = fixture()
    GraphDraftV3Schema.parse(context.draft)
    const graph = removeRelationship(context.draft.graph, 'execution-1')
    const operations = draftOperations(context, graph)
    expect(operations.map((operation) => GraphDraftOperationV3Schema.parse(operation))).toEqual(operations)
  })
  it('accepts an explicit branch end but rejects an incomplete or duplicate outcome', () => {
    expect(WorkflowChoiceSchema.safeParse({ outcomes: [{ outcome: 'done', target: { kind: 'branch_end' } }] }).success).toBe(true)
    expect(WorkflowChoiceSchema.safeParse({ outcomes: [] }).success).toBe(false)
    expect(WorkflowChoiceSchema.safeParse({ outcomes: [{ outcome: 'done', target: { kind: 'edge', relationshipId: '' } }] }).success).toBe(false)
    expect(WorkflowChoiceSchema.safeParse({ outcomes: Array.from({ length: 2 }, () => ({ outcome: 'done', target: { kind: 'branch_end' } })) }).success).toBe(false)
  })
  it('the help envelope is strict: data is required; target node IDs and expressions are forbidden', () => {
    expect(ChoiceResultEnvelopeSchema.safeParse({ routing: { outcome: 'approved' }, data: {} }).success).toBe(true)
    expect(ChoiceResultEnvelopeSchema.safeParse({ routing: { outcome: 'approved' } }).success).toBe(false)
    expect(ChoiceResultEnvelopeSchema.safeParse({ routing: { outcome: 'approved', nodeId: 'node-1' }, data: {} }).success).toBe(false)
    expect(ChoiceResultEnvelopeSchema.safeParse({ routing: { outcome: 'approved' }, data: {}, expression: 'true' }).success).toBe(false)
  })
  it('entry dependency, cycle and dangling choice targets fail immutable acceptance', () => {
    expect(WorkflowVersionV3Schema.safeParse(version()).success).toBe(true)
    const dependency = version()
    dependency.definition.edges.push({ id: 'cycle', source: 'node-1', target: 'node-0', kind: 'execution' })
    expect(WorkflowVersionV3Schema.safeParse(dependency).success).toBe(false)
    const dangling = version()
    dangling.definition.nodes[0]!.choice = { outcomes: [{ outcome: 'selected', target: { kind: 'edge', relationshipId: 'missing' } }] }
    expect(WorkflowVersionV3Schema.safeParse(dangling).success).toBe(false)
  })
})
