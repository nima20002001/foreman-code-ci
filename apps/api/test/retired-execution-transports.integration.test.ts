import { describe, expect, it } from 'vitest'
import {
  CANONICAL_RUN_GRAPH_MCP_TOOLS,
  CURRENT_WORKFLOW_TOOLS,
  RETIRED_EXECUTION_TOOLS,
  RUN_INSPECTION_TOOLS,
} from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

describe('retired public execution transports', () => {
  it('removes HTTP adapters and audits authenticated MCP rejection without executing saved work', async () => {
    const f = await currentOperatorIntegration({ graphReads: true })
    const app = buildApp({
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access: f.access, services: f.services },
      product: {
        workspaces: new PostgresWorkspaceRepository(f.db.pool, f.workflows, f.runs),
        workflows: f.workflows,
        runs: f.runs,
        engine: f.engine,
      },
    })
    try {
      const { workspaceId, workflowId } = f.f.scope
      const headers = { host: 'localhost', authorization: `Bearer ${f.writer.token}` }
      const workflowUrl = `/api/workspaces/${workspaceId}/workflows/${workflowId}`
      expect((await app.inject({ method: 'GET', url: workflowUrl, headers })).statusCode).toBe(200)
      const runBefore = await f.runs.getDetails(workspaceId, f.f.run.id)
      const providerBefore = { ...f.provider.counts }
      const draftsUrl = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}/drafts`
      const removedRoutes = [
        { method: 'PUT' as const, url: workflowUrl },
        { method: 'PUT' as const, url: `/api/workspaces/${workspaceId}/graph` },
        { method: 'POST' as const, url: `${workflowUrl}/runs` },
        { method: 'POST' as const, url: `/api/workspaces/${workspaceId}/runs/${f.f.run.id}/cancel` },
        { method: 'POST' as const, url: draftsUrl },
        { method: 'GET' as const, url: `${draftsUrl}/retired-draft` },
        { method: 'DELETE' as const, url: `${draftsUrl}/retired-draft` },
        { method: 'PUT' as const, url: `${draftsUrl}/retired-draft/layout` },
        ...['operations', 'revert-applied', 'validate', 'save'].map(operation => ({
          method: 'POST' as const, url: `${draftsUrl}/retired-draft/${operation}`,
        })),
      ]
      for (const route of removedRoutes) {
        const response = await app.inject({ ...route, headers })
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(404)
      }
      const listed = new Set((await f.client.listTools()).tools.map(tool => tool.name))
      for (const name of RETIRED_EXECUTION_TOOLS) {
        expect(listed.has(name), name).toBe(false)
        const result = await f.client.callTool({ name, arguments: {} })
        expect(result.isError, name).toBe(true)
        expect(JSON.stringify(result.content), name).toContain('EXECUTION_SEMANTICS_UNSUPPORTED')
        expect((await f.db.pool.query(
          `select source, action, target_key, outcome, details from management_audit
           where principal_id=$1 and action=$2`, [f.writer.principal.id, name],
        )).rows).toEqual([{
          source: 'mcp', action: name, target_key: `mcp:${name}`, outcome: 'failed',
          details: { code: 'EXECUTION_SEMANTICS_UNSUPPORTED' },
        }])
      }
      const restricted = await f.access.issue({ name: 'Restricted execution caller', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [] })
      const client = await f.connect(restricted.token)
      for (const name of ['run_start', CURRENT_WORKFLOW_TOOLS.save,
        CANONICAL_RUN_GRAPH_MCP_TOOLS.current, RUN_INSPECTION_TOOLS.record]) {
        const result = await client.callTool({ name, arguments: {} })
        expect(result.isError, name).toBe(true)
        expect(JSON.stringify(result.content), name).toContain('ACCESS_DENIED')
        expect((await f.db.pool.query(
          `select source, outcome from management_audit where principal_id=$1 and target_key=$2`,
          [restricted.principal.id, `mcp:${name}`],
        )).rows).toEqual([{ source: 'mcp', outcome: 'denied' }])
      }
      await f.access.revoke(restricted.principal.id)
      const auditBefore = (await f.db.pool.query('select * from management_audit order by sequence')).rows
      for (const token of [undefined, 'invalid-token', restricted.token]) {
        const response = await f.app.inject({ method: 'POST', url: '/mcp',
          headers: { host: 'localhost', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: RETIRED_EXECUTION_TOOLS[0], arguments: {} } },
        })
        expect(response.statusCode).toBe(401)
      }
      const auditAfter = (await f.db.pool.query('select * from management_audit order by sequence')).rows
      expect(auditAfter.slice(0, auditBefore.length)).toEqual(auditBefore)
      expect(auditAfter.slice(auditBefore.length)).toEqual([
        expect.objectContaining({ source: 'mcp', action: 'AUTH_REQUIRED', target_key: '/mcp', outcome: 'denied' }),
        expect.objectContaining({ source: 'mcp', action: 'AUTH_INVALID', target_key: '/mcp', outcome: 'denied' }),
        expect.objectContaining({ source: 'mcp', action: 'AUTH_REVOKED', target_key: '/mcp', outcome: 'denied' }),
      ])
      expect(await f.runs.getDetails(workspaceId, f.f.run.id)).toEqual(runBefore)
      expect(f.provider.counts).toEqual(providerBefore)
    } finally {
      await app.close()
      await f.close()
    }
  }, 60_000)
})
