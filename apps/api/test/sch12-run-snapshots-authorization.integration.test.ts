import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import {
  historicalFixture, historicalRows, openHistoricalApi, readSnapshot,
  runA, snapshotPath, targetFor, type HistoricalApi,
} from './helpers/sch12HistoricalRuns.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('Historical Run snapshots / authorization / PostgreSQL / HTTP / MCP', () => {
  it('[SCH-12-S03] forged and physically foreign Run tuples are denied over both transports without changing history', async () => {
    const f = await historicalFixture()
    let api: HistoricalApi | undefined
    try {
      await runA(f)
      // A genuinely persisted foreign workspace/workflow/Run in the SAME schema,
      // not an ID from another isolated database that merely looks nonexistent.
      const foreign = await seedAgent3(f.db.pool, f.db.directory, makeCurrentWorkflowFixture(randomUUID(), 'single'))
      api = await openHistoricalApi(f)
      const reader = await f.access.issue({ name: 'SCH-12 snapshot reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['runs:read'], scope: { workspaceIds: [f.f.scope.workspaceId], workflowIds: [f.f.scope.workflowId] } }] })
      const client = await api.connect(reader.token)
      await readSnapshot(api, targetFor(f), reader.token, client)
      const allowed = targetFor(f)
      const foreignTarget = { workspaceId: foreign.scope.workspaceId, workflowId: foreign.scope.workflowId, runId: foreign.run.id }
      // Establish that foreign data exists and is accessible to an authorized caller.
      expect((await readSnapshot(api, foreignTarget)).kind).toBe('available')
      const before = await historicalRows(f.db.pool, [allowed.runId, foreign.run.id])
      for (const [target, status] of [
        [{ ...allowed, runId: `forged-${randomUUID()}` }, 404],
        [{ ...allowed, runId: foreign.run.id }, 404],
        [foreignTarget, 403],
        [{ ...allowed, workflowId: foreign.scope.workflowId }, 403],
      ] as const) {
        const http = await api.app.inject({ method: 'GET', url: snapshotPath(target), headers: { authorization: `Bearer ${reader.token}` } })
        expect(http.statusCode, http.body).toBe(status)
        const denied = await client.callTool({ name: 'run_board_snapshot_get', arguments: { ...target } })
        expect(denied.isError).toBe(true)
        expect(denied.structuredContent).toBeUndefined()
        expect(JSON.stringify(denied)).toContain(http.json<{ error: { code: string } }>().error.code)
        expect(http.json()).not.toHaveProperty('snapshot')
      }
      const invalid = await api.app.inject({ method: 'GET', url: snapshotPath(allowed), headers: { authorization: 'Bearer invalid' } })
      expect(invalid.statusCode).toBe(401)
      expect(await historicalRows(f.db.pool, [allowed.runId, foreign.run.id])).toEqual(before)
      expect(api.native.size).toBe(0)
    } finally { try { await api?.close() } finally { await f.close() } }
  }, 120_000)
})
