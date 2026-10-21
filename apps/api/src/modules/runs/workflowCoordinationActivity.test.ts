import { describe, expect, it } from 'vitest'
import { COORDINATION_RESULT_PROTOCOL } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { publicRunActivity, type ActivityReadRow } from './activityProjection.js'

function fixture(form: 'single' | 'repeat' = 'single') {
  const f = makeCurrentWorkflowFixture(`activity-${form}`, form)
  const node = f.version.definition.nodes[form === 'repeat' ? 1 : 0]!
  const row: ActivityReadRow = { sequence: '1', source: 'backend', kind: 'result_recorded',
    occurred_at: new Date('2026-10-21T10:00:00.000Z'), harness_execution_id: 'execution',
    execution_node_id: node.id, execution_agent_id: node.agentId, execution_attempt: 1,
    work_activation_id: 'activation', result_outcome: 'succeeded', safe_payload: {}, native: null }
  return { f, node, row }
}
const board = { kind: 'none', reason: 'no_changes' }

describe('coordinated result activity readback', () => {
  it('projects a bounded model summary from the exact marked plain result without exposing board changes', () => {
    const { f, row } = fixture()
    row.result_protocol = COORDINATION_RESULT_PROTOCOL
    row.work_result = { outcome: 'succeeded', output: { data: { answer: 'Finished' }, summary: 's'.repeat(600), board } }
    const before = structuredClone(row.work_result)
    const projected = publicRunActivity(row, f.version, f.run.id, 'pending')
    expect(projected).toMatchObject({ status: 'completed', summary: 's'.repeat(240), refs: { executionId: 'execution' } })
    expect(projected.workResult).toBeUndefined()
    expect(row.work_result).toEqual(before)
  })

  it.each(['handoff', 'repeat'] as const)('preserves %s business findings in marked result activity', mode => {
    const { f, row } = fixture(mode === 'repeat' ? 'repeat' : 'single')
    if (mode === 'handoff') f.version.definition.handoffs = { contractVersion: 1 }
    row.result_protocol = COORDINATION_RESULT_PROTOCOL
    row.work_result = { outcome: 'succeeded', output: { text: JSON.stringify({
      routing: mode === 'handoff' ? { kind: 'finish' } : { outcome: 'issues' },
      data: { latestDeliverable: { answer: 'Concrete work' }, remainingFindings: ['Resolve the open choice'] },
      summary: 'Work is ready for a decision', board,
    }) } }
    expect(publicRunActivity(row, f.version, f.run.id, 'pending')).toMatchObject({
      summary: 'Work is ready for a decision', workResult: { outcome: mode === 'handoff' ? 'finish' : 'issues',
        latestDeliverable: { answer: 'Concrete work' }, remainingFindings: ['Resolve the open choice'] },
    })
  })

  it('keeps an unmarked historical handoff readable and does not reinterpret it as a valid marked result', () => {
    const { f, row } = fixture()
    f.version.definition.handoffs = { contractVersion: 1 }
    row.work_result = { outcome: 'succeeded', output: { routing: { kind: 'finish' },
      data: { latestDeliverable: 'Historical result', remainingFindings: [] } } }
    expect(publicRunActivity(row, f.version, f.run.id, 'succeeded').workResult).toEqual({ outcome: 'finish',
      latestDeliverable: 'Historical result', remainingFindings: [] })
    row.result_protocol = COORDINATION_RESULT_PROTOCOL
    expect(publicRunActivity(row, f.version, f.run.id, 'pending').workResult).toBeUndefined()
  })
})
