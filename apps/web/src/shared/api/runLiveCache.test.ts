import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { type CurrentRunDetails as GetRunResponse } from '@foreman-code/contracts/wave25'
import { makeSyntheticRun } from '../../features/graph/fixtures/scaleData'
import { keepLatestRunResponse } from './runLiveCache'

function snapshot(sequence: string, eventCount = sequence,
  state: GetRunResponse['run']['executionState'] = 'running', runId = 'run'): GetRunResponse {
  // Current V3 facts must reach the lifecycle guard, not its invalid-response arm.
  const value = makeSyntheticRun(1, sequence)
  value.run.id = runId
  value.run.executionState = state
  if (state === 'completed') {
    value.run.outcome = 'succeeded'
    value.run.result = { outcome: 'succeeded' }
  }
  Object.assign(value.liveActivity!, { runId, eventCount, active: state !== 'completed' })
  return value
}

describe('live Run React Query cache ordering', () => {
  it('accepts the first snapshot', () => {
    const next = snapshot('1')
    assert.equal(keepLatestRunResponse(undefined, next), next)
  })
  it('rejects a late older response', () => {
    const current = snapshot('12', '9'), stale = snapshot('11', '8')
    assert.equal(keepLatestRunResponse(current, stale), current)
  })
  it('uses exact bigint cursors beyond Number precision', () => {
    const current = snapshot('9007199254740993', '10'), stale = snapshot('9007199254740992', '10')
    assert.equal(keepLatestRunResponse(current, stale), current)
  })
  it('accepts an event with lower sequence that committed after the previous snapshot', () => {
    const current = snapshot('50', '20'), next = snapshot('50', '21')
    assert.equal(keepLatestRunResponse(current, next), next)
    assert.equal(keepLatestRunResponse(next, current), next)
  })
  it('keeps a terminal snapshot terminal', () => {
    const current = snapshot('20', '20', 'completed')
    assert.equal(keepLatestRunResponse(current, snapshot('19')), current)
  })
  it('accepts newly confirmed terminal state', () => {
    const terminal = snapshot('10', '10', 'completed')
    assert.equal(keepLatestRunResponse(snapshot('9'), terminal), terminal)
  })
  it('never carries a previous Run into a newly selected Run', () => {
    const next = snapshot('1', '1', 'running', 'new-run')
    assert.equal(keepLatestRunResponse(snapshot('100'), next), next)
  })
  it('refuses to change an immutable version within one Run', () => {
    const current = snapshot('1'), wrong = snapshot('2')
    wrong.run.workflowVersionId = 'other-version'
    assert.equal(keepLatestRunResponse(current, wrong), current)
  })
  it('does not replace a verified snapshot with a response missing live evidence', () => {
    const current = snapshot('1'), missing = snapshot('2')
    delete missing.liveActivity
    assert.equal(keepLatestRunResponse(current, missing), current)
  })
})

it('rejects a stale cleanup/cause snapshot using its persisted lifecycle event', () => {
  const old = { ...snapshot('50', '10', 'completed'), cleanupPending: true }
  const next = { ...snapshot('51', '11', 'completed'), cleanupPending: false }
  assert.equal(keepLatestRunResponse(old, next), next)
  assert.equal(keepLatestRunResponse(next, old), next)
})
