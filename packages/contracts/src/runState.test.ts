import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { isLiveRunState, requiresRunRecovery, runRefetchInterval } from './runState.js'

describe('live execution and recovery are distinct', () => {
  for (const executionState of ['queued', 'running', 'waiting'] as const) {
    it(`polls an actual ${executionState} execution`, () => {
      assert.equal(isLiveRunState(executionState), true)
      assert.equal(runRefetchInterval({ run: { executionState } }), 1000)
    })
  }
  it('does not portray an interrupted Run without cleanup as live or poll it forever', () => {
    assert.equal(isLiveRunState('interrupted'), false)
    assert.equal(requiresRunRecovery({ executionState: 'interrupted' }), true)
    assert.equal(runRefetchInterval({ run: { executionState: 'interrupted' }, cleanupPending: false }), false)
  })
  it('polls unresolved cleanup without calling it live execution', () => {
    assert.equal(isLiveRunState('completed'), false)
    assert.equal(requiresRunRecovery({ executionState: 'completed', cleanupPending: true }), true)
    assert.equal(runRefetchInterval({ run: { executionState: 'completed' }, cleanupPending: true }), 1000)
  })
  it('stops polling a settled historical Run', () => {
    assert.equal(requiresRunRecovery({ executionState: 'completed', cleanupPending: false }), false)
    assert.equal(runRefetchInterval({ run: { executionState: 'completed' } }), false)
  })
  it('polls while the requested Run identity has not loaded', () => {
    assert.equal(runRefetchInterval(undefined), 1000)
  })
})
