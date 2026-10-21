import type pg from 'pg'
import Fastify from 'fastify'
import { CiGetOutputSchema, CiRunRecordSchema, type CiHostRun, type CiRunRecord } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it, vi } from 'vitest'

import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { type CiAuthority, CI_GET_ACTIONS } from '../jobs/ciAuthority.js'
import { HostCiService, type HostCiEndpoint, type HostCiComputer, type CiCommits } from './service.js'
import { deferred } from '../../../test/helpers/deferred.js'

const caller: ManagementPrincipal = {
  id: 'operator', name: 'Operator', audience: 'operator',
  grants: [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: ['workspace'] } }],
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
}
const computer: HostCiComputer = {
  key: 'main:builder', hostRef: { kind: 'main', mainId: 'main' }, label: 'Builder', priority: 0,
}

function fixture(suite: 'lint' | 'integration' = 'lint') {
  let record = CiRunRecordSchema.parse({
    id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace',
    groupId: '22222222-2222-4222-8222-222222222222', suite, part: null,
    scope: 'full', files: [], partition: suite === 'integration' ? { index: 0, count: 2, hostIndexes: [0] } : null,
    repository: 'owner/repo', commit: 'a'.repeat(40),
    state: 'running', computer: { hostRef: computer.hostRef, label: computer.label }, step: suite,
    exitCode: null, message: null, queuedAt: '2026-10-12T00:00:00.000Z',
    startedAt: '2026-10-12T00:00:01.000Z', finishedAt: null,
    initiator: { principalId: 'worker', executionId: 'execution' },
  })
  let logTail = 'persisted log\n'
  const pool = { options: { max: 10 }, query: vi.fn(async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith('update ci_runs')) {
      record = CiRunRecordSchema.parse(JSON.parse(parameters![3] as string))
      if (typeof parameters![5] === 'string') logTail = parameters![5]
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('from ci_group_requesters')) return { rows: [] }
    if (sql.includes('durations from ci_runs')) return { rows: [] }
    if (sql.startsWith('select id,host_key')) return { rows: [{ id: record.id, host_key: computer.key, record }] }
    return { rows: [{ record, log_tail: logTail, host_key: computer.key }] }
  }), connect: async () => ({ query: pool.query, release: () => {} }) } as unknown as pg.Pool
  const resolve = vi.fn(async (principal: ManagementPrincipal) => {
    if (!principal.grants.length) throw new DomainError('ACCESS_DENIED', 'CI read denied.', 403)
    return { principal, workspaceId: 'workspace', executionId: 'execution' }
  })
  const authority: CiAuthority = { resolve }
  const endpoint: HostCiEndpoint = {
    computers: vi.fn(async () => [computer]),
    request: vi.fn(async () => { throw new Error('Build computer unavailable') }),
  }
  const commands = new PostgresCommandCoordinator(pool)
  const create = () => new HostCiService(pool, commands, authority,
    {} as CiCommits, endpoint)
  return { create, pool, commands, endpoint, resolve, read: () => ({ record, logTail }) }
}

it('dispatches persisted tickets immediately when the service starts and keeps one timer', async () => {
  const service = fixture().create()
  const dispatch = vi.spyOn(service, 'dispatch').mockResolvedValue(undefined)
  try {
    service.start(60_000)
    service.start(60_000)
    expect(dispatch).toHaveBeenCalledTimes(1)
  } finally {
    await service.close()
  }
})

/** A dispatch pass hands readiness reads and run observations to background work; wait for it and any pass it requests. */
async function dispatchSettled(service: HostCiService) {
  await service.dispatch()
  await service.drain()
}

