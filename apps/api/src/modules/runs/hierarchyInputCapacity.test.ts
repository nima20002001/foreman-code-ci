import { describe, expect, it } from 'vitest'
import { HierarchyWorkGroupSchema, WorkActivationIdentitySchema, WorkActivationInputSchema,
  WorkReturnSchema } from '@foreman-code/contracts/wave25'
import { hasHierarchyParentInputCapacity } from './hierarchyInputCapacity.js'

function fixture(count: number) {
  const id = (prefix: string) => prefix.padEnd(200, 'x')
  const scope = { workspaceId: id('workspace'), workflowId: id('workflow'), workflowVersionId: id('version'),
    runId: id('run'), executionSemanticsVersion: 3 }
  const members = Array.from({ length: count }, (_, index) => ({
    requestId: id(`request-${index}`), destinationNodeId: id(`child-${index}`),
  }))
  const group = HierarchyWorkGroupSchema.parse({ scope, groupId: id('group'), parentActivationId: id('parent'),
    parentExecutionId: id('parent-execution'), parentNodeId: id('master'), continuationActivationId: id('summary'),
    sourceResultDigest: `sha256:${'1'.repeat(64)}`, memberRequestIds: members.map(member => member.requestId),
    createdAt: '2026-10-20T00:00:00Z' })
  const activation = WorkActivationIdentitySchema.parse({ scope, activationId: group.continuationActivationId,
    workflowNodeId: group.parentNodeId, lineageId: scope.runId, cause: { kind: 'hierarchy_group', groupId: group.groupId } })
  return { group, activation, members }
}

describe('hierarchy parent input reservation', () => {
  it('admits a bounded batch with worst-case feedback identities and original input', () => {
    const f = fixture(50)
    expect(hasHierarchyParentInputCapacity(f.group, f.activation, { request: 'x'.repeat(64 * 1024) }, f.members)).toBe(true)
  })
  it.each([70, 1000])('refuses %i children whose individually valid expanded returns cannot fit the parent', count => {
    const f = fixture(count)
    const returns = f.members.map((member, index) => {
      const returned = WorkReturnSchema.parse({ scope: f.group.scope, returnId: `return-${index}`,
        requestId: member.requestId, sourceActivationId: `activation-${index}`, sourceExecutionId: `execution-${index}`,
        requesterActivationId: f.group.parentActivationId, acceptedResultDigest: f.group.sourceResultDigest,
        outcome: 'accepted', latestDeliverable: 'x'.repeat(60 * 1024), remainingFindings: [], returnedAt: f.group.createdAt })
      return { ...member, returnId: returned.returnId, sourceActivationId: returned.sourceActivationId,
        sourceExecutionId: returned.sourceExecutionId, resultDigest: returned.acceptedResultDigest,
        outcome: returned.outcome, summary: 'Completed', remainingFindingsCount: 0,
        latestDeliverable: returned.latestDeliverable, remainingFindings: returned.remainingFindings }
    })
    const input = { executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null, predecessors: [],
      work: { kind: 'hierarchy_group', activation: f.activation, group: f.group, returns, failures: [] } }
    const parsed = WorkActivationInputSchema.safeParse(input)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'WORK_ACTIVATION_INPUT_TOO_LARGE' }),
    ]))
    expect(hasHierarchyParentInputCapacity(f.group, f.activation, {}, f.members)).toBe(false)
  })
  it('refuses a valid near-limit original input before a small group can strand its parent', () => {
    const f = fixture(2)
    expect(hasHierarchyParentInputCapacity(f.group, f.activation,
      { request: 'x'.repeat(4 * 1024 * 1024 - 2048) }, f.members)).toBe(false)
    expect(hasHierarchyParentInputCapacity(f.group, f.activation, { request: 'x'.repeat(3 * 1024 * 1024) }, f.members)).toBe(true)
  })
  it('accounts for expanded feedback at the saved sixteen-route limit', () => {
    const f = fixture(16)
    expect(hasHierarchyParentInputCapacity(f.group, f.activation,
      { request: 'x'.repeat(3.5 * 1024 * 1024) }, f.members)).toBe(false)
  })
})
