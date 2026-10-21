import { describe, expect, it, vi } from 'vitest'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { ApprovalTransportFaults } from './helpers/eng06ApprovalFaults.js'

describe.skipIf(!postgresEnabled)('Current workflow result and checkpoint durability', () => {
  it('a cold engine closes the waiting native lifetime without replaying the completed predecessor', async () => {
    const faults = new ApprovalTransportFaults()
    const t = await checkpointRuntimeFixture(1, 1, {
      recoverNativeProcesses: (executionId, signal) => faults.recoverNativeProcesses(executionId, signal),
    })
    const connection = t.provider.connection.bind(t.provider)
    vi.spyOn(t.provider, 'connection').mockImplementation(() => faults.wrap(connection()))
    try {
      await t.engine.start(t.f.run.id)
      const pending = (await t.pending())[0]!
      const before = { ...t.provider.counts }
      const acceptedBefore = (await t.db.pool.query<{ count: string }>(
        "select count(*)::text as count from run_graph_effects where run_id=$1 and effect_kind='result.accept'",
        [t.f.run.id])).rows[0]!.count
      faults.killOnRestart = true
      await t.engine.shutdown()
      const recovered = t.compose()
      await recovered.engine.resume(t.f.run.id)
      expect(t.provider.counts.starts).toBe(before.starts)
      expect(t.provider.counts.sessions).toBe(before.sessions)
      expect(t.provider.closedSessions.has(pending.nativeSessionId)).toBe(true)
      expect((await t.db.pool.query<{ count: string }>(
        "select count(*)::text as count from run_graph_effects where run_id=$1 and effect_kind='result.accept'",
        [t.f.run.id])).rows[0]!.count).toBe(acceptedBefore)
      expect(await recovered.runs.get(t.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'failed' })
      expect((await recovered.repository.get(pending.id))?.status).toBe('canceled')
      expect(t.provider.counts.responses).toBe(0)
    } finally { await t.close() }
  }, 60000)
})