function dispatchFixture(settlementError?: Error) {
  const f = fixture()
  const active = f.read().record
  const queued = CiRunRecordSchema.parse({ ...active,
    id: '33333333-3333-4333-8333-333333333333',
    groupId: '44444444-4444-4444-8444-444444444444',
    state: 'queued', computer: null, startedAt: null, step: null,
  })
  const records: CiRunRecord[] = [active, queued]
  const tails = new Map<string, string>()
  /** One live owner per ticket, like the database claim table: a contender is refused until the owner releases. */
  const claims = new Map<string, string>()
  const query = async (sql: string, parameters?: unknown[]) => {
    if (sql.includes('insert into ci_dispatch_claims')) {
      if (claims.has(parameters![0] as string)) return { rows: [], rowCount: 0 }
      claims.set(parameters![0] as string, parameters![1] as string)
      return { rows: [{ ticket_id: parameters![0] }], rowCount: 1 }
    }
    if (sql.includes('delete from ci_dispatch_claims')) {
      if (claims.get(parameters![0] as string) === parameters![1]) claims.delete(parameters![0] as string)
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('ci_dispatch_claims')) {
      return { rows: [], rowCount: claims.get(parameters![0] as string) === parameters![1] ? 1 : 0 }
    }
    if (sql.startsWith('update ci_runs')) {
      const next = CiRunRecordSchema.parse(JSON.parse(parameters![3] as string))
      if (next.id === active.id && settlementError) throw settlementError
      const tail = parameters![5]
      for (const value of [next.message, tail]) {
        if (typeof value === 'string' && (value.includes('\0') || Buffer.from(value).toString('utf8') !== value)) {
          throw new Error('Database rejected invalid text')
        }
      }
      records[records.findIndex(record => record.id === next.id)] = next
      if (typeof tail === 'string') tails.set(next.id, tail)
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes("'supersededBy' is not null") || sql.includes("and record->>'gate'='true'")) return { rows: [] }
    if (sql.includes("state='queued'")) {
      return { rows: records.filter(record => record.state === 'queued').map(record => ({ record, durations: null })) }
    }
    if (sql.includes("state in ('starting','running')")) {
      return { rows: records.filter(record => ['starting', 'running'].includes(record.state))
        .map(record => ({ id: record.id, record, host_key: record.computer?.hostRef.kind === 'cloud'
          ? `cloud:${record.computer.hostRef.provider}` : computer.key })) }
    }
    if (sql.includes("'gate'='true'")) return { rows: [] }
    return { rows: records.filter(record => record.id === parameters?.[0] || record.groupId === parameters?.[0])
      .map(record => ({ record, log_tail: tails.get(record.id) ?? '' })) }
  }
  vi.mocked(f.pool.query).mockImplementation(query as unknown as pg.Pool['query'])
  const output = { text: 'finished\n', message: 'Done.' }
  /** Runs the host keeps executing: their reads report running instead of the passed outcome. */
  const keepRunning = new Set<string>()
  vi.mocked(f.endpoint.request).mockImplementation(async (_computer, request) => {
    if (request.operation === 'status') {
      return { operation: 'status', ready: true, reasons: [], cpuCount: 8,
        memoryBytes: 16 * 2 ** 30, runs: [], slotsTotal: 2, slotsUsed: 0 }
    }
    if (request.operation !== 'read' && request.operation !== 'start') throw new Error('Unexpected request')
    const finished = request.operation === 'read' && !keepRunning.has(request.runId)
    const run: CiHostRun = { runId: request.runId, state: finished ? 'passed' : 'running',
      step: 'lint', exitCode: finished ? 0 : null,
      startedAt: active.startedAt!, finishedAt: finished ? '2026-10-12T00:01:00.000Z' : null,
      message: output.message, logBytes: Buffer.byteLength(output.text) }
    if (request.operation === 'start') return { operation: 'start', run }
    return { operation: 'read', run, text: output.text, nextOffset: Buffer.byteLength(output.text) }
  })
  return { ...f, active, queued, records, output, keepRunning }
}

it('refreshes CI observations with background priority through the public dispatcher', async () => {
  const f = dispatchFixture()
  f.records.splice(1, 1)
  const service = f.create()
  try {
    await service.dispatch()
    expect(f.endpoint.request).toHaveBeenCalledWith(computer,
      expect.objectContaining({ operation: 'read', runId: f.active.id }), { priority: 'background' })
  } finally { await service.close() }
})

