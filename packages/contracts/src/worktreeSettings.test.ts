import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AgentBranchPrefixSchema, AgentWorktreeSettingsSchema,
  SourceRootReferenceSchema, WorkflowWorktreeSettingsSchema } from './worktreeSettings.js'
import { CurrentWorkflowCreateInputSchema } from './wave25/currentAuthoring.js'
import { GraphDraftOperationV3Schema } from './wave25/currentBoardAuthoring.js'
import { CurrentWorkflowNodeSchema, WorkflowDefinitionV3Schema } from './wave25/workflowShape.js'
import { makeCurrentWorkflowFixture } from './wave25/currentFixture.js'
import { sameExecutableWorkflow } from './wave25/meaningfulEdit.js'
import { workflowRequiresWorkspaceDirectory, workflowUsesAgentPlacements } from './wave25/workflowExecutionLocation.js'

const rootBinding = { rootId: randomUUID(), bindingRevision: 1 }

describe('workflow worktree contracts', () => {
  it('accepts immutable root references and optional default branch prefixes', () => {
    expect(WorkflowWorktreeSettingsSchema.parse({ rootBinding })).toEqual({ rootBinding })
    expect(AgentWorktreeSettingsSchema.parse({ branchPrefix: 'foreman/site/review' }))
      .toEqual({ branchPrefix: 'foreman/site/review' })
    for (const bindingRevision of [0, -1, 1.5]) {
      expect(SourceRootReferenceSchema.safeParse({ ...rootBinding, bindingRevision }).success).toBe(false)
    }
    expect(SourceRootReferenceSchema.safeParse({ rootId: '/tmp/project', bindingRevision: 1 }).success).toBe(false)
  })

  it.each([
    'main', '--option', '/tmp/project', 'foreman/../outside', 'foreman/a//b', 'foreman/a/',
    'foreman/a.lock', 'foreman/a.lock/b', 'foreman/a.', 'foreman/.hidden', 'foreman/a\n',
    'foreman/a@{b', 'foreman/a b', 'foreman/a\\b',
  ])('rejects unsafe branch prefix %j', branchPrefix => {
    expect(AgentBranchPrefixSchema.safeParse(branchPrefix).success).toBe(false)
  })

  it('keeps absent historical settings absent and distinguishes creation opt-out', () => {
    const definition = makeCurrentWorkflowFixture().version.definition
    expect(WorkflowDefinitionV3Schema.parse(definition)).not.toHaveProperty('defaultWorktree')
    const create = { workspaceId: definition.workspaceId, commandId: randomUUID(), name: 'Example' }
    expect(CurrentWorkflowCreateInputSchema.parse(create)).not.toHaveProperty('defaultWorktree')
    expect(CurrentWorkflowCreateInputSchema.parse({ ...create, defaultWorktree: null })).toHaveProperty('defaultWorktree', null)
    expect(CurrentWorkflowCreateInputSchema.parse({ ...create, defaultWorktree: { rootBinding } }).defaultWorktree)
      .toEqual({ rootBinding })
  })

  it('treats root defaults and Agent branch overrides as executable changes', () => {
    const before = makeCurrentWorkflowFixture().version.definition
    const withDefault = { ...before, defaultWorktree: { rootBinding } }
    expect(sameExecutableWorkflow(before, withDefault)).toBe(false)
    const node = before.nodes[0]!
    const withBranch = { ...before, nodes: [{ ...node, worktree: { branchPrefix: 'foreman/review' } }, ...before.nodes.slice(1)] }
    expect(sameExecutableWorkflow(before, withBranch)).toBe(false)
    expect(workflowUsesAgentPlacements(withDefault)).toBe(true)
    expect(workflowRequiresWorkspaceDirectory(withDefault)).toBe(false)
    expect(workflowUsesAgentPlacements(withBranch)).toBe(true)
    const cleared = { ...withBranch, nodes: before.nodes }
    expect(sameExecutableWorkflow(before, cleared)).toBe(true)
  })

  it('allows clearing a draft default and rejects Agent settings on Jobs', () => {
    expect(GraphDraftOperationV3Schema.parse({ type: 'workflow.set_worktree', worktree: null }))
      .toEqual({ type: 'workflow.set_worktree', worktree: null })
    const job = { kind: 'job' as const, id: 'job', name: 'Build', jobDefinitionId: 'build',
      jobDefinitionRevision: 1, jobDefinitionVersionId: 'build-version' }
    expect(CurrentWorkflowNodeSchema.safeParse(job).success).toBe(true)
    expect(CurrentWorkflowNodeSchema.safeParse({ ...job, worktree: { branchPrefix: 'foreman/job' } }).success).toBe(false)
    const definition = makeCurrentWorkflowFixture().version.definition
    expect(workflowRequiresWorkspaceDirectory({ ...definition, defaultWorktree: { rootBinding }, nodes: [job] })).toBe(true)
  })
})
