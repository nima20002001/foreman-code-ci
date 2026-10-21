import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentWorkflowVersion } from './helpers/agentWorkflowFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import {
  historicalFixture, historicalRows, openHistoricalApi, readSnapshot,
  runA, saveWithoutY, startSaved, targetFor, type HistoricalApi,
} from './helpers/sch12HistoricalRuns.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('Historical Run snapshots / retention / PostgreSQL / HTTP / MCP', () => {
  it('[SCH-12-S01] A retains removed Y, edges and old geometry; B captures the saved removal/move; fresh services read both', async () => {
    const f = await historicalFixture()
    let api: HistoricalApi | undefined
    try {
      await runA(f)
      api = await openHistoricalApi(f)
      const x = f.f.version.definition.nodes[0]!, y = f.f.version.definition.nodes[1]!
      const before = await readSnapshot(api, targetFor(f))
      if (before.kind !== 'available') throw new Error('New Run A must have a persisted snapshot')
      expect(before.nodes).toHaveLength(2)
      expect(before.nodes.find((node) => node.id === x.id)).toMatchObject({ name: 'Agent X',
        position: { x: -48.5, y: 120 }, size: { width: 256, height: 144 } })
      expect(before.nodes.find((node) => node.id === y.id)).toMatchObject({ name: 'Agent Y', agentId: y.agentId,
        agentConfigurationVersionId: f.f.version.agentConfigurationVersionIds[y.agentId],
        position: { x: 415, y: 276.25 }, size: { width: 312, height: 160 } })
      expect(before.edges).toEqual(f.f.version.definition.edges)
      expect(before.edges).not.toHaveLength(0)
      const old = await historicalRows(f.db.pool, [f.f.run.id])
      expect(old.sessions).not.toHaveLength(0)
      expect(old.snapshots).toHaveLength(1)
      expect(old.snapshots[0]!.record).toEqual(before)

      const { saved } = await saveWithoutY(f)
      expect(saved.version.id).not.toBe(f.f.version.id)
      expect(saved.version.definition.nodes.some((node) => node.id === y.id)).toBe(false)
      expect(saved.version.definition.edges).toHaveLength(0)
      expect(await readSnapshot(api, targetFor(f))).toEqual(before)
      // Removal means the typed Board deletion above plus the supported archive.
      // Hard-deleting a historically pinned Agent is restricted by existing FKs;
      // never disable those constraints to manufacture a passing history test.
      await f.db.pool.query("update agents set archived_at=now(), record=jsonb_set(record,'{name}','\"Current renamed Y\"') where id=$1", [y.agentId])
      await expect(f.db.pool.query('delete from agents where id=$1', [y.agentId])).rejects.toMatchObject({ code: '23503' })
      expect(await historicalRows(f.db.pool, [f.f.run.id])).toEqual(old)

      const b = await startSaved(f, agentWorkflowVersion(saved.version))
      const after = await readSnapshot(api, targetFor(f, b.id))
      if (after.kind !== 'available') throw new Error('Run B must have its own persisted snapshot')
      expect(after.workflowVersionId).toBe(saved.version.id)
      expect(after.nodes).toHaveLength(1)
      expect(after.nodes[0]).toMatchObject({ id: x.id, name: 'Agent X', position: { x: 909, y: -33 }, size: { width: 480, height: 144 } })
      expect(after.nodes.some((node) => {
        if (node.kind === 'job') throw new Error('Historical Agent snapshot fixture requires Agent nodes')
        return node.id === y.id || node.agentId === y.agentId
      })).toBe(false)
      expect(after.edges).toHaveLength(0)
      expect(await historicalRows(f.db.pool, [f.f.run.id])).toEqual(old)
      const retained = await historicalRows(f.db.pool, [f.f.run.id, b.id])

      const previousPool = api.pool, previousChat = api.chat, previousHistory = api.services.runs.history
      await api.close()
      api = await openHistoricalApi(f)
      expect(api.pool).not.toBe(previousPool)
      expect(api.chat).not.toBe(previousChat)
      expect(api.services.runs.history).not.toBe(previousHistory)
      expect(await readSnapshot(api, targetFor(f))).toEqual(before)
      expect(await readSnapshot(api, targetFor(f, b.id))).toEqual(after)
      expect(api.native.size).toBe(0)
      expect(await historicalRows(api.pool, [f.f.run.id, b.id])).toEqual(retained)
      expect(f.dispatchErrors).toEqual([])
    } finally { try { await api?.close() } finally { await f.close() } }
  }, 120_000)
})