it.each(['github', 'circleci'] as const)(
  'releases a stale %s dispatch with no provider run after Main restarts', async provider => {
    const f = dispatchFixture()
    const cloud: HostCiComputer = { key: `cloud:${provider}`, label: 'Cloud executor', priority: 0,
      hostRef: { kind: 'cloud', mainId: 'fixture-main', provider, slot: 0 } }
    f.records.splice(0, 2, CiRunRecordSchema.parse({ ...f.queued, state: 'starting', step: 'dispatch',
      computer: { hostRef: cloud.hostRef, label: cloud.label },
      dispatchRequest: { operation: 'start', runId: f.queued.id, repository: f.queued.repository,
        commit: f.queued.commit, suite: f.queued.suite } }))
    vi.mocked(f.endpoint.computers).mockResolvedValue([cloud])
    vi.mocked(f.endpoint.request).mockImplementation(async (_computer, request) => {
      if (request.operation === 'read' || request.operation === 'cancel') {
        throw new DomainError('CI_RUN_UNKNOWN', 'No provider run exists.', 404)
      }
      if (request.operation === 'start') {
        throw new DomainError('CI_CLOUD_FAILED', 'Selected integration files are absent from the commit.', 502)
      }
      throw new Error('Unexpected cloud status request')
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      await dispatchSettled(f.create())
      const record = f.records[0]!
      if (record.state === 'starting') f.records[0] = { ...record,
        dispatchedAt: new Date(Date.now() - 75_000).toISOString() }
    }
    expect((await f.create().get(caller, { ticketId: f.queued.id })).run)
      .toMatchObject({ state: 'queued', computer: null, startedAt: null, unstartedProviders: [provider] })
    expect(f.endpoint.request).toHaveBeenCalledWith(cloud, expect.objectContaining({ operation: 'read' }))
    expect(vi.mocked(f.endpoint.request).mock.calls.filter(([, request]) => request.operation === 'start'))
      .toHaveLength(2)
  })

it.each(['missing-request', 'unavailable-provider'] as const)(
  'reconciles an expired cloud start while retaining unconfirmed provider ownership: %s', async failure => {
    const f = dispatchFixture()
    const cloud: HostCiComputer = { key: 'cloud:github', label: 'Cloud executor', priority: 0,
      hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'github', slot: 0 } }
    f.records.splice(0, 2, CiRunRecordSchema.parse({ ...f.queued, state: 'starting', step: 'dispatch',
      computer: { hostRef: cloud.hostRef, label: cloud.label },
      ...(failure === 'unavailable-provider' ? { dispatchAttempts: 3,
        dispatchedAt: new Date(Date.now() - 225_000).toISOString(),
        dispatchRequest: { operation: 'start', runId: f.queued.id,
          repository: f.queued.repository, commit: f.queued.commit, suite: f.queued.suite } } : {}) }))
    vi.mocked(f.endpoint.computers).mockResolvedValue(failure === 'missing-request' ? [cloud] : [])
    vi.mocked(f.endpoint.request).mockImplementation(async () => {
      if (failure === 'missing-request') throw new DomainError('CI_RUN_UNKNOWN', 'No cloud run exists.', 404)
      throw new Error('Cloud provider unavailable')
    })
    await dispatchSettled(f.create())
    expect((await f.create().get(caller, { ticketId: f.queued.id })).run)
      .toMatchObject(failure === 'missing-request'
        ? { state: 'queued', startedAt: null }
        : { state: 'starting', startedAt: null, observation: { status: 'unavailable',
          lastError: expect.stringContaining('ownership retained'), consecutiveFailures: expect.any(Number) } })
    if (failure === 'missing-request') expect(f.records[0]?.state).not.toBe('starting')
  })

it.each(['unready', 'offline'])('keeps ordinary CI queued when the computer is %s', async state => {
  const f = dispatchFixture()
  f.records.splice(0, 1)
  const request = vi.mocked(f.endpoint.request).getMockImplementation()!
  vi.mocked(f.endpoint.request).mockImplementation(async (target, input) => {
    if (input.operation === 'status') {
      if (state === 'offline') throw new Error('Worker status unavailable')
      return { operation: 'status', ready: false, reasons: ['Worker CI start protocol is unsupported; update the Worker.'],
        cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [], slotsTotal: 2, slotsUsed: 0 }
    }
    return request(target, input)
  })
  await f.create().dispatch()
  expect(f.records[0]).toMatchObject({ state: 'queued', computer: null })
  expect(f.endpoint.request).not.toHaveBeenCalledWith(computer, expect.objectContaining({ operation: 'start' }))
  expect((await f.create().computers(caller, { workspaceId: 'workspace' })).computers[0])
    .toMatchObject({ ready: false })
})

it('retains an unacknowledged Worker assignment when incompatible status omits the ticket', async () => {
  const f = dispatchFixture()
  const worker: HostCiComputer = { ...computer, hostRef: { kind: 'device', mainId: 'fixture-main', deviceId: 'fixture-worker' } }
  f.records.splice(0, 2, CiRunRecordSchema.parse({ ...f.queued, state: 'starting', step: 'dispatch',
    computer: { hostRef: worker.hostRef, label: worker.label }, dispatchHostKey: worker.key, dispatchAttempts: 3,
    dispatchedAt: new Date().toISOString(), dispatchRequest: { operation: 'start', runId: f.queued.id,
      repository: f.queued.repository, commit: f.queued.commit, suite: f.queued.suite,
      workspaceId: f.queued.workspaceId, ciMirror: null } }))
  vi.mocked(f.endpoint.computers).mockResolvedValue([worker])
  vi.mocked(f.endpoint.request).mockImplementation(async (_computer, input) => {
    if (input.operation !== 'status') throw new Error('An incompatible Worker must not receive another start.')
    return { operation: 'status', ready: false, reasons: ['Worker CI start protocol is unsupported; update the Worker.'],
      cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [] }
  })
  const service = f.create()
  await dispatchSettled(service)
  const result = await service.get(caller, { ticketId: f.queued.id })
  expect(result.run).toMatchObject({ state: 'starting', computer: { hostRef: worker.hostRef },
    dispatchHostKey: worker.key, dispatchAttempts: 3, dispatchRequest: { runId: f.queued.id },
    startedAt: null, finishedAt: null, message: expect.stringContaining('Operator cancellation is required') })
  expect(vi.mocked(f.endpoint.request).mock.calls.every(([, input]) => input.operation === 'status')).toBe(true)
})

