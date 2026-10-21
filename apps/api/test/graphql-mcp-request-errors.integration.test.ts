import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { describe, expect, it } from 'vitest'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'

import { MAX_REFERENCE_MCP_BODY_BYTES } from '../src/modules/files/references/requests.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

describe.skipIf(!postgresEnabled)('authenticated MCP request parsing', () => {
  it('returns safe parser errors without dispatching or changing persisted state', async () => {
    const f = await currentOperatorIntegration()
    try {
      const workspaceId = f.f.scope.workspaceId
      const before = ManagedWorkspaceSchema.parse(
        decodeMcpToolResult((await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId } }))),
      )
      const receipts = await f.db.pool.query('select count(*)::int as count from management_command_receipts')
      const restricted = await f.access.issue({
        name: 'Request parsing reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['workspaces:read'], scope: { workspaceIds: [workspaceId] } }],
      })
      const cases = [
        { payload: '{"private-input":', contentType: 'application/json', status: 400, code: 'INVALID_REQUEST' },
        { payload: '', contentType: 'application/json', status: 400, code: 'INVALID_REQUEST' },
        { payload: '<private-input/>', contentType: 'application/xml', status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
        {
          payload: JSON.stringify({ input: 'x'.repeat(MAX_REFERENCE_MCP_BODY_BYTES) }),
          contentType: 'application/json', status: 413, code: 'REQUEST_TOO_LARGE',
        },
      ]
      for (const token of [f.writer.token, restricted.token]) {
        for (const input of cases) {
          const response = await f.app.inject({
            method: 'POST', url: '/mcp', payload: input.payload,
            headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': input.contentType },
          })
          expect(response.statusCode).toBe(input.status)
          expect(response.json()).toEqual({ error: {
            code: input.code, message: expect.any(String), requestId: expect.any(String),
          } })
          expect(response.body).not.toContain('private-input')
          expect(response.body).not.toContain('FST_ERR')
        }
      }
      const unauthenticated = await f.app.inject({
        method: 'POST', url: '/mcp', payload: cases[0]!.payload,
        headers: { host: 'localhost', 'content-type': 'application/json' },
      })
      expect(unauthenticated.statusCode).toBe(401)
      expect(unauthenticated.json().error.code).toBe('AUTH_REQUIRED')
      expect(decodeMcpToolResult((await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId } }))))
        .toMatchObject({ ...before, locationValidation: { status: before.locationValidation.status } })
      expect((await f.db.pool.query('select count(*)::int as count from management_command_receipts')).rows)
        .toEqual(receipts.rows)
    } finally {
      await f.close()
    }
  }, 60000)
})
