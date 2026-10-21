import { describe, expect, it, vi } from 'vitest'
import type { DeviceHistoryGap } from '@foreman-code/contracts/device-application'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('native history recovery activity', () => {
  it('persists skipped ranges once while the workflow and its sibling finish normally', async () => {
    const f = await checkpointRuntimeFixture(2, 1, { approvalNodeIds: [] })
    try {
      const original = f.provider.startTurn.bind(f.provider)
      vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
        for await (const event of original(session, input)) {
          yield event
          if (event.type !== 'turn.started') continue
          const observer = input as typeof input & { onEventsSkipped?(gap: DeviceHistoryGap): Promise<void> }
          const gap: DeviceHistoryGap = { fromSequence: 10, toSequence: 29, reason: 'retention' }
          await observer.onEventsSkipped?.(gap)
          await observer.onEventsSkipped?.(gap)
        }
      })
      await f.engine.start(f.f.run.id)
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      const markers = (await f.runs.listActivity(f.f.run.id)).filter(activity => String(activity.kind) === 'native_events_skipped')
      expect(markers).toHaveLength(f.provider.counts.starts)
      for (const marker of markers) expect(marker.payload).toMatchObject({ fromSequence: 10, toSequence: 29,
        reason: 'retention' })
      const executions = await readCurrentExecutions(f.runs, f.f.run.id)
      expect(executions.every(execution => execution.state === 'completed' && execution.result?.outcome === 'succeeded')).toBe(true)
      const restarted = f.compose()
      expect((await restarted.runs.listActivity(f.f.run.id)).filter(activity => String(activity.kind) === 'native_events_skipped'))
        .toEqual(markers)
    } finally {
      try { await f.close() } finally { vi.restoreAllMocks() }
    }
  }, 60_000)
})
