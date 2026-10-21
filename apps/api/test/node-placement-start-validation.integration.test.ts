import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { advanceMainSourceBinding, fixture, startInput, toolError } from './helpers/nodePlacementStartFixture.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('mixed computer placement validation', () => {
  it.each(['source', 'rootBinding'] as const)('rejects saving remote placement missing %s without a Main fallback', async field => {
    const f = await fixture()
    try {
      delete agentWorkflowNode(f.saveInput.graph.nodes[1]).placement![field]
      const http = await f.app.inject({ method: 'PUT', url: `${f.path}/definition`, headers: f.headers, payload: f.saveInput })
      expect(http.statusCode).toBe(409)
      expect(http.json()).toMatchObject({ error: { code: 'WORKTREE_BINDING_REQUIRED' } })
      expect(toolError(await f.client.callTool({ name: 'workflow_save_v3', arguments: f.saveInput })))
        .toMatchObject({ error: { code: 'WORKTREE_BINDING_REQUIRED' } })
      expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [f.saveInput.workflowId])).rows).toEqual([])
      expect((await f.base.db.pool.query('select id from workflow_versions where workflow_id=$1', [f.saveInput.workflowId])).rows).toEqual([])
      expect(f.base.provider.counts.sessions).toBe(0)
    } finally { await f.close() }
  }, 120_000)

  it.each(['http', 'mcp'] as const)('%s rejects a Main source binding that changes between resolution and admission commit', async via => {
    const f = await fixture()
    try {
      const saved = await f.save('mcp')
      const prepare = f.placement.producer.prepare.bind(f.placement.producer)
      vi.spyOn(f.placement.producer, 'prepare').mockImplementation(async (...args) => {
        const result = await prepare(...args)
        await advanceMainSourceBinding(f)
        return result
      })
      const input = startInput(f, saved)
      if (via === 'mcp') {
        expect(toolError(await f.client.callTool({ name: 'run_start', arguments: input })))
          .toMatchObject({ error: { code: 'PLACEMENT_ADMISSION_CONFLICT' } })
      } else {
        const response = await f.app.inject({ method: 'POST', url: `${f.path}/runs`, headers: f.headers, payload: input })
        expect(response.statusCode).toBe(409)
        expect(response.json()).toMatchObject({ error: { code: 'PLACEMENT_ADMISSION_CONFLICT' } })
      }
      expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toEqual([])
      expect((await f.base.db.pool.query('select 1 from run_node_placements p join runs r on r.id=p.run_id where r.workflow_id=$1',
        [input.workflowId])).rows).toEqual([])
    } finally { await f.close() }
  }, 120_000)


})