it('releases a first start rejected by an incompatible Worker before execution', async () => {
  const f = dispatchFixture()
  f.records.splice(0, 1)
  const worker: HostCiComputer = { ...computer,
    hostRef: { kind: 'device', mainId: 'fixture-main', deviceId: 'fixture-worker' } }
  vi.mocked(f.endpoint.computers).mockResolvedValue([worker])
  const request = vi.mocked(f.endpoint.request).getMockImplementation()!
  vi.mocked(f.endpoint.request).mockImplementation(async (target, input) => {
    if (input.operation === 'start') {
      throw new DomainError('CI_HOST_PROTOCOL_UNSUPPORTED', 'Update the Worker CI protocol.', 409)
    }
    return request(target, input)
  })
  const service = f.create()
  await dispatchSettled(service)
  const result = await service.get(caller, { ticketId: f.queued.id })
  expect(result.run).toMatchObject({ state: 'queued', computer: null, startedAt: null,
    message: expect.stringContaining('Update the Worker CI protocol.') })
  expect(result.run.dispatchHostKey).toBeUndefined()
  expect(result.run.dispatchAttempts).toBeUndefined()
  expect(result.run.dispatchRequest).toBeUndefined()
  expect(vi.mocked(f.endpoint.request).mock.calls.filter(([, input]) => input.operation === 'start')).toHaveLength(1)
})

it.each(['lint', 'typecheck'] as const)('dispatches an ordinary queued $suite check without a gate ticket', async suite => {
  const f = dispatchFixture()
  f.records.splice(0, 1)
  f.records[0] = CiRunRecordSchema.parse({ ...f.queued, suite })
  f.keepRunning.add(f.queued.id)
  await dispatchSettled(f.create())
  expect((await f.create().get(caller, { ticketId: f.queued.id })).run).toMatchObject({
    id: f.queued.id, suite, state: 'running', computer: { hostRef: computer.hostRef },
  })
  expect(f.endpoint.request).toHaveBeenCalledWith(computer, expect.objectContaining({
    operation: 'start', runId: f.queued.id, suite,
  }))
})

it('dispatches a queued ticket after settling ordinary output', async () => {
  const f = dispatchFixture()
  f.keepRunning.add(f.queued.id)
  await dispatchSettled(f.create())
  expect((await f.create().get(caller, { ticketId: f.active.id })).run.state).toBe('passed')
  expect((await f.create().get(caller, { ticketId: f.queued.id })).run.state).toBe('running')
  expect(f.endpoint.request).toHaveBeenCalledWith(computer, expect.objectContaining({
    operation: 'start', runId: f.queued.id,
  }))
})

it.each([
  { text: 'finished\0 café 🚀\n', message: 'Done.\0 café 🚀',
    cleanText: 'finished café 🚀\n', cleanMessage: 'Done. café 🚀' },
  { text: 'finished\ud800\n', message: 'Done.\udc00',
    cleanText: 'finished\ufffd\n', cleanMessage: 'Done.\ufffd' },
])('settles invalid log text and dispatches a queued ticket in the same pass: $cleanMessage', async output => {
  const f = dispatchFixture()
  Object.assign(f.output, output)
  f.keepRunning.add(f.queued.id)
  await dispatchSettled(f.create())
  const result = await f.create().get(caller, { ticketId: f.active.id })
  expect(result.run).toMatchObject({ state: 'passed', message: output.cleanMessage })
  expect(result.logTail).toBe(output.cleanText)
  expect((await f.create().get(caller, { ticketId: f.queued.id })).run.state).toBe('running')
  expect(f.endpoint.request).toHaveBeenCalledWith(computer, expect.objectContaining({
    operation: 'start', runId: f.queued.id,
  }))
})

