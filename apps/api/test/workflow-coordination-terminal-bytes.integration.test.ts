import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { COORDINATION_RESULT_PROTOCOL } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('workflow coordination terminal persistence', () => {
  it('retains canonical result bytes and their digest when a native execution completes', async () => {
    const saved = makeCurrentWorkflowFixture('terminal-bytes', 'single')
    saved.run = { ...saved.run, resultProtocol: COORDINATION_RESULT_PROTOCOL }
    const output = { data: { z: '雪', a: 'First' }, summary: 'Completed the task.',
      board: { kind: 'none', reason: 'no_access' } }
    const f = await checkpointRuntimeFixture(1, 1, { fixture: saved, approvalNodeIds: [],
      collaborationPorts: {}, outputFor: () => output })
    try {
      await f.engine.start(f.f.run.id)
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      const executions = await f.runs.listRepeatExecutions(f.f.run.id)
      expect(executions).toHaveLength(1)
      expect(executions[0]!.execution.result).toEqual({ outcome: 'succeeded', output })
      const stored = (await f.db.pool.query<{ record: unknown; record_json: string; record_digest: string }>(
        'select record,record_json,record_digest from workflow_coordination_terminals where run_id=$1', [f.f.run.id])).rows
      expect(stored).toHaveLength(1)
      const row = stored[0]!
      expect(JSON.parse(row.record_json)).toEqual(row.record)
      expect(row.record_digest).toBe(`sha256:${createHash('sha256').update(row.record_json).digest('hex')}`)
      await f.engine.start(f.f.run.id)
      expect(f.provider.counts.starts).toBe(1)
      expect((await f.db.pool.query('select record,record_json,record_digest from workflow_coordination_terminals where run_id=$1',
        [f.f.run.id])).rows).toEqual(stored)
    } finally { await f.close() }
  }, 60_000)
})
