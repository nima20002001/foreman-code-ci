import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { RunLiveActivitySchema, RunNodeLiveActivitySchema, RunLiveSequenceSchema } from './runLiveActivity.js'

describe('safe live activity contracts', () => {
  it('retains exact PostgreSQL bigint identities', () => {
    assert.equal(RunLiveSequenceSchema.parse('9007199254740993'), '9007199254740993')
    assert.equal(RunLiveSequenceSchema.parse('9223372036854775807'), '9223372036854775807')
  })
  it('rejects rounded numeric, malformed and out-of-range event identities', () => {
    for (const value of [1, '01', '-1', '1e2', '9223372036854775808', '9'.repeat(50)]) {
      assert.equal(RunLiveSequenceSchema.safeParse(value).success, false)
    }
  })
  it('cannot give an idle node an active action', () => {
    assert.equal(RunNodeLiveActivitySchema.safeParse({ workflowNodeId: 'n', agentId: 'a', state: 'idle',
      action: { kind: 'reading_file', label: 'Reading file…' }, event: { id: 'event', sequence: '1' } }).success, false)
  })
  it('rejects tool arguments and other raw native data in the public node projection', () => {
    assert.equal(RunNodeLiveActivitySchema.safeParse({ workflowNodeId: 'n', agentId: 'a', state: 'working',
      action: { kind: 'reading_file', label: 'Reading file…', arguments: { path: 'secret' } },
      event: { id: 'event', sequence: '1' } }).success, false)
  })
  it('requires event evidence for non-idle node state', () => {
    assert.equal(RunNodeLiveActivitySchema.safeParse({ workflowNodeId: 'n', agentId: 'a', state: 'working',
      action: { kind: 'reading_file', label: 'Reading file…' }, event: null }).success, false)
  })
  it('requires the immutable version and the late-commit event count', () => {
    const snapshot = { runId: 'r', workspaceId: 'w', workflowId: 'f', workflowVersionId: 'v',
      active: true, sequence: '100', eventCount: '90', nodes: [] }
    assert.equal(RunLiveActivitySchema.safeParse(snapshot).success, true)
    const { eventCount: _count, ...missingCount } = snapshot
    void _count
    assert.equal(RunLiveActivitySchema.safeParse(missingCount).success, false)
  })
})
