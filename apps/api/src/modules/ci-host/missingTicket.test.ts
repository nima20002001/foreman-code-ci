import type pg from 'pg'
import Fastify from 'fastify'
import { CiRunOutputSchema, CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import type { AppInteractionService } from '../interactions/app.js'
import { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from './service.js'

function fixture(executionId: string | null = 'execution', audience: 'worker' | 'operator' = 'worker') {
  const caller: ManagementPrincipal = {
    id: 'fixture-agent', name: 'Agent', audience, ...(audience === 'worker' ? { agentId: 'agent' } : {}),
    grants: [{ actions: [...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], scope: { workspaceIds: ['workspace'] } }],
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  }
  const records: CiRunRecord[] = []
  const recent = vi.fn(async (...identity: unknown[]) => ({ identity, rows: records.slice(0, 1).map(record => ({
    record, created_at: '2026-10-16T03:09:00.000Z', states: ['running', 'passed'],
  })) }))
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (sql.includes('from workspaces')) return { rows: [{ record: { id: 'workspace', name: 'CI fixture',
      repository: { provider: 'github', owner: 'fixture', name: 'site', defaultBranch: 'main' } } }], rowCount: 1 }
    if (sql.startsWith('insert into ci_runs')) records.push(CiRunRecordSchema.parse(JSON.parse(params[3] as string)))
    if (sql.includes('recent_ci_groups')) return { ...await recent(...params), rowCount: 1 }
    if (sql.includes('where id=$1 and workspace_id=$2')) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(String(params[0]))) {
        throw Object.assign(new Error(`invalid input syntax for type uuid: "${params[0]}"`), { code: '22P02' })
      }
      const record = records.find(run => run.id === params[0] && run.workspaceId === params[1])
      return { rows: record ? [{ record, log_tail: '' }] : [], rowCount: record ? 1 : 0 }
    }
    return { rows: [], rowCount: 0 }
  })
  const pool = { query } as unknown as pg.Pool
  const authority: CiAuthority = { resolve: async principal => {
    if (!principal.grants.length) throw new DomainError('ACCESS_DENIED', 'CI read denied.', 403)
    return { principal: { ...principal, id: 'fixture-owner' }, workspaceId: 'workspace', executionId: executionId ?? undefined }
  } }
  const commands = {
    execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
      await input.prepare?.(pool)
      return { value: await input.perform(pool as unknown as pg.PoolClient), replayed: false }
    },
    recordDenied: vi.fn(async () => undefined), recordAudit: vi.fn(async () => undefined),
  } as unknown as PostgresCommandCoordinator
  const endpoint: HostCiEndpoint = { computers: async () => [],
    request: vi.fn(async () => { throw new Error('No executor calls expected') }) }
  const commits: CiCommits = { resolve: async () => 'a'.repeat(40),
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }) }
  const ci = new HostCiService(pool, commands, authority, commits, endpoint)
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token === 'agent') return caller
    if (token === 'denied') return { ...caller, id: 'denied', grants: [] }
    throw new DomainError('AUTH_INVALID', 'Invalid token.', 401)
  })
  const app = Fastify()
  registerGraphqlMcp(app, { access, operator: { ci, commands } as unknown as OperatorServices,
    interactions: { canRead: async () => false, canRespond: async () => false,
      toolAccess: async () => ({ role: 'coder', tools: ['ci_run', 'ci_get', 'ci_logs_read', 'ci_cancel'] })
    } as unknown as AppInteractionService })
  const call = async (name: string, input: Record<string, unknown>, token = 'agent') => {
    const response = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name,
        arguments: { ...(audience === 'operator' ? { workspaceId: 'workspace' } : {}), ...input } } } })
    const data = response.body.split('\n').find(line => line.startsWith('data: '))
    const message = data ? JSON.parse(data.slice(6)) : response.json()
    expect(message.result, response.body).toBeDefined()
    return message.result as { isError?: boolean; content: { type: string; text: string }[] }
  }
  return { call, recent, records, endpoint, close: async () => { await ci.close(); await app.close() } }
}

const ticketTools = [
  { name: 'ci_get', input: {} },
  { name: 'ci_get', input: { waitUntil: 'group-terminal', waitSeconds: 1800, logTail: false } },
  { name: 'ci_get', input: { testStatus: ['failed'] } },
  { name: 'ci_logs_read', input: {} },
  { name: 'ci_logs_read', input: { group: true } },
  { name: 'ci_cancel', input: {} },
]
const missingIds = [
  'e46a037c-669d-4e2d-adea-cb91a',
  'not-a-ticket',
  'e46a037c-669d-4e2d-adea-cb91abcdefgz',
  '11111111-1111-4111-8111-111111111111',
]

