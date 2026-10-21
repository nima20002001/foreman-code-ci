import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import Fastify from 'fastify'
import { CiGetOutputSchema, CiRunOutputSchema, CiRunRecordSchema,
  type CiHostRun, type CiRunRecord } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { afterEach, expect, it, vi } from 'vitest'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import type { AppInteractionService } from '../interactions/app.js'
import { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { DeviceApplicationAdmissionError } from '../devices/deviceApplicationError.js'
import { CI_RUN_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from './service.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const computer: HostCiComputer = {
  key: 'fixture:builder', hostRef: { kind: 'main', mainId: 'fixture-main' },
  label: 'Build executor', priority: 0,
}

/** An in-memory ticket table with the same compare-and-set writes as the dispatch path. */
function ticketDatabase() {
  const rows = new Map<string, { record: CiRunRecord; host_key: string | null }>()
  const claims = new Map<string, string>()
  const query = async (sql: string, values: unknown[] = []) => {
    const text = sql.replace(/\s+/gu, ' ').trim()
    const listed = () => [...rows.values()].map(row => ({ ...structuredClone(row), id: row.record.id,
      log_tail: '', durations: null }))
    if (text.includes('from workspaces')) return { rows: [{ record: { id: 'workspace', name: 'CI fixture',
      repository: { provider: 'github', owner: 'example', name: 'project', defaultBranch: 'main' } } }], rowCount: 1 }
    if (text.startsWith('insert into ci_dispatch_claims')) {
      if (claims.has(values[0] as string)) return { rows: [], rowCount: 0 }
      claims.set(values[0] as string, values[1] as string)
      return { rows: [], rowCount: 1 }
    }
    if (text.startsWith('delete from ci_dispatch_claims')) {
      if (claims.get(values[0] as string) === values[1]) claims.delete(values[0] as string)
      return { rows: [], rowCount: 1 }
    }
    if (text.startsWith('update ci_dispatch_claims')) {
      return { rows: [], rowCount: Number(claims.get(values[0] as string) === values[1]) }
    }
    if (text.startsWith('insert into ci_runs')) {
      const record = CiRunRecordSchema.parse(JSON.parse(values[3] as string))
      rows.set(record.id, { record, host_key: null })
      return { rows: [], rowCount: 1 }
    }
    if (text.startsWith('update ci_runs')) {
      const previous = rows.get(values[0] as string)
      const expectedRecord = values.length === 11 ? values[8] : values[4]
      const expected = JSON.parse(expectedRecord as string)
      if (!previous || !isDeepStrictEqual(previous.record, expected)) return { rows: [], rowCount: 0 }
      const record = CiRunRecordSchema.parse(JSON.parse(values[3] as string))
      let hostKey = previous.host_key
      if (text.includes('host_key=null')) hostKey = null
      else if (text.includes('host_key=$3')) hostKey = values[2] as string | null
      rows.set(record.id, { record, host_key: hostKey })
      return { rows: [], rowCount: 1 }
    }
    if (text.startsWith('select record from ci_runs where id=')) {
      return { rows: listed().filter(row => row.id === values[0]), rowCount: 1 }
    }
    if (text.includes('from ci_runs where group_id=$1')) {
      return { rows: listed().filter(row => row.record.groupId === values[0]), rowCount: 1 }
    }
    if (text.startsWith('select record,durations from ci_runs')) {
      return { rows: listed().filter(row => row.record.state === 'queued') }
    }
    if (text.includes("'supersededBy' is not null") || text.includes("'gate'='true'")) return { rows: [] }
    if (text.includes("state in ('starting','running')")) {
      return { rows: listed().filter(row => ['starting', 'running'].includes(row.record.state)) }
    }
    return { rows: [], rowCount: 0 }
  }
  const pool = { options: { max: 10 }, query,
    connect: async () => ({ query, release: () => {} }) } as unknown as pg.Pool
  return { pool, rows }
}

function fixture(lostReplies: number, rejection: string | Error | null, options: { unchangedStatus?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  const { pool, rows } = ticketDatabase()
  const caller: ManagementPrincipal = {
    id: 'fixture-agent', name: 'Agent', audience: 'worker', agentId: 'agent',
    grants: [{ actions: CI_RUN_ACTIONS, scope: { workspaceIds: ['workspace'] } }],
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  }
  const authority: CiAuthority = { resolve: async principal => {
    if (!principal.grants.length) throw new DomainError('ACCESS_DENIED', 'CI access denied.', 403)
    return { principal, workspaceId: 'workspace' }
  } }
  const commands = {
    execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
      const client = pool as unknown as pg.PoolClient
      await input.authorize?.(client)
      await input.prepare?.(pool)
      await input.preparedMutation?.validate(client)
      return { value: await input.perform(client), replayed: false }
    },
    recordDenied: vi.fn(async () => undefined), recordAudit: vi.fn(async () => undefined),
  } as unknown as PostgresCommandCoordinator
  let attempts = 0
  let ready = true
  const running = new Map<string, CiHostRun>()
  const endpoint: HostCiEndpoint = {
    computers: async () => [computer],
    request: async (_computer, request) => {
      if (request.operation === 'status') return { operation: 'status', ready,
        reasons: ready ? [] : ['Waiting for capacity'], cpuCount: 8, memoryBytes: 16 * 2 ** 30,
        slotsUsed: running.size, slotsTotal: 1, runs: [...running.values()] }
      if (request.operation === 'start') {
        attempts++
        if (attempts <= lostReplies || rejection === null) throw new Error('Start response lost')
        if (attempts === lostReplies + 1) {
          ready = options.unchangedStatus ?? false
          throw rejection instanceof Error ? rejection : new DomainError(rejection, 'The host did not start this ticket.', 409)
        }
        const run: CiHostRun = { runId: request.runId, state: 'running', step: 'unit', exitCode: null,
          startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0, message: null }
        running.set(run.runId, run)
        return { operation: 'start', run }
      }
      if (request.operation === 'read' && running.has(request.runId)) {
        return { operation: 'read', run: running.get(request.runId)!, text: '', nextOffset: 0 }
      }
      throw new Error(`Unexpected host operation: ${request.operation}`)
    },
  }
  const commits: CiCommits = { resolve: async () => 'a'.repeat(40),
    capabilities: async () => ({ parts: false, integrationPartitions: false, affected: false }) }
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
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } } })
    const line = response.body.split('\n').find(value => value.startsWith('data: '))
    const message = line ? JSON.parse(line.slice(6)) : response.json()
    expect(message.result, response.body).toBeDefined()
    const result = message.result as { isError?: boolean; content: { text: string }[] }
    return { isError: result.isError, value: JSON.parse(result.content[0]!.text) }
  }
  return { call, rows, attempts: () => attempts,
    async dispatch() {
      await ci.dispatch()
      await ci.drain()
    },
    resume() {
      ready = true
      vi.setSystemTime(Date.now() + 6000)
    },
    close: async () => { await ci.close(); await app.close() },
  }
}

