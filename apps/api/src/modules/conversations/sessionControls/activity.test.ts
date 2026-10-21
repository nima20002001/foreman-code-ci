import { expect, it } from 'vitest'
import { operatorActivity } from '../operatorActivity.js'

it('projects a native compaction boundary without a model-turn completion or fabricated savings', () => {
  const activity = operatorActivity({ sequence: 3, occurredAt: '2026-10-04T00:00:00.000Z', type: 'session.compaction',
    payload: { nativeSessionId: 'session', nativeOperationId: 'boundary', trigger: 'auto', beforeTokens: 100000 } }, 'claude', 'task')
  expect(activity).toMatchObject({ kind: 'tool', title: 'Context compacted', status: 'completed' })
  expect(activity?.output).toBe('Native compaction boundary observed. Waiting for updated context usage.')
})
