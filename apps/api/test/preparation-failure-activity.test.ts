import { expect, it } from 'vitest'
import { publicRunActivity, type ActivityReadRow } from '../src/modules/runs/activityProjection.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'

const fixture = currentUnitSnapshot('preparation-failure-activity', 'sequential')
const node = agentWorkflowNode(fixture.version.definition.nodes[0])

function failedActivity(message: string) {
  const row: ActivityReadRow = {
    sequence: '1', source: 'backend', kind: 'result_recorded', occurred_at: new Date(fixture.createdAt),
    harness_execution_id: 'execution', execution_node_id: node.id, execution_agent_id: node.agentId,
    execution_attempt: 1, work_activation_id: null, result_outcome: 'failed',
    work_result: { outcome: 'failed', error: { code: 'SOURCE_ROOT_CONFLICT', message, retryable: false } },
    safe_payload: {}, native: null,
  }
  return publicRunActivity(row, fixture.version, fixture.run.id, 'failed')
}

it('shows the preparation failure reason and failed status in public Run activity', () => {
  expect(failedActivity('The accepted source namespace changed.')).toMatchObject({
    status: 'failed', severity: 'error', refs: { executionId: 'execution' },
    detail: 'SOURCE_ROOT_CONFLICT: The accepted source namespace changed.',
  })
})

it('redacts credentials and bounds failure details for the public activity page', () => {
  const token = `opm_${'a'.repeat(43)}`
  const activity = failedActivity(`Source request ${token} failed. ${'x'.repeat(600)}`)
  expect(activity.detail).toContain('[REDACTED]')
  expect(activity.detail).not.toContain(token)
  expect(activity.detail!.length).toBeLessThanOrEqual(500)
})
