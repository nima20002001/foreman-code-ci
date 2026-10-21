import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { PostgresScheduleDispatcher } from '../src/modules/schedules/postgresDispatcher.js'
import { WorkflowScheduleService } from '../src/modules/schedules/service.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import {
  historicalFixture, historicalRows, openHistoricalApi, qualifyLocation, readSnapshot,
  runA, startSaved, targetFor, terminal, type HistoricalApi,
} from './helpers/sch12HistoricalRuns.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('Historical Run snapshots / admission / PostgreSQL / HTTP / MCP', () => {
  it('[SCH-12-S02] real manual Start and guarded scheduled admission persist the same complete snapshot shape', async () => {
    const f = await historicalFixture()
    let api: HistoricalApi | undefined
    try {
      await runA(f)
      await qualifyLocation(f)
      const manual = await startSaved(f)
      api = await openHistoricalApi(f)
      const manualSnapshot = await readSnapshot(api, targetFor(f, manual.id))
      if (manualSnapshot.kind !== 'available') throw new Error('Manual admission must capture the Board')
      const beforeManual = await historicalRows(f.db.pool, [manual.id])

      // Only recurrence time is injected. Authorization, SQL locks, location
      // evidence, the common G1 publisher and occurrence commit remain real.
      let now = new Date()
      const schedules = new WorkflowScheduleService(f.db.pool, f.commands, () => now)
      const { workspaceId, workflowId } = f.f.scope
      const slot = (await schedules.save(f.writer.principal, 'http', { workspaceId, workflowId,
        commandId: randomUUID(), expectedRevision: 0, schedule: { mode: 'interval', every: 1, unit: 'minute',
          anchorAt: now.toISOString(), timezone: 'UTC', enabled: true, policy: 'latest_saved' },
      })).value
      expect(slot.nextOccurrenceAt).not.toBeNull()
      now = new Date(slot.nextOccurrenceAt!)
      const dispatcher = new PostgresScheduleDispatcher(f.db.pool, async (principal, input, schedule) => {
        await admitRepeatRun(f.db.pool, f.locations, principal, 'schedule', input, repeatStartPublication, { schedule })
      }, () => now)
      await dispatcher.dispatch(slot)
      const facts = (await schedules.recentOccurrences(f.writer.principal, { workspaceId, workflowId })).items
      expect(facts).toHaveLength(1)
      expect(facts[0]).toMatchObject({ status: 'accepted', workflowVersionId: f.f.version.id })
      if (facts[0]?.status !== 'accepted') throw new Error('Scheduled occurrence must be accepted')
      const scheduledId = facts[0]!.runId
      if (!scheduledId) throw new Error('Accepted scheduled occurrence must identify its exact Run')
      expect(scheduledId).not.toBe(manual.id)
      const scheduledSnapshot = await readSnapshot(api, targetFor(f, scheduledId))
      if (scheduledSnapshot.kind !== 'available') throw new Error('Scheduled admission must capture the Board')
      // Compare every field: only Run identity and admission time legitimately
      // differ. Do not reduce parity to node counts or a handful of shared keys.
      expect({ ...scheduledSnapshot, runId: manualSnapshot.runId, capturedAt: manualSnapshot.capturedAt }).toEqual(manualSnapshot)
      const triggers = (await f.db.pool.query<{ run_id: string; admission_trigger: string }>(
        'select run_id,admission_trigger from run_board_snapshots where run_id=any($1::text[])', [[manual.id, scheduledId]])).rows
      expect(triggers).toEqual(expect.arrayContaining([
        { run_id: manual.id, admission_trigger: 'manual' }, { run_id: scheduledId, admission_trigger: 'schedule' },
      ]))
      expect(triggers).toHaveLength(2)
      const durable = (await f.db.pool.query('select * from run_board_snapshots where run_id=$1', [scheduledId])).rows
      // A stale scan in a fresh dispatcher cannot replace the capture or create a Run.
      await new PostgresScheduleDispatcher(f.db.pool, async (principal, input, schedule) => {
        await admitRepeatRun(f.db.pool, f.locations, principal, 'schedule', input, repeatStartPublication, { schedule })
      }, () => now).dispatch(slot)
      expect((await schedules.recentOccurrences(f.writer.principal, { workspaceId, workflowId })).items).toEqual(facts)
      expect((await f.db.pool.query('select * from run_board_snapshots where run_id=$1', [scheduledId])).rows).toEqual(durable)
      expect(await historicalRows(f.db.pool, [manual.id])).toEqual(beforeManual)
      // The admission callback above deliberately does not impersonate the native
      // runtime. Dispatch this committed ID once through the real fixture engine.
      await f.engine.start(scheduledId); await terminal(f, scheduledId)
      expect(await readSnapshot(api, targetFor(f, scheduledId))).toEqual(scheduledSnapshot)
      expect(f.dispatchErrors).toEqual([])
    } finally { try { await api?.close() } finally { await f.close() } }
  }, 120_000)
})
