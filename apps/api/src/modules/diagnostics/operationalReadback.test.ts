import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import { DomainError } from '../errors.js'
import { logIgnoredError } from './ignoredError.js'
import { CI_GET_ACTIONS } from '../jobs/ciAuthority.js'

it('reads retained sanitized failures over authenticated MCP and denies an invalid caller', async () => {
  const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: ['capabilities:read'], scope: {} }] }
  const app = Fastify({ logger: false })
  registerGraphqlMcp(app, { access: { authenticate: async (token: string) => {
    if (token !== 'fixture-token') throw new DomainError('AUTH_REQUIRED', 'Invalid bearer.', 401)
    return principal
  } } as never, operator: {} as never })
  const client = new Client({ name: 'diagnostics-fixture', version: '1' })
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => 'fixture-token' },
    }))
    logIgnoredError('engine', 'retain failed audit recording',
      Object.assign(new Error('Private provider details'), { code: 'EIO' }))
    for (const args of [{}, { detail: 'full' }]) {
      const result = decodeMcpToolResult(await client.callTool({ name: 'operator_get_capabilities', arguments: args }))
      expect(result).toMatchObject({ operationalFailures: expect.arrayContaining([
        expect.objectContaining({ operation: 'retain failed audit recording', lastError: 'EIO', failureCount: 1 }),
      ]) })
      expect(JSON.stringify(result)).not.toContain('Private provider details')
    }
    const denied = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: 'Bearer invalid', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'operator_get_capabilities', arguments: { detail: 'full' } } } })
    expect(denied.statusCode).toBe(401)
    expect(denied.body).not.toContain('operationalFailures')
  } finally {
    await client.close()
    await app.close()
  }
})

it('returns persisted reassignment and repair facts through MCP while denying a caller without CI access', async () => {
  const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: ['capabilities:read', ...CI_GET_ACTIONS], scope: {} }] }
  const record = { id: randomUUID(), groupId: randomUUID(), workspaceId: 'workspace',
    suite: 'integration', part: null, partition: null, scope: 'full', files: [],
    repository: 'example/project', commit: 'a'.repeat(40), state: 'queued', computer: null, step: null,
    queuedAt: '2026-10-14T00:00:00Z', startedAt: null, finishedAt: null, exitCode: null,
    message: 'Reassigned after the build computer became unavailable.',
    initiator: { principalId: principal.id, executionId: null },
    reassignment: { count: 2, previousHostKey: 'fixture-build', lastError: 'CI_BUILD_COMPUTER_UNAVAILABLE',
      at: '2026-10-14T00:01:00Z' },
    mirrorPublication: { state: 'ready', startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:01:00Z',
      repair: { count: 1, repository: 'example/mirror', sourceCommit: 'a'.repeat(40),
        reason: 'CI_MIRROR_CORRUPT', elapsedMs: 12 } } }
  const get = vi.fn(async () => structuredClone({ run: record, partitions: [record] }))
  const deniedAudit = vi.fn(async () => undefined)
  const app = Fastify({ logger: false })
  registerGraphqlMcp(app, { access: { authenticate: async (token: string) => token === 'owner'
    ? principal : { ...principal, id: 'reader', grants: [{ actions: ['capabilities:read'], scope: {} }] } } as never,
  operator: { ci: { get }, commands: { recordDenied: deniedAudit, recordAudit: async () => undefined } } as never })
  const client = new Client({ name: 'ci-diagnostics-fixture', version: '1' })
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => 'owner' },
    }))
    for (let read = 0; read < 2; read++) {
      const result = decodeMcpToolResult(await client.callTool({ name: 'ci_get',
        arguments: { workspaceId: record.workspaceId, ticketId: record.id } }))
      expect(result).toMatchObject({ run: { reassignment: record.reassignment, mirrorPublication: record.mirrorPublication },
        partitions: [{ reassignment: record.reassignment }] })
    }
    const denied = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: 'Bearer reader', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_get',
        arguments: { workspaceId: record.workspaceId, ticketId: record.id } } } })
    expect(denied.body).toContain('ACCESS_DENIED')
    expect(get).toHaveBeenCalledTimes(2)
    expect(deniedAudit).toHaveBeenCalledOnce()
  } finally {
    await client.close()
    await app.close()
  }
})
