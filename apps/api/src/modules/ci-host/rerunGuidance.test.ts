import type pg from 'pg'
import Fastify from 'fastify'
import { CiGetOutputSchema, CiRunOutputSchema, CiRunRecordSchema,
  type CiTestResults } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { afterEach, expect, it, vi } from 'vitest'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import type { AppInteractionService } from '../interactions/app.js'
import { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { CI_RUN_ACTIONS, CI_GET_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from './service.js'

afterEach(() => { vi.restoreAllMocks() })

const failedFiles = ['apps/api/test/cart.integration.test.ts', 'apps/api/test/orders.integration.test.ts']
const passedFile = 'apps/api/test/catalog.integration.test.ts'
const commit = 'a'.repeat(40)

function report(files: { file: string; status: 'passed' | 'failed' | 'skipped'; tests?: boolean }[]): CiTestResults {
  return { summary: { passed: 1, failed: 2, skipped: 1 }, truncated: false,
    files: files.map(({ file, status, tests = true }) => ({ file, status, durationMs: 1,
      tests: tests ? [{ name: 'responds', status, durationMs: 1 }] : [] })) }
}

function fixture(audience: 'worker' | 'operator' = 'worker') {
  const caller: ManagementPrincipal = { id: 'fixture-agent', name: 'Agent', audience,
    ...(audience === 'worker' ? { agentId: 'agent' } : {}),
    grants: [{ actions: [...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], scope: { workspaceIds: ['workspace'] } }],
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const groupId = '11111111-1111-4111-8111-111111111111'
  const records = [0, 1, 2].map(index => CiRunRecordSchema.parse({
    id: `${index + 2}2222222-2222-4222-8222-222222222222`, workspaceId: 'workspace', groupId,
    suite: 'integration', part: null, scope: 'full', files: [], partition: { index, count: 3 },
    repository: 'example/project', commit, state: index === 0 ? 'passed' : 'failed',
    computer: null, step: 'integration', exitCode: index === 0 ? 0 : 1, message: null,
    queuedAt: '2026-10-16T00:00:00.000Z', startedAt: null, finishedAt: '2026-10-16T00:01:00.000Z',
    initiator: { principalId: caller.id, executionId: null },
  }))
  const reports = new Map<string, CiTestResults | null>([
    [records[0]!.id, report([{ file: passedFile, status: 'passed' }])],
    [records[1]!.id, report([{ file: failedFiles[1]!, status: 'failed' },
      { file: passedFile, status: 'passed' }, { file: 'apps/api/test/skipped.integration.test.ts', status: 'skipped' }])],
    [records[2]!.id, report([{ file: failedFiles[0]!, status: 'failed', tests: false },
      { file: failedFiles[1]!, status: 'failed' }])],
  ])
  const query = vi.fn(async (sql: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (sql.includes('from workspaces')) return { rows: [{ record: { id: 'workspace', name: 'CI fixture',
      repository: { provider: 'github', owner: 'example', name: 'project', defaultBranch: 'main' } } }], rowCount: 1 }
    if (sql.startsWith('insert into ci_runs')) {
      records.push(CiRunRecordSchema.parse(JSON.parse(values[3] as string)))
    }
    if (sql.includes('from ci_runs where group_id=$1')) {
      const rows = records.filter(run => run.groupId === values[0] && run.workspaceId === values[1])
        .map(record => ({ record, log_tail: '', failed_files: (reports.get(record.id)?.files ?? [])
          .filter(file => file.status === 'failed').map(file => file.file) }))
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('where id=$1 and workspace_id=$2')) {
      const record = records.find(run => run.id === values[0] && run.workspaceId === values[1])
      return { rows: record ? [{ record, log_tail: '', test_results: reports.get(record.id) ?? null }] : [],
        rowCount: record ? 1 : 0 }
    }
    return { rows: [], rowCount: 0 }
  })
  const pool = { query } as unknown as pg.Pool
  const authority: CiAuthority = { resolve: async principal => {
    if (!principal.grants.length) throw new DomainError('ACCESS_DENIED', 'CI access denied.', 403)
    return { principal, workspaceId: 'workspace' }
  } }
  const commands = {
    execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
      await input.authorize?.(pool as unknown as pg.PoolClient)
      await input.prepare?.(pool)
      return { value: await input.perform(pool as unknown as pg.PoolClient), replayed: false }
    },
    recordDenied: vi.fn(async () => undefined), recordAudit: vi.fn(async () => undefined),
  } as unknown as PostgresCommandCoordinator
  const endpoint: HostCiEndpoint = { computers: async () => [],
    request: vi.fn(async () => { throw new Error('No executor calls expected') }) }
  const commits: CiCommits = { resolve: async () => commit,
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
      toolAccess: async () => ({ role: 'coder', tools: ['ci_run', 'ci_get'] }) } as unknown as AppInteractionService })
  const call = async (name: string, input: Record<string, unknown>, token = 'agent') => {
    const response = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name,
        arguments: { ...(audience === 'operator' ? { workspaceId: 'workspace' } : {}), ...input } } } })
    const data = response.body.split('\n').find(line => line.startsWith('data: '))
    const message = data ? JSON.parse(data.slice(6)) : response.json()
    expect(message.result, response.body).toBeDefined()
    const result = message.result
    return { isError: result.isError, value: JSON.parse(result.content[0].text) }
  }
  return { records, reports, query, call, endpoint, close: async () => { await ci.close(); await app.close() } }
}

