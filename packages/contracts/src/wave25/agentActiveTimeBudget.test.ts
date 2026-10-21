import { describe, expect, it } from 'vitest'
import { WorkflowExecutionPolicySchema, MAX_AGENT_ACTIVE_TIMEOUT_MS } from './workflowShape.js'
import { CurrentWorkflowSaveInputSchema } from './currentAuthoring.js'
import { makeCurrentWorkflowFixture } from './currentFixture.js'
import { sameExecutableWorkflow } from './meaningfulEdit.js'
import { GraphDraftOperationV3Schema } from './currentBoardAuthoring.js'
import { CURRENT_WORKFLOW_CAPABILITIES } from './currentAuthoring.js'

describe('Agent active-time budget', () => {
  const policy = { maxParallelism: 2, maxNodeExecutions: 10 }
  it('offers six hours per execution while excluding approval waits', () => {
    expect(CURRENT_WORKFLOW_CAPABILITIES.agentActiveTimeBudget).toEqual({
      defaultMs: 21_600_000, maximumMs: MAX_AGENT_ACTIVE_TIMEOUT_MS,
      perExecution: true, approvalWaitExcluded: true,
    })
  })
  it('preserves omission instead of writing a default into saved facts', () => {
    expect(WorkflowExecutionPolicySchema.parse(policy)).toEqual(policy)
  })
  it.each([1, 300_000, 3_600_000, MAX_AGENT_ACTIVE_TIMEOUT_MS])('accepts %i milliseconds', (agentActiveTimeoutMs) => {
    expect(WorkflowExecutionPolicySchema.parse({ ...policy, agentActiveTimeoutMs }).agentActiveTimeoutMs)
      .toBe(agentActiveTimeoutMs)
  })
  it.each([0, -1, 1.5, NaN, Infinity, MAX_AGENT_ACTIVE_TIMEOUT_MS + 1, null, '300000'])(
    'rejects invalid budget %s', (agentActiveTimeoutMs) => {
      expect(WorkflowExecutionPolicySchema.safeParse({ ...policy, agentActiveTimeoutMs }).success).toBe(false)
    })
  it('round trips the override through the shared save schema as an executable edit', () => {
    const { version } = makeCurrentWorkflowFixture('active-time')
    const graph = structuredClone(version.definition)
    graph.executionPolicy!.agentActiveTimeoutMs = 3_600_000
    const parsed = CurrentWorkflowSaveInputSchema.parse({ workspaceId: graph.workspaceId, workflowId: graph.id,
      commandId: 'budget-command', executionSemanticsVersion: 3, expectedRevision: 1,
      expectedWorkflowVersionId: version.id, expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
      graph })
    expect(parsed.graph.executionPolicy?.agentActiveTimeoutMs).toBe(3_600_000)
    expect(sameExecutableWorkflow(version.definition, parsed.graph)).toBe(false)
  })
  it('preserves an override and its removal in shared execution-limit operations', () => {
    const override = { type: 'workflow.set_execution_limits', ...policy, agentActiveTimeoutMs: 3_600_000 }
    expect(GraphDraftOperationV3Schema.parse(override)).toEqual(override)
    const inherited = { type: 'workflow.set_execution_limits', ...policy }
    expect(GraphDraftOperationV3Schema.parse(inherited)).toEqual(inherited)
    expect(GraphDraftOperationV3Schema.safeParse({ ...override, agentActiveTimeoutMs: 0 }).success).toBe(false)
  })
})
