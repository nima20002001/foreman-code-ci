import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { describe, expect, it } from 'vitest'

import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

function rpcResult(body: string) {
  const data = body.split('\n').find(line => line.startsWith('data: '))
  return JSON.parse(data ? data.slice(6) : body).result
}

describe.skipIf(!postgresEnabled)('authenticated Tailscale HTTP and MCP access', () => {
  it('reads persisted data over tailnet hosts while preserving authentication and MCP scopes', async () => {
    const f = await currentOperatorIntegration()
    try {
      const workspaceId = f.f.scope.workspaceId
      const before = ManagedWorkspaceSchema.parse(decodeMcpToolResult(
        await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId } }),
      ))
      const reader = await f.access.issue({
        name: 'Tailnet reader', audience: 'operator',
        grants: [{ actions: ['workspaces:read', 'workspace_locations:read', 'source_roots:read'],
          scope: { workspaceIds: [workspaceId] } }],
      })
      const call = (host: string, id: string, token?: string) => f.app.inject({
        method: 'POST', url: '/mcp', headers: {
          host: `${host}:3000`, origin: `http://${host}:5173`,
          accept: 'application/json, text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'workspace_get', arguments: { workspaceId: id },
        } },
      })
      for (const host of ['node.example.ts.net', '100.100.20.30']) {
        const http = await f.app.inject({ url: '/api/local-human', headers: {
          host, origin: `http://${host}`, authorization: `Bearer ${reader.token}`,
        } })
        expect(http.statusCode).toBe(200)
        expect(http.json().principal.id).toBe(reader.principal.id)
        const read = await call(host, workspaceId, reader.token)
        expect(read.statusCode).toBe(200)
        expect(ManagedWorkspaceSchema.parse(decodeMcpToolResult(rpcResult(read.body))))
          .toMatchObject({ ...before, locationValidation: { status: before.locationValidation.status } })
        const denied = await call(host, 'outside-scope', reader.token)
        expect(denied.statusCode).toBe(200)
        expect(rpcResult(denied.body).isError).toBe(true)
        expect(denied.body).toContain('ACCESS_DENIED')
        const missing = await call(host, workspaceId)
        expect(missing.statusCode).toBe(401)
        expect(missing.json().error.code).toBe('AUTH_REQUIRED')
        expect((await call(host, workspaceId, 'invalid-token')).statusCode).toBe(401)
      }
      expect((await call('public.example', workspaceId, reader.token)).statusCode).toBe(403)
    } finally { await f.close() }
  }, 60000)
})
