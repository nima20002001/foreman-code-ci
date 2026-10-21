import { describe, expect, it } from 'vitest'
import { CiActivitySchema } from '@foreman-code/contracts'
import { publicRunActivity, type ActivityReadRow } from '../src/modules/runs/activityProjection.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'

const fixture = currentUnitSnapshot('ci-activity', 'single')
const node = agentWorkflowNode(fixture.version.definition.nodes[0])
const ci = CiActivitySchema.parse({
  id: '00000000-0000-4000-8000-000000000001', groupId: '00000000-0000-4000-8000-000000000002',
  suite: 'integration', part: null, partition: { index: 0, count: 2 }, state: 'queued',
  computer: null, step: null, exitCode: null, queuedAt: fixture.createdAt, startedAt: null, finishedAt: null,
})
const row: ActivityReadRow = {
  sequence: '1', source: 'backend', kind: 'ci_state_changed', occurred_at: new Date(fixture.createdAt),
  harness_execution_id: 'agent-execution', execution_node_id: node.id, execution_agent_id: node.agentId,
  execution_attempt: 1, work_activation_id: null, result_outcome: null, native: null,
  ci_ticket_id: ci.id, ci_activity: ci, safe_payload: { actorName: 'CI Agent' },
}
function project(value = row) {
  return publicRunActivity(value, fixture.version, fixture.run.id, fixture.run.outcome)
}

describe('Agent Host CI activity projection', () => {
  it.each([
    ['queued', 'queued'], ['starting', 'starting'], ['running', 'running'],
    ['passed', 'completed'], ['failed', 'failed'], ['canceled', 'canceled'], ['lost', 'unknown'],
  ] as const)('projects persisted %s as %s with Agent and CI identities', (state, status) => {
    expect(project({ ...row, ci_activity: { ...ci, state } })).toMatchObject({
      kind: 'job_work', status, actor: { agentId: node.agentId, nodeId: node.id },
      refs: { executionId: 'agent-execution', ciTicketId: ci.id, ciGroupId: ci.groupId },
      ci: { state, partition: { index: 0, count: 2 } }, summary: `CI integration ${state}`,
    })
  })

  it('does not claim CI status without its persisted ticket and initiating Agent', () => {
    const unavailable = project({ ...row, ci_ticket_id: null })
    expect(unavailable.status).toBe('unknown')
    expect(unavailable.refs.ciTicketId).toBeUndefined()
    expect(unavailable.ci).toBeUndefined()
    expect(project({ ...row, execution_agent_id: 'foreign-agent' }).status).toBe('unknown')
    expect(project({ ...row, ci_activity: { ...ci, id: ci.groupId } }).status).toBe('unknown')
  })

  it('rejects unknown suites and excludes arbitrary source payload', () => {
    const value = project({ ...row, ci_activity: { ...ci, suite: 'sk-private-suite' },
      safe_payload: { command: 'private command', secret: 'private secret' } })
    expect(value.summary).toBe('CI activity details unavailable')
    expect(value.ci).toBeUndefined()
    expect(JSON.stringify(value)).not.toContain('private')
  })

  it('preserves part, computer, step and exit code without raw CI logs', () => {
    const activity = { ...ci, suite: 'build', part: 'build-api', partition: null, state: 'failed',
      computer: { hostRef: { kind: 'main', mainId: 'synthetic-main' }, label: 'Build computer' },
      step: 'build', exitCode: 1, startedAt: fixture.createdAt, finishedAt: fixture.createdAt }
    const value = project({ ...row, ci_activity: activity, safe_payload: { logs: 'private logs' } })
    expect(value.ci).toEqual(activity)
    expect(value.severity).toBe('error')
    expect(JSON.stringify(value)).not.toContain('private logs')
  })
})
