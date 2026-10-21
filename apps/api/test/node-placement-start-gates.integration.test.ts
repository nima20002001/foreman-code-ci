import { afterEach, describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { fixture, startInput, toolError } from './helpers/nodePlacementStartFixture.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('mixed computer placement gates', () => {
  it.each(['source-permission', 'qualification'] as const)('preserves the Main %s gate for implicit placement', async gate => {
    const f = await fixture()
    try {
      const saved = await f.save('mcp')
      let caller = f.client
      if (gate === 'source-permission') {
        const limited = await f.base.access.issue({ name: 'Starter without source access', audience: 'operator',
          expiresAt: new Date(Date.now() + 60_000), grants: [{
            actions: ['runs:start', 'workspace_locations:read', 'source_roots:read'],
            scope: { workspaceIds: [saved.version.workspaceId] },
          }] })
        caller = await f.connect(limited.token)
      } else {
        await f.base.db.pool.query("update harness_qualifications set status='failed' where harness='codex'")
      }
      const input = startInput(f, saved)
      const result = toolError(await caller.callTool({ name: 'run_start', arguments: input }))
      expect(result).toMatchObject({ error: {
        code: gate === 'source-permission' ? 'ACCESS_DENIED' : 'HARNESS_PROFILE_UNAVAILABLE',
      } })
      expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toEqual([])
      expect(f.base.provider.counts.sessions).toBe(0)
    } finally { await f.close() }
  }, 120_000)
})
