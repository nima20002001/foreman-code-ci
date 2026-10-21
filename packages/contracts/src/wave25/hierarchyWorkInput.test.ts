import { describe, expect, it } from 'vitest'
import { WorkActivationInputSchema, WorkReturnSchema } from './handoffs.js'
import { canonicalGraphJson } from './json.js'

const scope = { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version',
  runId: 'run', executionSemanticsVersion: 3 as const }
const digest = `sha256:${'1'.repeat(64)}`
function input(count = 3) {
  const requestIds = Array.from({ length: count }, (_, index) => `request-${index}`)
  return { executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null, predecessors: [],
    work: { kind: 'hierarchy_group', activation: { scope, activationId: 'summary', workflowNodeId: 'master',
      lineageId: 'run', cause: { kind: 'hierarchy_group', groupId: 'group' } },
    group: { scope, groupId: 'group', parentActivationId: 'parent', parentExecutionId: 'parent-execution',
      parentNodeId: 'master', continuationActivationId: 'summary', sourceResultDigest: digest,
      memberRequestIds: requestIds, createdAt: '2026-10-20T00:00:00Z' },
    returns: requestIds.map((requestId, index) => ({ requestId, destinationNodeId: `child-${index}`,
      returnId: `return-${index}`, sourceActivationId: `activation-${index}`, sourceExecutionId: `execution-${index}`,
      resultDigest: digest, outcome: 'accepted', summary: 'Complete', remainingFindingsCount: 0 })), failures: [] },
  }
}

describe('finite hierarchy feedback', () => {
  it('requires every admitted member to have exactly one truthful disposition', () => {
    const complete = input()
    expect(WorkActivationInputSchema.safeParse(complete).success).toBe(true)
    complete.work.returns.pop()
    expect(WorkActivationInputSchema.safeParse(complete).success).toBe(false)
    complete.work.returns.push(complete.work.returns[0]!)
    expect(WorkActivationInputSchema.safeParse(complete).success).toBe(false)
  })
  it('preserves accepted WorkReturn without a continuation and needs_changes with one', () => {
    const returned = { scope, returnId: 'return', requestId: 'request', sourceActivationId: 'child',
      sourceExecutionId: 'execution', requesterActivationId: 'parent', acceptedResultDigest: digest,
      outcome: 'accepted', latestDeliverable: 'Done', remainingFindings: [], returnedAt: '2026-10-20T00:00:00Z' }
    expect(WorkReturnSchema.safeParse(returned).success).toBe(true)
    expect(WorkReturnSchema.safeParse({ ...returned, continuationActivationId: 'summary' }).success).toBe(false)
    expect(WorkReturnSchema.safeParse({ ...returned, outcome: 'needs_changes', continuationActivationId: 'summary' }).success).toBe(true)
  })
  it('fits a thousand bounded escaped summaries and maximum identities with bounded original input', () => {
    const complete = input(1000)
    const id = (prefix: string) => prefix.padEnd(200, 'x')
    const returns = complete.work.returns.map((item, index) => ({ ...item,
      requestId: id(`request-${index}`), destinationNodeId: id(`child-${index}`),
      returnId: id(`return-${index}`), sourceActivationId: id(`activation-${index}`),
      sourceExecutionId: id(`execution-${index}`), outcome: 'needs_changes',
      continuationActivationId: id('summary'), summary: '\u0001'.repeat(300), remainingFindingsCount: 1000 }))
    const bounded = { ...complete, runInput: { request: 'x'.repeat(64 * 1024) }, work: { ...complete.work,
      activation: { ...complete.work.activation, activationId: id('summary') },
      group: { ...complete.work.group, continuationActivationId: id('summary'),
        memberRequestIds: returns.map(item => item.requestId) }, returns } }
    expect(WorkActivationInputSchema.safeParse(bounded).success).toBe(true)
    expect(new TextEncoder().encode(canonicalGraphJson(bounded, 4 * 1024 * 1024)).byteLength).toBeLessThan(4 * 1024 * 1024)
    bounded.work.returns[0]!.summary += '\u0001'
    expect(WorkActivationInputSchema.safeParse(bounded).success).toBe(false)
  })
})