it.each(['worker', 'operator'] as const)(
  'exposes group failures on a passed ticket and accepts only those files for an affected rerun through authenticated %s MCP',
  async audience => {
    const f = fixture(audience)
    try {
      const lead = f.records[0]!
      const result = await f.call('ci_get', { ticketId: lead.id, logTail: false, testStatus: ['passed'] })
      expect(result.isError, JSON.stringify(result.value)).not.toBe(true)
      expect(result.value).toMatchObject({ run: { state: 'passed' }, group: { state: 'failed' }, failedFiles })
      const output = CiGetOutputSchema.parse(result.value)
      const rerun = await f.call('ci_run', { suite: lead.suite, commit: lead.commit,
        scope: 'affected', files: result.value.failedFiles })
      expect(rerun.isError, JSON.stringify(rerun.value)).not.toBe(true)
      const { ticketId } = CiRunOutputSchema.parse(rerun.value)
      const saved = f.records.find(run => run.id === ticketId)!
      expect(saved).toMatchObject({ scope: 'affected', files: failedFiles, commit, suite: 'integration' })
      const readback = await f.call('ci_get', { ticketId, logTail: false })
      expect(CiGetOutputSchema.parse(readback.value).run).toEqual(saved)
      expect((await f.call('ci_get', { ticketId: lead.id, logTail: false })).value.failedFiles)
        .toEqual(result.value.failedFiles)
      expect(output.partitions).toHaveLength(3)
      expect(f.endpoint.request).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

it('keeps file-level failures with no test cases and ignores the requested test-status filter', async () => {
  const f = fixture()
  try {
    const result = await f.call('ci_get', { ticketId: f.records[2]!.id, logTail: false, testStatus: ['failed'] })
    expect(result.isError, JSON.stringify(result.value)).not.toBe(true)
    expect(result.value).toMatchObject({ failedFiles,
      failureHistory: expect.arrayContaining([expect.objectContaining({ file: failedFiles[0], test: null })]) })
  } finally { await f.close() }
})

it('returns an empty failed-file list when a failed group has no reported tests', async () => {
  const f = fixture()
  try {
    f.reports.clear()
    const result = await f.call('ci_get', { ticketId: f.records[0]!.id, logTail: false })
    expect(result.isError, JSON.stringify(result.value)).not.toBe(true)
    expect(result.value).toMatchObject({ group: { state: 'failed' }, failedFiles: [] })
  } finally { await f.close() }
})

it('omits failed files for a passed group', async () => {
  const f = fixture()
  try {
    for (const run of f.records) run.state = 'passed'
    f.reports.clear()
    const result = await f.call('ci_get', { ticketId: f.records[0]!.id, logTail: false })
    expect(result.isError, JSON.stringify(result.value)).not.toBe(true)
    expect(result.value.group.state).toBe('passed')
    expect(result.value).not.toHaveProperty('failedFiles')
  } finally { await f.close() }
})

it.each(['ci_get', 'ci_run'])('denies an unauthorized %s caller before reading or changing tickets', async name => {
  const f = fixture()
  try {
    const before = structuredClone(f.records)
    const result = await f.call(name, name === 'ci_get' ? { ticketId: f.records[0]!.id }
      : { suite: 'integration', commit, scope: 'affected', files: failedFiles }, 'denied')
    expect(result.isError).toBe(true)
    expect(result.value.error.code).toBe('ACCESS_DENIED')
    expect(f.query).not.toHaveBeenCalled()
    expect(f.records).toEqual(before)
    expect(f.endpoint.request).not.toHaveBeenCalled()
  } finally { await f.close() }
})
