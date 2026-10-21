import { describe, expect, it } from 'vitest'
import * as root from '../src/index.js'
import * as management from '../src/management/index.js'
import { WorkflowVersionPageSchema, WorkflowVersionResultSchema } from '../src/management/extensions.js'
import { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema, WorkflowRunV3Schema,
  SavedManagedWorkflowSchema, SavedRunDetailsSchema } from '../src/wave25/saved.js'
import { CurrentWorkflowSaveInputSchema, CurrentWorkflowReadResultSchema } from '../src/wave25/currentAuthoring.js'
import { ManualRunStartInputSchema, RunStartV3InputSchema, GraphDraftV3Schema } from '../src/wave25/repeatAdmission.js'
import { makeCurrentWorkflowFixture } from '../src/wave25/currentFixture.js'

const retiredTags = [undefined, null, 0, 1, 2, '1', '2', '3', 4] as const
const pageInfo = { nextCursor: null }
const forms = ['single', 'sequential', 'parallel', 'conditional', 'approval', 'repeat'] as const
const fixture = makeCurrentWorkflowFixture('retirement-boundaries')
const definition = fixture.version.definition
const managed = { workflow: definition, revision: 1, currentVersionId: fixture.version.id, archivedAt: null }
const save = {
  workspaceId: fixture.version.workspaceId, workflowId: fixture.version.workflowId,
  executionSemanticsVersion: 3, commandId: 'save-retirement-command', expectedRevision: 1,
  expectedWorkflowVersionId: fixture.version.id,
  expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
  graph: definition,
}
const start = {
  workspaceId: save.workspaceId, workflowId: save.workflowId, workflowVersionId: fixture.version.id,
  executionSemanticsVersion: 3, commandId: 'start-retirement-command', expectedWorkflowRevision: 1,
  expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
  expectedLocationRevision: 1, input: {},
}
const draft = {
  id: 'draft-retirement', workspaceId: save.workspaceId, workflowId: save.workflowId, revision: 1,
  baseWorkflowVersionId: fixture.version.id, publishedRevision: 1, graph: definition, stagedAgents: [],
  updatedByPrincipalId: 'principal-retirement', updatedAt: fixture.createdAt,
}