const rejections = ['CI_HOST_BUSY', 'COMPUTER_GITHUB_REQUIRED', 'CI_CLOUD_UNAVAILABLE',
  'BUILD_COMPUTER_DISABLED', 'CI_HOST_PROTOCOL_UNSUPPORTED', 'WORKER_RUNTIME_DRAINING',
  'WORKER_UPDATING', 'WORKER_VERSION_SKEW', 'WORKER_STATUS_UNAVAILABLE', 'WORKER_BUNDLE_UNPUBLISHED',
  new DeviceApplicationAdmissionError('admission_queue_full')]

it.each(rejections.flatMap(code => [0, 1, 2].map(lostReplies => ({ code, lostReplies }))))(
  'requeues $code after $lostReplies lost replies and starts the MCP ticket on the next dispatch', async input => {
    const f = fixture(input.lostReplies, input.code)
    try {
      const denied = await f.call('ci_run', { suite: 'unit', scope: 'full', commit: 'a'.repeat(40) }, 'denied')
      expect(denied).toMatchObject({ isError: true, value: { error: { code: 'ACCESS_DENIED' } } })
      expect(f.rows.size).toBe(0)
      expect(f.attempts()).toBe(0)
      const started = await f.call('ci_run', { suite: 'unit', scope: 'full', commit: 'a'.repeat(40) })
      expect(started.isError).not.toBe(true)
      const { ticketId } = CiRunOutputSchema.parse(started.value)
      for (let pass = 0; pass < 4; pass++) await f.dispatch()
      expect(f.attempts()).toBe(input.lostReplies + 1)
      const queued = await f.call('ci_get', { ticketId, logTail: false })
      expect(queued.isError).not.toBe(true)
      expect(CiGetOutputSchema.parse(queued.value).run).toMatchObject({
        state: 'queued', computer: null, step: null, startedAt: null, finishedAt: null,
      })
      expect(queued.value.run.dispatchHostKey).toBeUndefined()
      expect(queued.value.run.dispatchAttempts).toBeUndefined()
      expect(queued.value.run.dispatchRequest).toBeUndefined()
      expect(queued.value.run.message).not.toContain('Ownership retained')
      expect(f.rows.get(ticketId)?.host_key).toBeNull()

      f.resume()
      await f.dispatch()
      const accepted = await f.call('ci_get', { ticketId, logTail: false })
      expect(accepted.isError).not.toBe(true)
      expect(CiGetOutputSchema.parse(accepted.value).run).toMatchObject({
        id: ticketId, state: 'running', computer: { hostRef: computer.hostRef }, step: 'unit',
      })
      expect(f.attempts()).toBe(input.lostReplies + 2)
    } finally {
      await f.close()
    }
  },
)

