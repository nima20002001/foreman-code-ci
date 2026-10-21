import { describe, expect, it } from 'vitest'
import { publicRunActivity, type ActivityReadRow } from '../src/modules/runs/activityProjection.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'

const fixture = currentUnitSnapshot('approval-activity')
const node = agentWorkflowNode(fixture.version.definition.nodes[0])
const row: ActivityReadRow = {
  sequence: '1', source: 'backend', kind: 'interaction_delivery_state',
  occurred_at: new Date(fixture.createdAt), harness_execution_id: 'execution',
  execution_node_id: node.id, execution_agent_id: node.agentId, execution_attempt: 1,
  work_activation_id: null, result_outcome: null, native: null,
  safe_payload: { interactionId: 'approval', actorName: 'Captured Worker' },
}

function project(overrides: Partial<ActivityReadRow> = {}) {
  return publicRunActivity({ ...row, ...overrides }, fixture.version, fixture.run.id, fixture.run.outcome)
}

describe('public approval activity', () => {
  it.each([
    ['delivery_pending', 'uncertain', 'unknown', 'warning', 'Approval delivery uncertain'],
    ['delivery_pending', 'submitted', 'pending', 'info', 'Approval delivery pending'],
    ['delivered', 'delivered', 'delivered', 'info', 'Approval delivered to provider'],
    ['delivery_failed', 'failed', 'delivery_failed', 'error', 'Approval delivery failed'],
  ])('projects %s/%s without changing delivery meaning', (status, deliveryState, expected, severity, summary) => {
    expect(project({ safe_payload: { ...row.safe_payload, status, deliveryState } }))
      .toMatchObject({ kind: 'approval', status: expected, severity, summary })
  })

  it.each(['not_started', 'pending', 'failed', 'submitted', 'uncertain', 'delivered'])(
    'projects cancellation ahead of retained %s delivery', (deliveryState) => {
      const failure = project({ safe_payload: { ...row.safe_payload, status: 'delivery_failed', deliveryState: 'failed' } })
      const canceled = project({ sequence: '2', kind: 'interaction_resolved',
        safe_payload: { ...row.safe_payload, status: 'canceled', deliveryState } })
      expect(canceled).toMatchObject({ status: 'canceled', severity: 'info', summary: 'Approval canceled' })
      expect(failure).toMatchObject({ status: 'delivery_failed', summary: 'Approval delivery failed' })
      expect(canceled.id).not.toBe(failure.id)
    },
  )

  it.each(['interaction_pending', 'interaction_decided', 'interaction_delivery_state',
    'interaction_resolved', 'interaction_worker_ack'])('associates %s with its saved Agent', (kind) => {
    expect(project({ kind })).toMatchObject({ actor: {
      agentId: node.agentId, nodeId: node.id, agentName: 'Captured Worker', nodeName: 'Captured Worker',
    }, refs: { executionId: 'execution' } })
    expect(project({ kind, execution_agent_id: 'foreign-agent' }).actor).toBeUndefined()
    expect(project({ kind, execution_node_id: 'foreign-node' }).actor).toBeUndefined()
  })

  it('keeps genuine Run events unowned', () => {
    expect(project({ kind: 'run_state_changed', harness_execution_id: null,
      execution_node_id: null, execution_agent_id: null }).actor).toBeUndefined()
  })
})
