import { expect, it } from 'vitest'
import { RunActivityPublicSchema, type RunActivityPublic } from '@foreman-code/contracts/wave25'
import { requireCiWorkflowActivity } from './helpers/crossComputerCiActivity.js'

const ticketId = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const expected = { runId: 'run', agentExecutionIds: ['agent-execution'], ciTicketIds: [ticketId] }
function activity(kind: RunActivityPublic['kind'], status: RunActivityPublic['status'], sequence: number) {
  return RunActivityPublicSchema.parse({
    id: `activity-${sequence}`, sequence: String(sequence), occurredAt: '2026-10-09T00:00:00.000Z',
    scope: { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version', runId: 'run',
      executionSemanticsVersion: 3 },
    source: 'backend', kind, status, severity: 'info', summary: 'Activity',
    refs: { executionId: 'agent-execution', ...(kind === 'job_work' ? { ciTicketId: ticketId } : {}) },
  })
}
const agents = [activity('agent_work', 'running', 1), activity('agent_work', 'completed', 2)]
const ci = [activity('job_work', 'queued', 3), activity('job_work', 'running', 4), activity('job_work', 'completed', 5)]

it('requires persisted Agent and CI lifecycle activities', () => {
  expect(() => requireCiWorkflowActivity([...agents, ...ci], expected)).not.toThrow()
  // A ticket finishing between observations has no running activity.
  expect(() => requireCiWorkflowActivity([...agents, ci[0]!, ci[2]!], expected)).not.toThrow()
})
it('rejects empty history and generic tool activity without CI status', () => {
  expect(() => requireCiWorkflowActivity([], expected)).toThrow('Agent')
  expect(() => requireCiWorkflowActivity([...agents, activity('tool_action', 'completed', 3)], expected)).toThrow('CI')
})
it('rejects missing CI phases or another workflow’s job', () => {
  expect(() => requireCiWorkflowActivity([...agents, ...ci.slice(1)], expected)).toThrow('queued')
  expect(() => requireCiWorkflowActivity([...agents, ...ci.map(item => ({ ...item,
    refs: { ...item.refs, ciTicketId: '7a2b3c4d-5e6f-4a70-8b8c-9d0e1f2a3b4c' } }))], expected)).toThrow('CI')
})

it('requires queued before terminal by sequence without requiring intermediate observations', () => {
  expect(() => requireCiWorkflowActivity([agents[1]!, ci[0]!, ci[2]!], expected)).not.toThrow()
  expect(() => requireCiWorkflowActivity([...agents, { ...ci[2]!, sequence: '3' },
    { ...ci[0]!, sequence: '5' }], expected)).toThrow('order')
})