it('fails the MCP ticket instead of requeueing it when the mirror refuses private data', async () => {
  const f = fixture(0, 'CI_MIRROR_PRIVATE_DATA')
  try {
    const started = await f.call('ci_run', { suite: 'unit', scope: 'full', commit: 'a'.repeat(40) })
    const { ticketId } = CiRunOutputSchema.parse(started.value)
    for (let pass = 0; pass < 4; pass++) await f.dispatch()
    expect(f.attempts()).toBe(1)
    const result = await f.call('ci_get', { ticketId, logTail: false })
    expect(result.isError).not.toBe(true)
    expect(CiGetOutputSchema.parse(result.value).run).toMatchObject({ state: 'failed', step: null })
  } finally {
    await f.close()
  }
})

it('retains the MCP ticket assignment when all start outcomes remain unknown', async () => {
  const f = fixture(0, null)
  try {
    const started = await f.call('ci_run', { suite: 'unit', scope: 'full', commit: 'a'.repeat(40) })
    const { ticketId } = CiRunOutputSchema.parse(started.value)
    for (let pass = 0; pass < 4; pass++) await f.dispatch()
    const result = await f.call('ci_get', { ticketId, logTail: false })
    expect(result.isError).not.toBe(true)
    expect(CiGetOutputSchema.parse(result.value).run).toMatchObject({ state: 'starting', step: 'dispatch',
      computer: { hostRef: computer.hostRef }, startedAt: null, dispatchAttempts: 3,
      dispatchRequest: { runId: ticketId }, message: expect.stringContaining('Ownership retained') })
    expect(f.rows.get(ticketId)?.host_key).toBe(computer.key)
    expect(f.attempts()).toBe(3)
  } finally {
    await f.close()
  }
})


it('backs off a refused recovery retry even when healthy status remains unchanged', async () => {
  const f = fixture(1, 'WORKER_UPDATING', { unchangedStatus: true })
  try {
    const started = await f.call('ci_run', { suite: 'unit', scope: 'full', commit: 'a'.repeat(40) })
    const { ticketId } = CiRunOutputSchema.parse(started.value)
    for (let pass = 0; pass < 4; pass++) await f.dispatch()
    expect(f.attempts()).toBe(2)
    const queued = await f.call('ci_get', { ticketId, logTail: false })
    expect(CiGetOutputSchema.parse(queued.value).run).toMatchObject({ state: 'queued', computer: null })
    vi.setSystemTime(Date.now() + 59_999)
    await f.dispatch()
    expect(f.attempts()).toBe(2)
    vi.setSystemTime(Date.now() + 6000)
    await f.dispatch()
    const accepted = await f.call('ci_get', { ticketId, logTail: false })
    expect(CiGetOutputSchema.parse(accepted.value).run).toMatchObject({ state: 'running' })
    expect(f.attempts()).toBe(3)
  } finally {
    await f.close()
  }
})

it.each([
  { scope: 'affected' },
  { scope: 'affected', files: ['test/selection.test.mjs'] },
  { files: ['test/selection.test.mjs'] },
  { files: [] },
])('rejects unsupported explicit selection through MCP: %j', async selection => {
  const f = fixture(0, 'CI_HOST_BUSY')
  try {
    const input = { suite: 'unit', commit: 'a'.repeat(40), ...selection }
    const denied = await f.call('ci_run', input, 'denied')
    expect(denied).toMatchObject({ isError: true, value: { error: { code: 'ACCESS_DENIED' } } })
    const result = await f.call('ci_run', input)
    expect(result).toMatchObject({ isError: true, value: { error: {
      code: 'CI_SELECTION_UNSUPPORTED',
      message: expect.stringMatching(/no affected test selection.*scope full/i),
    } } })
    expect(f.rows.size).toBe(0)
    expect(f.attempts()).toBe(0)
  } finally {
    await f.close()
  }
})

it.each([{}, { scope: 'full' }])('persists full scope without a selector through MCP: %j', async selection => {
  const f = fixture(0, 'CI_HOST_BUSY')
  try {
    const started = await f.call('ci_run', { suite: 'unit', commit: 'a'.repeat(40), ...selection })
    expect(started.isError).not.toBe(true)
    const { ticketId } = CiRunOutputSchema.parse(started.value)
    expect(f.rows.get(ticketId)?.record).toMatchObject({ scope: 'full', files: [] })
    const result = await f.call('ci_get', { ticketId, logTail: false })
    expect(result.isError).not.toBe(true)
    expect(CiGetOutputSchema.parse(result.value).run).toMatchObject({ id: ticketId, scope: 'full', files: [] })
  } finally {
    await f.close()
  }
})
