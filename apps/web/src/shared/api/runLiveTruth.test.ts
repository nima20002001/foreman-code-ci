import { type CurrentRunDetails as GetRunResponse } from '@foreman-code/contracts/wave25'
import { describe, expect, it } from 'vitest'
import { keepLatestRunResponse, shareRunResponseOrSelection } from './runLiveCache'
import { makeSyntheticRun } from '../../features/graph/fixtures/scaleData'
import { selectGraphNodeActivity } from '../../features/graph/runtimeIndex'

function terminal(sequence: string, outcome: GetRunResponse['run']['outcome'] = 'canceled') {
  const response = makeSyntheticRun(1, sequence)
  response.run.executionState = 'completed'
  response.run.outcome = outcome
  response.liveActivity!.active = false
  return response
}
const scope = { workspaceId: 'synthetic-workspace', workflowId: 'synthetic-workflow', runId: 'synthetic-run',
  workflowVersionId: 'synthetic-version', overlayAllowed: true }

describe('frontend Stop/terminal/current ordering fences', () => {
  it('checks both activity counters before accepting an older terminal response', () => {
    const current = makeSyntheticRun(1, '20')
    expect(keepLatestRunResponse(current, terminal('19', 'succeeded'))).toBe(current)
    expect(shareRunResponseOrSelection(current, terminal('19', 'succeeded'))).toBe(current)
    const olderCount = terminal('21')
    olderCount.liveActivity!.eventCount = '19'
    expect(keepLatestRunResponse(current, olderCount)).toBe(current)
    expect(keepLatestRunResponse(current, terminal('21'))).not.toBe(current)
  })

  it('keeps an interrupted S0 Run from being resurrected by late active observations', () => {
    const stopped = makeSyntheticRun(1, '20')
    stopped.run.executionState = 'interrupted'
    stopped.cleanupPending = true
    stopped.liveActivity!.active = false
    for (const state of ['queued', 'running', 'waiting'] as const) {
      for (const sequence of ['19', '20', '21']) {
        const incoming = makeSyntheticRun(1, sequence)
        incoming.run.executionState = state
        expect(shareRunResponseOrSelection(stopped, incoming)).toBe(stopped)
      }
    }
    expect(selectGraphNodeActivity(stopped, scope, 'synthetic-node-0', 'synthetic-agent-0')).toBeUndefined()
    const settled = terminal('21')
    settled.cleanupPending = false
    expect(shareRunResponseOrSelection(stopped, settled).run.executionState).toBe('completed')
  })

  it('retains the existing persisted Stop cause rather than clearing it from an observation', () => {
    const stopped = makeSyntheticRun(1, '20')
    // Only cause presence is consumed here; this is not an API admission fixture.
    stopped.run.stopCause = { interactionId: 'stopped-review' } as NonNullable<GetRunResponse['run']['stopCause']>
    expect(shareRunResponseOrSelection(stopped, makeSyntheticRun(1, '21'))).toBe(stopped)
    expect(shareRunResponseOrSelection(stopped, terminal('21'))).toBe(stopped)
    expect(selectGraphNodeActivity(stopped, scope, 'synthetic-node-0', 'synthetic-agent-0')).toBeUndefined()
  })

  it('never changes a known terminal outcome, even with conflicting counters', () => {
    const stopped = terminal('20', 'canceled')
    for (const sequence of ['19', '20', '21']) {
      expect(shareRunResponseOrSelection(stopped, terminal(sequence, 'succeeded'))).toBe(stopped)
      expect(shareRunResponseOrSelection(stopped, terminal(sequence, 'failed'))).toBe(stopped)
      expect(shareRunResponseOrSelection(stopped, makeSyntheticRun(1, sequence))).toBe(stopped)
    }
  })

  it('allows newer same-outcome cleanup facts but never restores stale pending cleanup', () => {
    const pending = { ...terminal('20'), cleanupPending: true }
    const settled = { ...terminal('21'), cleanupPending: false }
    const accepted = shareRunResponseOrSelection(pending, settled)
    expect(accepted.cleanupPending).toBe(false)
    expect(accepted.run).toBe(pending.run)
    expect(shareRunResponseOrSelection(accepted, pending)).toBe(accepted)
  })

  it.each(['bad', '-1', '1.5', '9223372036854775808', '', null, undefined, 2])(
    'does not crash or replace a verified snapshot with malformed ordering: %j', (value) => {
      const current = makeSyntheticRun(1, '20')
      for (const key of ['sequence', 'eventCount']) {
        const incoming = terminal('21')
        Object.assign(incoming.liveActivity!, { [key]: value })
        expect(() => shareRunResponseOrSelection(current, incoming)).not.toThrow()
        expect(shareRunResponseOrSelection(current, incoming)).toBe(current)
      }
    },
  )

  it('retains a current ordered fact when an incoming terminal response has no ordering evidence', () => {
    const current = makeSyntheticRun(1, '20')
    const unorderable = terminal('21')
    delete unorderable.liveActivity
    expect(keepLatestRunResponse(current, unorderable)).toBe(current)
  })

  it('safely shares malformed node collections without turning them into known activity', () => {
    const current = makeSyntheticRun(2)
    for (const nodes of [null, {}, [null, 'ping']]) {
      const incoming = makeSyntheticRun(2, '2')
      Object.assign(incoming.liveActivity!, { nodes })
      expect(() => shareRunResponseOrSelection(current, incoming)).not.toThrow()
      const accepted = shareRunResponseOrSelection(current, incoming)
      expect(selectGraphNodeActivity(accepted, scope, 'synthetic-node-0', 'synthetic-agent-0')).toBeUndefined()
    }
  })

  it('does not infer a future Run state into a known terminal or idle outcome', () => {
    const current = makeSyntheticRun(1)
    const unknown = makeSyntheticRun(1, '2')
    // Deliberately malformed future wire data; the V3 seed otherwise has outcome: 'pending'.
    Object.assign(unknown.run, { executionState: 'uncertain', outcome: undefined })
    const accepted = shareRunResponseOrSelection(current, unknown)
    expect(accepted.run.executionState).toBe('uncertain')
    expect(accepted.run.outcome).toBeUndefined()
    expect(selectGraphNodeActivity(accepted, scope, 'synthetic-node-0', 'synthetic-agent-0')).toBeUndefined()
    expect(shareRunResponseOrSelection(accepted, terminal('1', 'succeeded'))).toBe(accepted)
  })

  it('does not confuse selected scalars/nodes with full responses', () => {
    for (const incoming of ['unknown', 'disconnected', 'uncertain', undefined, null]) {
      expect(shareRunResponseOrSelection('working', incoming)).toBe(incoming)
    }
    const node = makeSyntheticRun(1).liveActivity!.nodes[0]
    const next = { ...node, state: 'future-state' }
    expect(shareRunResponseOrSelection(node, next)).toEqual(next)
    const other = makeSyntheticRun(1)
    other.run.id = 'different-run'
    other.liveActivity!.runId = other.run.id
    expect(shareRunResponseOrSelection(terminal('20'), other)).toBe(other)
  })
})
