import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUN_INSPECTION_TOOLS, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { path, reader, pairedDenial, terminal } from './helpers/eng05DInspection.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('ENG05-D production Start and bounded inspection parity', () => {
  it('denies hidden inspection calls on both transports and rejects HTTP pagination/scope ambiguity', async () => {
    const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'), approvalNodeIds: [] })
    try {
      await f.engine.start(f.f.run.id); await terminal(f, f.f.run.id)
      const args = { workspaceId: f.f.scope.workspaceId, runId: f.f.run.id }
      const denied = await reader(f, args.runId, [{ actions: ['capabilities:read'], scope: {} }])
      const discovered = (await denied.client.listTools()).tools.map((tool) => tool.name)
      for (const name of Object.values(RUN_INSPECTION_TOOLS)) {
        expect(discovered).not.toContain(name)
        await pairedDenial(f, denied, name, name === RUN_INSPECTION_TOOLS.execution || name === RUN_INSPECTION_TOOLS.bindings
          ? { ...args, executionId: 'undisclosed-execution' } : args, 403, 'ACCESS_DENIED')
      }
      const audit = (await f.db.pool.query<{ source: string }>('select source from management_audit where principal_id=$1', [denied.principal.id])).rows
      expect(audit.filter((row) => row.source === 'http').length).toBeGreaterThanOrEqual(4)
      expect(audit.filter((row) => row.source === 'mcp').length).toBeGreaterThanOrEqual(4)
      const headers = { authorization: `Bearer ${f.writer.token}` }
      for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=1e2', 'limit=1&limit=2', 'cursor=', 'native=true', 'runId=another-run']) {
        const response = await f.app.inject({ method: 'GET', url: `${path(args, RUN_INSPECTION_TOOLS.executions)}?${query}`, headers })
        expect(response.statusCode, `${query}: ${response.body}`).toBe(400)
      }
      for (const name of Object.values(RUN_INSPECTION_TOOLS)) {
        const response = await f.app.inject({ method: 'GET', url: path({ ...args, executionId: 'private' }, name), headers: { authorization: 'Bearer invalid' } })
        expect(response.statusCode).toBe(401)
      }
      const runsOnly = await reader(f, args.runId, [{ actions: ['runs:read'], scope: { runIds: [args.runId] } }])
      await pairedDenial(f, runsOnly, RUN_INSPECTION_TOOLS.version, args, 403, 'ACCESS_DENIED')
    } finally { await f.close() }
  }, 90000)
})