it.each(ticketTools.flatMap(tool => (['worker', 'operator'] as const).map(audience => ({ ...tool, audience }))))(
  'returns recent tickets for malformed and unknown ids through authenticated $audience $name ($input)',
  async ({ audience, name, input }) => {
    const f = fixture('execution', audience)
    try {
      const record = CiRunRecordSchema.parse({
        id: '22222222-2222-4222-8222-222222222222', workspaceId: 'workspace',
        groupId: '33333333-3333-4333-8333-333333333333', suite: 'integration', part: null,
        scope: 'full', files: [], partition: null, repository: 'fixture/site', commit: 'a'.repeat(40),
        state: 'running', computer: null, step: 'integration', exitCode: null, message: null,
        queuedAt: '2026-10-16T03:09:00.000Z', startedAt: null, finishedAt: null,
        initiator: { principalId: 'fixture-agent', executionId: 'execution' },
      })
      f.records.push(record)
      for (const ticketId of [...missingIds, record.groupId, record.groupId.slice(0, -7)]) {
        const result = await f.call(name, { ...input, ticketId })
        const { error } = JSON.parse(result.content[0]!.text)
        expect(result.isError, `${name} ${JSON.stringify(input)} ${ticketId}`).toBe(true)
        expect(error?.code, `${name} ${ticketId}`).toBe('CI_RUN_NOT_FOUND')
        expect(error.message).toContain(`${record.id} (integration full, running, 03:09)`)
        expect(error.details.recentTickets).toEqual([{ ticketId: record.id, suite: 'integration', scope: 'full',
          state: 'running', createdAt: '2026-10-16T03:09:00.000Z' }])
      }
      expect(f.recent.mock.calls.every(call => call[1] === 'fixture-agent' && call[2] === 'execution')).toBe(true)
      expect(f.endpoint.request).not.toHaveBeenCalled()
      expect(f.records).toEqual([record])
    } finally { await f.close() }
  })

it.each(ticketTools)('denies malformed ids on $name before reading caller history ($input)', async ({ name, input }) => {
  const f = fixture()
  try {
    const result = await f.call(name, { ...input, ticketId: missingIds[0] }, 'denied')
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('ACCESS_DENIED')
    expect(f.recent).not.toHaveBeenCalled()
    expect(f.endpoint.request).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it.each(['ci_get', 'ci_logs_read'])('suggests the real agent ticket after a typo through authenticated %s', async tool => {
  const f = fixture()
  try {
    const started = await f.call('ci_run', { suite: 'integration', scope: 'full', partitions: 2, commit: 'a'.repeat(40) })
    expect(started.isError).not.toBe(true)
    const { ticketId } = CiRunOutputSchema.parse(JSON.parse(started.content[0]!.text))
    expect(f.records).toHaveLength(2)
    const typo = `${ticketId.slice(0, -1)}${ticketId.endsWith('0') ? '1' : '0'}`
    const result = await f.call(tool, { ticketId: typo })
    expect(result.isError).toBe(true)
    const { error } = JSON.parse(result.content[0]!.text)
    expect(error.code).toBe('CI_RUN_NOT_FOUND')
    expect(error.message).toBe(`No such CI run in this workspace: ${typo}. Your recent CI tickets: `
      + `${ticketId} (integration full, running, 03:09).`)
    expect(error.details.recentTickets).toEqual([{ ticketId, suite: 'integration', scope: 'full',
      state: 'running', createdAt: '2026-10-16T03:09:00.000Z' }])
    expect(f.recent).toHaveBeenCalledExactlyOnceWith('workspace', 'fixture-agent', 'execution')
    expect(f.endpoint.request).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('returns an empty hint when the caller has no CI history', async () => {
  const f = fixture()
  try {
    const result = await f.call('ci_get', { ticketId: '11111111-1111-4111-8111-111111111111' })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.text).error).toMatchObject({ code: 'CI_RUN_NOT_FOUND',
      details: { recentTickets: [] } })
  } finally { await f.close() }
})

it('does not look up recent tickets for a denied caller', async () => {
  const f = fixture()
  try {
    const result = await f.call('ci_get', { ticketId: '11111111-1111-4111-8111-111111111111' }, 'denied')
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('ACCESS_DENIED')
    expect(f.recent).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('uses principal history when the call has no execution', async () => {
  const f = fixture(null)
  try {
    const result = await f.call('ci_get', { ticketId: '11111111-1111-4111-8111-111111111111' })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.text).error.details.recentTickets).toEqual([])
    expect(f.recent).toHaveBeenCalledExactlyOnceWith('workspace', 'fixture-agent', null)
  } finally { await f.close() }
})

it('does not look up history when the requested ticket exists', async () => {
  const f = fixture()
  try {
    const started = await f.call('ci_run', { suite: 'integration', scope: 'full', commit: 'a'.repeat(40) })
    const { ticketId } = CiRunOutputSchema.parse(JSON.parse(started.content[0]!.text))
    const result = await f.call('ci_get', { ticketId, logTail: false })
    expect(result.isError).not.toBe(true)
    expect(JSON.parse(result.content[0]!.text).run.id).toBe(ticketId)
    expect(f.recent).not.toHaveBeenCalled()
  } finally { await f.close() }
})
