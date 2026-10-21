import { describe, expect, it } from 'vitest'
import { publicRunActivity, type ActivityReadRow } from '../src/modules/runs/activityProjection.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'

const fixture = currentUnitSnapshot('activity-names', 'sequential')
const node = agentWorkflowNode(fixture.version.definition.nodes[0])
const row: ActivityReadRow = {
  sequence: '1', source: 'backend', kind: 'node_state_changed', occurred_at: new Date(fixture.createdAt),
  harness_execution_id: 'execution', execution_node_id: node.id, execution_agent_id: node.agentId,
  execution_attempt: 1, work_activation_id: null, result_outcome: null,
  safe_payload: { state: 'running', actorName: 'Admission name' }, native: null,
}

describe('Run activity admission names', () => {
  it('uses captured names for both Agent and node labels while preserving executable identity', () => {
    expect(publicRunActivity(row, fixture.version, fixture.run.id, fixture.run.outcome).actor).toEqual({
      agentId: node.agentId, nodeId: node.id, agentName: 'Admission name', nodeName: 'Admission name',
    })
    expect(publicRunActivity({ ...row, execution_agent_id: 'another-agent' },
      fixture.version, fixture.run.id, fixture.run.outcome).actor).toBeUndefined()
  })

  it('uses captured subject names without accepting an unpinned node reference', () => {
    const subject = agentWorkflowNode(fixture.version.definition.nodes[1])
    const activity = { ...row, kind: 'work_requester_reactivated', safe_payload: {
      requesterNodeId: subject.id, subjectName: 'Admission requester', activationId: 'activation',
    } }
    expect(publicRunActivity(activity, fixture.version, fixture.run.id, fixture.run.outcome)).toMatchObject({
      subject: { agentId: subject.agentId, nodeId: subject.id,
        agentName: 'Admission requester', nodeName: 'Admission requester' },
      summary: 'Admission requester continuation queued',
    })
    expect(publicRunActivity({ ...activity, safe_payload: { ...activity.safe_payload, requesterNodeId: 'foreign-node' } },
      fixture.version, fixture.run.id, fixture.run.outcome).subject).toBeUndefined()
  })

  it('keeps name redaction and does not substitute executable labels for a missing capture', () => {
    for (const actorName of [undefined, 'sk-private-credential']) {
      const activity = publicRunActivity({ ...row, safe_payload: { state: 'running', actorName } },
        fixture.version, fixture.run.id, fixture.run.outcome)
      expect(activity.actor).toMatchObject({ agentName: 'Agent', nodeName: 'Agent' })
      expect(JSON.stringify(activity)).not.toContain('sk-private-credential')
      expect(JSON.stringify(activity)).not.toContain(node.name)
    }
  })

  it('names an interval check execution as a check, from start to finish', () => {
    const at = (state: string, check?: number) => publicRunActivity({ ...row, execution_tick_index: check ?? null,
      result_outcome: state === 'completed' ? 'succeeded' : null, safe_payload: { state, actorName: 'Admission name' } },
    fixture.version, fixture.run.id, fixture.run.outcome)
    expect(at('queued', 3)).toMatchObject({ status: 'queued', summary: 'Loop 3 queued' })
    expect(at('starting', 3)).toMatchObject({ status: 'starting', summary: 'Loop 3 starting' })
    expect(at('running', 3)).toMatchObject({ status: 'running', summary: 'Looping · loop 3' })
    expect(at('completed', 3)).toMatchObject({ status: 'completed', summary: 'Loop 3 finished' })
    expect(at('running')).toMatchObject({ status: 'running', summary: 'Agent working' })
  })
})