describe('ENG07 R01/R02 public execution-schema retirement', () => {
  it('removes the retired parsers instead of retaining compatibility unions', () => {
    for (const symbol of ['WorkflowDefinitionSchema', 'WorkflowVersionSchema', 'WorkflowDefinitionV2Schema',
      'CompatibleWorkflowDefinitionSchema', 'WorkflowJoinSchema', 'WorkflowRouteSchema', 'ResultConditionSchema', 'ResultConditionOperatorSchema']) {
      expect(root).not.toHaveProperty(symbol)
    }
    expect(management.ManagedWorkflowSchema.shape.workflow).toBe(WorkflowDefinitionV3Schema)
    expect(management.GraphDraftSchema.shape.graph).toBe(WorkflowDefinitionV3Schema)
    expect(WorkflowVersionResultSchema.shape.version).toBe(WorkflowVersionV3Schema)
    expect(root.SaveWorkflowRequestSchema.shape.workflow).toBe(WorkflowDefinitionV3Schema)
    expect(root.CreateRunRequestSchema).toBe(RunStartV3InputSchema)
    expect(management.RunStartInputSchema).toBe(RunStartV3InputSchema)
    expect(ManualRunStartInputSchema).toBe(RunStartV3InputSchema)
    expect(root.WorkflowRunSchema).toBe(WorkflowRunV3Schema)
  })

  it.each(forms)('round-trips %s through public management, saved versions and Run DTOs', (form) => {
    const { version, run } = makeCurrentWorkflowFixture(`retirement-${form}`, form)
    const value = { workflow: version.definition, revision: 1, currentVersionId: version.id, archivedAt: null }
    expect(management.ManagedWorkflowSchema.parse(value)).toEqual(value)
    expect(SavedManagedWorkflowSchema.parse(value)).toEqual(value)
    expect(WorkflowVersionPageSchema.parse({ items: [version], pageInfo }).items).toEqual([version])
    expect(WorkflowVersionResultSchema.parse({ version })).toEqual({ version })
    expect(root.SaveWorkflowResponseSchema.parse({ workflow: version.definition }).workflow).toEqual(version.definition)
    expect(root.WorkflowRunSchema.parse(run)).toEqual(run)
    expect(run).not.toHaveProperty('repeat')
    expect(version.definition).toHaveProperty('executionSemanticsVersion', 3)
    if (form === 'repeat') expect(version.definition.repeat?.blocks).toHaveLength(1)
    else expect(version.definition).not.toHaveProperty('repeat')
  })

  it('round-trips ordinary saved and managed drafts without fabricating repeat metadata', () => {
    expect(management.GraphDraftSchema.parse(draft)).toEqual(draft)
    expect(GraphDraftV3Schema.parse(draft)).toEqual(draft)
    expect(CurrentWorkflowSaveInputSchema.parse(save)).toEqual(save)
    expect(ManualRunStartInputSchema.parse(start)).toEqual(start)
  })

  it.each(retiredTags)('rejects definition tag %j at every published definition/draft boundary', (executionSemanticsVersion) => {
    const graph = { ...definition, executionSemanticsVersion }
    const before = structuredClone(graph)
    const checks = [
      WorkflowDefinitionV3Schema.safeParse(graph),
      root.SaveWorkflowRequestSchema.safeParse({ workspaceId: save.workspaceId, workflow: graph }),
      root.SaveWorkflowResponseSchema.safeParse({ workflow: graph }),
      root.GetWorkflowResponseSchema.safeParse({ workflow: graph }),
      root.WorkspaceDetailsResponseSchema.safeParse({ workspace: { id: save.workspaceId, name: 'Workspace' },
        agents: [], workflows: [graph], runs: [], resources: [] }),
      management.ManagedWorkflowSchema.safeParse({ ...managed, workflow: graph }),
      SavedManagedWorkflowSchema.safeParse({ ...managed, workflow: graph }),
      management.GraphDraftSchema.safeParse({ ...draft, graph }),
      GraphDraftV3Schema.safeParse({ ...draft, graph }),
      CurrentWorkflowSaveInputSchema.safeParse({ ...save, graph }),
      WorkflowVersionV3Schema.safeParse({ ...fixture.version, definition: graph }),
    ]
    expect(checks.every((result) => !result.success)).toBe(true)
    expect(graph).toEqual(before)
  })

  it.each(retiredTags)('rejects immutable/read/Save/Start envelope tag %j rather than repairing it', (executionSemanticsVersion) => {
    const version = { ...fixture.version, executionSemanticsVersion }
    const run = { ...fixture.run, executionSemanticsVersion }
    expect(WorkflowVersionV3Schema.safeParse(version).success).toBe(false)
    expect(WorkflowVersionPageSchema.safeParse({ items: [version], pageInfo }).success).toBe(false)
    expect(WorkflowVersionResultSchema.safeParse({ version }).success).toBe(false)
    expect(CurrentWorkflowReadResultSchema.safeParse({ workspaceId: save.workspaceId, workflowId: save.workflowId,
      revision: 1, currentVersionId: fixture.version.id, version }).success).toBe(false)
    expect(root.WorkflowRunSchema.safeParse(run).success).toBe(false)
    expect(SavedRunDetailsSchema.safeParse({ run, executions: [], activity: [] }).success).toBe(false)
    expect(CurrentWorkflowSaveInputSchema.safeParse({ ...save, executionSemanticsVersion }).success).toBe(false)
    for (const schema of [RunStartV3InputSchema, ManualRunStartInputSchema, management.RunStartInputSchema, root.CreateRunRequestSchema]) {
      expect(schema.safeParse({ ...start, executionSemanticsVersion }).success).toBe(false)
    }
  })

  it('retains strict pin requirements and rejects missing edge kinds, legacy routes and joins', () => {
    for (const field of ['workflowVersionId', 'expectedWorkflowRevision',
      'expectedAgentConfigurationVersionIds', 'expectedLocationRevision']) {
      expect(ManualRunStartInputSchema.safeParse({ ...start, [field]: undefined }).success).toBe(false)
    }
    const { commandId, ...withoutCommand } = start
    expect(ManualRunStartInputSchema.parse(withoutCommand).commandId).toEqual(expect.any(String))
    expect(ManualRunStartInputSchema.parse(start).commandId).toBe(commandId)
    expect(ManualRunStartInputSchema.safeParse({ ...start, draftId: 'draft-without-revision' }).success).toBe(false)
    expect(ManualRunStartInputSchema.safeParse({ ...start, expectedDraftRevision: 1 }).success).toBe(false)
    for (const change of [{ kind: undefined }, { route: { outcomes: ['succeeded'], maxTraversals: 2 } }, { maxTraversals: 2 }]) {
      const graph = { ...definition, edges: [{ ...definition.edges[0], ...change }] }
      expect(WorkflowDefinitionV3Schema.safeParse(graph).success).toBe(false)
      expect(CurrentWorkflowSaveInputSchema.safeParse({ ...save, graph }).success).toBe(false)
    }
    for (const join of [{ mode: 'any' }, { mode: 'threshold', required: 1 }, { mode: 'all', threshold: 1 }]) {
      expect(WorkflowDefinitionV3Schema.safeParse({ ...definition,
        nodes: definition.nodes.map((node) => ({ ...node, join })) }).success).toBe(false)
    }
    for (const repeat of [null, { contractVersion: 1, blocks: [] }]) {
      expect(WorkflowDefinitionV3Schema.safeParse({ ...definition, repeat }).success).toBe(false)
    }
  })
})