it('continues refreshing later batches and dispatching after one settlement write fails', async () => {
  const f = dispatchFixture(new Error('Settlement storage unavailable'))
  const later = Array.from({ length: 8 }, (_, index) => CiRunRecordSchema.parse({ ...f.active,
    id: `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
  }))
  f.records.push(...later)
  await dispatchSettled(f.create())
  expect((await f.create().get(caller, { ticketId: f.active.id })).run.state).toBe('running')
  for (const run of later) {
    expect((await f.create().get(caller, { ticketId: run.id })).run.state).toBe('passed')
  }
  expect((await f.create().get(caller, { ticketId: f.queued.id })).run.state).toBe('running')
})

it('persists sanitized dispatch errors on queued tickets', async () => {
  const f = dispatchFixture()
  const request = vi.mocked(f.endpoint.request).getMockImplementation()!
  vi.mocked(f.endpoint.request).mockImplementation(async (computer, input) => {
    if (input.operation === 'start') throw new DomainError('BUILD_COMPUTER_DISABLED', 'Executor\0 unavailable\ud800', 409)
    return request(computer, input)
  })
  const service = f.create()
  await dispatchSettled(service)
  const result = await service.get(caller, { ticketId: f.queued.id })
  expect(result.run).toMatchObject({ state: 'queued',
    message: 'No ready computer for lint; Builder: Executor unavailable\ufffd' })
})

it('keeps assigned running ticket ids visible when the computer is offline', async () => {
  const f = fixture()
  expect(await f.create().computers(caller, { workspaceId: 'workspace' })).toMatchObject({ computers: [{
    ready: false, reasons: ['Build computer unavailable'], running: [f.read().record.id],
  }] })
})

it('reads every computer status concurrently when listing computers', async () => {
  const f = fixture()
  const fleet = Array.from({ length: 3 }, (_, index) => ({ ...computer, key: `host-${index}`, label: `Host ${index}` }))
  vi.mocked(f.endpoint.computers).mockResolvedValue(fleet)
  let pending = 0
  let release!: () => void
  const allAsked = new Promise<void>(resolve => { release = resolve })
  vi.mocked(f.endpoint.request).mockImplementation(async (_target, input) => {
    if (input.operation !== 'status') throw new Error('Unexpected request')
    // Each status reply waits until every computer was asked: a one-by-one listing never completes.
    if (++pending === fleet.length) release()
    await allAsked
    return { operation: 'status', ready: true, reasons: [], cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [], slotsTotal: 2, slotsUsed: 0 }
  })
  const listing = f.create().computers(caller, { workspaceId: 'workspace' })
  await expect.poll(() => pending, { timeout: 1000 }).toBe(fleet.length)
  const listed = await listing
  expect(listed.computers.map(value => value?.label)).toEqual(['Host 0', 'Host 1', 'Host 2'])
})

it('reuses fresh computer statuses across repeated computer listings', async () => {
  const f = fixture()
  vi.mocked(f.endpoint.request).mockImplementation(async (_target, input) => {
    if (input.operation !== 'status') throw new Error('Unexpected request')
    return { operation: 'status', ready: true, reasons: [], cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [], slotsTotal: 2, slotsUsed: 0 }
  })
  const ci = f.create()
  await ci.computers(caller, { workspaceId: 'workspace' })
  expect((await ci.computers(caller, { workspaceId: 'workspace' })).computers).toMatchObject([{ label: 'Builder', ready: true }])
  expect(vi.mocked(f.endpoint.request).mock.calls.filter(([, input]) => input.operation === 'status')).toHaveLength(1)
})

it('refreshes submitted CI in the background without status reads and stops on close', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const ci = f.create()
  vi.spyOn(f.commands, 'execute').mockResolvedValue({ value: { ticketId: f.read().record.id }, replayed: false })
  let finished = false
  vi.mocked(f.endpoint.request).mockImplementation(async (_computer, request) => {
    if (request.operation !== 'read') throw new Error('Unexpected request')
    const record = f.read().record
    const run: CiHostRun = {
      runId: record.id, state: finished ? 'failed' : 'running', step: 'lint',
      exitCode: finished ? 1 : null, startedAt: record.startedAt!,
      finishedAt: finished ? new Date().toISOString() : null, logBytes: 0, message: null,
    }
    return { operation: 'read', run, text: '', nextOffset: 0 }
  })
  try {
    await ci.run(caller, { workspaceId: 'workspace', suite: 'lint', commandId: 'background' })
    await ci.dispatch()
    expect(f.read().record.state).toBe('running')
    finished = true
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.read().record.state).toBe('failed')
    vi.mocked(f.endpoint.request).mockClear()
    expect((await ci.get(caller, { workspaceId: 'workspace', ticketId: f.read().record.id })).run.state).toBe('failed')
    expect(f.endpoint.request).not.toHaveBeenCalled()
    await ci.close()
    vi.mocked(f.endpoint.computers).mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.endpoint.computers).not.toHaveBeenCalled()
  } finally {
    await ci.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

it.each(['lint', 'integration'] as const)('returns contract-valid persisted %s status for an unshared group', async suite => {
  const f = fixture(suite)
  const result = CiGetOutputSchema.parse(await f.create().get(caller, { ticketId: f.read().record.id }))
  expect(result.run).toEqual(f.read().record)
  expect(result.sharing).toBeUndefined()
  expect(result.logTail).toBe('persisted log\n')
  expect(f.endpoint.request).not.toHaveBeenCalled()
})

it.each(['lint', 'integration'] as const)('serves authenticated MCP %s polling from persisted data while fleet dispatch is blocked', async suite => {
  const f = fixture(suite)
  const ci = f.create()
  let unblock!: () => void
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  vi.mocked(f.endpoint.computers).mockImplementation(async () => {
    await blocked
    return []
  })
  const dispatch = ci.dispatch()
  const access = new PostgresAccessService(f.pool)
  const authenticate = vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token === 'reader') return caller
    if (token === 'denied') return { ...caller, id: 'denied', grants: [] }
    throw new DomainError('AUTH_INVALID', 'Invalid token.', 401)
  })
  const recordDenied = vi.fn(async () => undefined)
  const app = Fastify()
  registerGraphqlMcp(app, { access, operator: { ci, commands: { recordDenied } } as unknown as OperatorServices })
  const poll = (token: string) => app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'ci_get', arguments: { workspaceId: 'workspace', ticketId: f.read().record.id } } },
  })
  try {
    const response = await poll('reader')
    expect(response.statusCode).toBe(200)
    const message = JSON.parse(response.body.split('\n').find(line => line.startsWith('data: '))!.slice(6))
    expect(message.result, JSON.stringify(message.result)).not.toMatchObject({ isError: true })
    const result = CiGetOutputSchema.parse(decodeMcpToolResult(message.result))
    expect(result.run).toEqual(f.read().record)
    expect(result.logTail).toBe('persisted log\n')
    expect(f.endpoint.request).not.toHaveBeenCalled()
    const denied = await poll('denied')
    expect(denied.body).toContain('ACCESS_DENIED')
    expect(recordDenied).toHaveBeenCalledWith('denied', 'mcp', 'ci_get', 'mcp:ci_get')
    expect(authenticate).toHaveBeenCalledWith('reader', ['operator'])
  } finally {
    unblock()
    await dispatch
    await app.close()
    vi.restoreAllMocks()
  }
})

it.each([10, 40_000, 70_000])('persists a bounded %i-byte log with terminal status across service restart', async length => {
  const f = fixture()
  const log = 'x'.repeat(length) + '\nfinished\n'
  const state: CiHostRun = {
    runId: f.read().record.id, state: 'passed', step: 'lint', exitCode: 0,
    startedAt: '2026-10-12T00:00:01.000Z', finishedAt: '2026-10-12T00:01:00.000Z',
    logBytes: Buffer.byteLength(log), message: null,
  }
  vi.mocked(f.endpoint.request).mockImplementation(async (_computer, request) => {
    if (request.operation !== 'read') throw new Error('Unexpected request')
    const text = log.slice(request.afterOffset, request.afterOffset + request.maxBytes)
    return { operation: 'read', run: state, text, nextOffset: request.afterOffset + text.length }
  })
  await dispatchSettled(f.create())
  vi.mocked(f.endpoint.request).mockClear()
  const result = await f.create().get(caller, { workspaceId: 'workspace', ticketId: state.runId })
  expect(result.run.state).toBe('passed')
  expect(result.logTail).toBe(log.slice(-32_768))
  expect(f.endpoint.request).not.toHaveBeenCalled()
  const page = await f.create().logs(caller, {
    workspaceId: 'workspace', ticketId: state.runId, afterOffset: 0, maxBytes: 500_000,
  })
  expect(page).toEqual({ text: log.slice(0, 65_536), maxBytes: 65_536,
    nextOffset: Math.min(log.length, 65_536), logBytes: log.length })
  expect(f.endpoint.request).toHaveBeenCalledWith(expect.anything(), {
    operation: 'read', runId: state.runId, afterOffset: 0, maxBytes: 65_536,
  })
})

it.each(['get', 'logs', 'group logs'] as const)(
  'lets workers read workspace CI %s from another execution and denies callers without a grant', async operation => {
    const f = fixture()
    const worker: ManagementPrincipal = { ...caller, audience: 'worker', agentId: 'agent' }
    f.resolve.mockResolvedValueOnce({
      principal: worker, workspaceId: 'workspace', executionId: 'another-execution',
    })
    const record = f.read().record
    const text = 'workspace log\n'
    vi.mocked(f.endpoint.request).mockImplementation(async (_computer, request) => {
      if (request.operation !== 'read') throw new Error('Unexpected request')
      return { operation: 'read', run: {
        runId: record.id, state: 'running', step: record.step, exitCode: null,
        startedAt: record.startedAt!, finishedAt: null, logBytes: Buffer.byteLength(text), message: null,
      }, text, nextOffset: Buffer.byteLength(text) }
    })
    const ci = f.create()
    const read = (principal: ManagementPrincipal) => operation === 'get'
      ? ci.get(principal, { ticketId: record.id })
      : ci.logs(principal, { ticketId: record.id, afterOffset: 0, group: operation === 'group logs' })
    const result = await read(worker)
    if (operation === 'get') {
      expect(result).toMatchObject({ run: record, logTail: 'persisted log\n',
        group: { groupId: record.groupId, state: 'running' } })
      expect(f.endpoint.computers).not.toHaveBeenCalled()
      expect(f.endpoint.request).not.toHaveBeenCalled()
    } else {
      expect(result).toMatchObject({ text, nextOffset: Buffer.byteLength(text) })
      if (operation === 'group logs') expect(result).toMatchObject({ parts: [{ run: record, text }] })
    }
    expect(f.resolve).toHaveBeenCalledWith(worker, undefined, CI_GET_ACTIONS)
    vi.mocked(f.pool.query).mockClear()
    vi.mocked(f.endpoint.computers).mockClear()
    vi.mocked(f.endpoint.request).mockClear()
    await expect(read({ ...worker, grants: [] })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(f.pool.query).not.toHaveBeenCalled()
    expect(f.endpoint.computers).not.toHaveBeenCalled()
    expect(f.endpoint.request).not.toHaveBeenCalled()
  })

it('retries a CI read once after a statement timeout, then reports a retryable error', async () => {
  const f = fixture()
  const canceled = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
  f.resolve.mockRejectedValueOnce(canceled())
  expect(await f.create().get(caller, { ticketId: f.read().record.id })).toMatchObject({ run: { id: f.read().record.id } })
  f.resolve.mockRejectedValueOnce(canceled()).mockRejectedValueOnce(canceled())
  await expect(f.create().get(caller, { ticketId: f.read().record.id })).rejects.toMatchObject({
    code: 'DATABASE_READ_TIMEOUT', status: 503, details: { retryable: true, sqlState: '57014' } })
})

it('retries an unknown start reply on the assigned executor without requeueing', async () => {
  const f = dispatchFixture()
  f.records.splice(0, 1)
  f.keepRunning.add(f.queued.id)
  const request = vi.mocked(f.endpoint.request).getMockImplementation()!
  const starts: { computer: HostCiComputer; runId: string }[] = []
  const retryEntered = deferred()
  const acknowledge = deferred()
  vi.mocked(f.endpoint.request).mockImplementation(async (computer, input) => {
    if (input.operation === 'start') {
      starts.push({ computer, runId: input.runId })
      if (starts.length === 1) throw new Error('Start reply lost')
      retryEntered.resolve()
      await acknowledge.promise
    }
    return request(computer, input)
  })
  const service = f.create()
  const dispatching = service.dispatch()
  try {
    await retryEntered.promise
    expect((await service.get(caller, { ticketId: f.queued.id })).run).toMatchObject({
      state: 'starting', computer: { hostRef: computer.hostRef },
      dispatchRequest: { operation: 'start', runId: f.queued.id },
    })
  } finally {
    acknowledge.resolve()
    await dispatching
    await service.drain()
  }
  expect((await service.get(caller, { ticketId: f.queued.id })).run).toMatchObject({
    state: 'running', computer: { hostRef: computer.hostRef },
  })
  expect(starts).toEqual([
    { computer, runId: f.queued.id }, { computer, runId: f.queued.id },
  ])
})


it('retries an unacknowledged gate on its assigned computer without releasing ownership', async () => {
  const f = dispatchFixture()
  f.records.splice(0, 1)
  f.keepRunning.add(f.queued.id)
  f.records[0] = CiRunRecordSchema.parse({ ...f.queued, suite: 'integration', gate: true,
    plannedHostKey: computer.key, integrationShards: 8, requiresBuildComputer: false,
    files: ['apps/api/test/workflow.integration.test.ts'] })
  const request = vi.mocked(f.endpoint.request).getMockImplementation()!
  const starts: { hostKey: string; runId: string }[] = []
  const retryEntered = deferred()
  const acknowledge = deferred()
  vi.mocked(f.endpoint.request).mockImplementation(async (target, input) => {
    if (input.operation === 'start') {
      starts.push({ hostKey: target.key, runId: input.runId })
      if (starts.length === 1) throw new Error('Start reply lost during reconnect')
      retryEntered.resolve()
      await acknowledge.promise
    }
    return request(target, input)
  })
  const service = f.create()
  const dispatching = service.dispatch()
  try {
    await retryEntered.promise
    expect((await service.get(caller, { ticketId: f.queued.id })).run)
      .toMatchObject({ state: 'starting', startedAt: null, step: 'dispatch' })
  } finally {
    acknowledge.resolve()
    await dispatching
    await service.drain()
  }

  await f.create().computers(caller, { workspaceId: 'workspace' })
  expect((await f.create().get(caller, { ticketId: f.queued.id })).run)
    .toMatchObject({ state: 'running', computer: { hostRef: computer.hostRef } })
  vi.mocked(f.endpoint.computers).mockResolvedValue([computer, {
    key: 'device:replacement', hostRef: { kind: 'device', mainId: 'main', deviceId: 'replacement' },
    label: 'Replacement builder', priority: 100,
  }])
  f.keepRunning.delete(f.queued.id)
  await dispatchSettled(f.create())
  expect((await f.create().get(caller, { ticketId: f.queued.id })).run).toMatchObject({
    state: 'passed', exitCode: 0, computer: { hostRef: computer.hostRef },
  })
  expect(f.endpoint.request).toHaveBeenCalledWith(computer,
    expect.objectContaining({ operation: 'read', runId: f.queued.id }), { priority: 'background' })
  expect(starts).toEqual([
    { hostKey: computer.key, runId: f.queued.id }, { hostKey: computer.key, runId: f.queued.id },
  ])
})

it('retains ownership after bounded missing start acknowledgements across service restarts', async () => {
  const f = dispatchFixture()
  f.records.splice(0, 1)
  const request = vi.mocked(f.endpoint.request).getMockImplementation()!
  let starts = 0
  vi.mocked(f.endpoint.request).mockImplementation(async (target, input) => {
    if (input.operation === 'start') {
      starts++
      throw new Error('Start delivery lost')
    }
    return request(target, input)
  })
  for (let attempt = 0; attempt < 4; attempt++) await dispatchSettled(f.create())
  expect(starts).toBe(3)
  expect((await f.create().get(caller, { ticketId: f.queued.id })).run).toMatchObject({
    state: 'starting', computer: { hostRef: computer.hostRef },
    dispatchRequest: { runId: f.queued.id },
    message: expect.stringContaining('cancellation is required'), finishedAt: null,
  })
})

it('bounds a hanging start and retains its assignment while status is unavailable', async () => {
  vi.useFakeTimers()
  const f = dispatchFixture()
  f.records.splice(0, 1)
  f.keepRunning.add(f.queued.id)
  const request = vi.mocked(f.endpoint.request).getMockImplementation()!
  let acknowledge!: () => void
  const delayed = new Promise<void>(resolve => { acknowledge = resolve })
  let starts = 0
  vi.mocked(f.endpoint.request).mockImplementation(async (target, input) => {
    if (input.operation === 'start' && ++starts === 1) await delayed
    return request(target, input)
  })
  const service = f.create()
  try {
    const settled = vi.fn()
    const dispatch = service.dispatch().then(settled)
    await vi.advanceTimersByTimeAsync(120_001)
    expect(settled).toHaveBeenCalledOnce()
    await dispatch
    vi.mocked(f.endpoint.request).mockRejectedValue(new Error('Computer offline'))
    await service.computers(caller, { workspaceId: 'workspace' })
    expect((await service.get(caller, { ticketId: f.queued.id })).run)
      .toMatchObject({ state: 'starting', computer: { hostRef: computer.hostRef }, startedAt: null,
        dispatchRequest: { runId: f.queued.id } })
    acknowledge()
    await vi.advanceTimersByTimeAsync(0)
    expect((await service.get(caller, { ticketId: f.queued.id })).run.state).toBe('starting')
    vi.mocked(f.endpoint.request).mockImplementation(request)
    await dispatchSettled(service)
    expect((await service.get(caller, { ticketId: f.queued.id })).run.state).toBe('running')
  } finally {
    acknowledge()
    await service.close()
    vi.useRealTimers()
  }
})

it('accepts computer status as acknowledgement without sending a duplicate start', async () => {
  const f = dispatchFixture()
  f.records.splice(0, 1)
  f.keepRunning.add(f.queued.id)
  const request = vi.mocked(f.endpoint.request).getMockImplementation()!
  let known = false
  let starts = 0
  vi.mocked(f.endpoint.request).mockImplementation(async (target, input) => {
    if (input.operation === 'start') {
      starts++
      known = true
      throw new Error('Start reply lost')
    }
    if (input.operation === 'status' && known) {
      return { operation: 'status', ready: true, reasons: [], cpuCount: 8, memoryBytes: 16 * 2 ** 30,
        slotsUsed: 1, slotsTotal: 2, runs: [{ runId: f.queued.id, state: 'running', step: 'lint',
          startedAt: f.active.startedAt!, finishedAt: null, exitCode: null, logBytes: 0, message: null }] }
    }
    return request(target, input)
  })
  await dispatchSettled(f.create())
  await f.create().computers(caller, { workspaceId: 'workspace' })
  expect((await f.create().get(caller, { ticketId: f.queued.id })).run).toMatchObject({ state: 'running' })
  expect(starts).toBe(1)
})
