import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { CiLogsOutputSchema, CiRunRecordSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import type { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { CI_GET_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from './service.js'

function fixture() {
  const mainId = randomUUID()
  const computer = { key: 'worker', label: 'Build computer', priority: 0,
    hostRef: { kind: 'device' as const, mainId, deviceId: randomUUID() } }
  const run = CiRunRecordSchema.parse({ id: randomUUID(), groupId: randomUUID(), workspaceId: 'workspace',
    suite: 'unit', part: null, scope: 'full', files: [], partition: null, repository: 'fixture/site', commit: 'a'.repeat(40),
    state: 'failed', computer: { hostRef: computer.hostRef, label: computer.label }, step: 'unit', exitCode: 1,
    message: null, queuedAt: '2026-10-14T00:00:00Z', startedAt: '2026-10-14T00:00:01Z',
    finishedAt: '2026-10-14T00:01:00Z', initiator: { principalId: 'reader', executionId: null } })
  const tail = 'Assertion failed: expected café 🙂\n'
  const pool = { query: async () => ({ rows: [{ record: run, log_tail: tail }] }) } as unknown as pg.Pool
  const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [{ actions: CI_GET_ACTIONS, scope: {} }] }
  const authority: CiAuthority = { resolve: async caller => {
    if (!caller.grants.length) throw new DomainError('ACCESS_DENIED', 'CI read denied.', 403)
    return { principal: caller, workspaceId: 'workspace' }
  } }
  const endpoint: HostCiEndpoint = { computers: vi.fn(async () => [computer]),
    request: vi.fn(async () => { throw new DomainError('CI_HOST_OFFLINE', 'Build computer is offline.', 503) }) }
  const commands = { recordDenied: vi.fn(async () => undefined) } as unknown as PostgresCommandCoordinator
  const ci = new HostCiService(pool, commands, authority, {} as CiCommits, endpoint)
  const app = Fastify()
  registerGraphqlMcp(app, {
    access: { authenticate: async (token: string) => token === 'reader'
      ? principal : { ...principal, grants: [] } } as unknown as PostgresAccessService,
    operator: { ci, commands } as unknown as OperatorServices,
  })
  const call = async (input: Record<string, unknown> = {}, token = 'reader') => {
    const response = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_logs_read',
        arguments: { workspaceId: 'workspace', ticketId: run.id, ...input } } } })
    const data = response.body.split('\n').find(line => line.startsWith('data: '))
    return (data ? JSON.parse(data.slice(6)) : response.json()).result
  }
  return { call, run, tail, ci, principal, endpoint, close: async () => { await ci.close(); await app.close() } }
}

it.each(['request', 'discovery'] as const)('reads a labeled persisted failure tail when executor %s is unavailable through MCP', async failure => {
  const f = fixture()
  try {
    if (failure === 'discovery') vi.mocked(f.endpoint.computers).mockRejectedValue(
      new DomainError('CI_COMPUTER_OFFLINE', 'Build computer discovery unavailable.', 503))
    const response = await f.call()
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    const result = CiLogsOutputSchema.parse(decodeMcpToolResult(response))
    expect(result.text).toContain('Previously collected output')
    expect(result.text).toContain(f.tail)
    expect(result).toMatchObject({ source: 'saved-tail', nextOffset: Buffer.byteLength(result.text), logBytes: Buffer.byteLength(result.text) })
    expect((await f.call({}, 'denied')).isError).toBe(true)
    const grouped = CiLogsOutputSchema.parse(decodeMcpToolResult(await f.call({ group: true })))
    expect(grouped.parts).toMatchObject([{ run: f.run, source: 'saved-tail', text: result.text }])
    let offset = 0
    let text = ''
    while (offset < result.logBytes) {
      const page = CiLogsOutputSchema.parse(decodeMcpToolResult(await f.call({ afterOffset: offset, maxBytes: 7 })))
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(7)
      expect(page.text).not.toContain('\uFFFD')
      expect(page.nextOffset).toBeGreaterThan(offset)
      text += page.text
      offset = page.nextOffset
    }
    expect(text).toBe(result.text)
    vi.mocked(f.endpoint.computers).mockResolvedValue([{ key: 'worker', label: 'Build computer', priority: 0,
      hostRef: f.run.computer!.hostRef }])
    vi.mocked(f.endpoint.request).mockResolvedValue({ operation: 'read', text: 'full executor log', nextOffset: 17,
      run: { runId: f.run.id, state: 'failed', step: 'unit', exitCode: 1, message: null,
        startedAt: f.run.startedAt!, finishedAt: f.run.finishedAt, logBytes: 17 } })
    const recovered = CiLogsOutputSchema.parse(decodeMcpToolResult(await f.call({ afterOffset: 0 })))
    expect(recovered.text).toBe('full executor log')
    expect(recovered.source).not.toBe('saved-tail')
  } finally { await f.close() }
})

it('preserves executor errors for live CI instead of presenting a terminal snapshot', async () => {
  const f = fixture()
  try {
    f.run.state = 'running'
    f.run.finishedAt = null
    expect((await f.call()).isError).toBe(true)
  } finally { await f.close() }
})
