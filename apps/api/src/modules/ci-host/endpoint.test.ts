import { setImmediate as nextTurn } from 'node:timers/promises'
import type pg from 'pg'
import { CI_HOST_NAMESPACE, CiHostRequestSchema, CiRunRecordSchema, type CiHostRequest } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { DeviceApplicationAdmissionError } from '../devices/deviceApplicationError.js'
import { ProductionHostCiEndpoint } from './endpoint.js'
import { rejectedCiStart } from './dispatch.js'
import { reconcileCiHostStart } from './dispatchRecovery.js'
import { CiPlanningSnapshot } from './planningSnapshot.js'
import type { HostCiComputer } from './service.js'
import { CloudCi } from './cloud.js'
import { CircleCiProvider, cloudCiId } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'

it('routes an organization through its saved CircleCI login, with absent identity remaining primary', async () => {
  const calls: string[] = []
  const ports = (id: string): HostCiPorts => ({ now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30,
    run: async () => { calls.push(id); return { code: 0, stdout: '', stderr: '' } } })
  const clouds = ['default', 'reserve'].map(id => new CloudCi('fixture-main',
    new CircleCiProvider(ports(id), { circleToken: async () => null },
      { owner: 'alpha', circleAccountId: id, mirrorNames: new Set(['site-ci']) }),
    async () => 'alpha/site-ci'))
  const endpoint = new ProductionHostCiEndpoint({ query: async () => ({ rows: [] }) } as unknown as pg.Pool,
    'fixture-main', () => undefined, { handle: async () => { throw new Error('Unexpected local request') } }, clouds)
  const primary = clouds[0]!.computers()[0]!
  const reserve = clouds[1]!.computers()[0]!
  expect(cloudCiId(clouds[0]!.provider)).toBe('circleci@alpha')
  expect(reserve.key).toBe('fixture-main:cloud:circleci~reserve@alpha:0')
  await endpoint.request(reserve, { operation: 'status' })
  expect(calls).toEqual(['reserve'])
  await endpoint.request(primary, { operation: 'status' })
  expect(calls).toEqual(['reserve', 'default'])
})

it.each([undefined, 1, 2, 3])('derives Worker readiness from start protocol %s', async version => {
  const computer: HostCiComputer = { key: 'fixture:worker',
    hostRef: { kind: 'device', mainId: 'fixture-main', deviceId: 'fixture-worker' }, label: 'Fixture Worker', priority: 50 }
  const status = { operation: 'status', ready: true, reasons: [], cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [],
    ...(version !== undefined ? { startProtocolVersion: version } : {}) }
  const endpoint = new ProductionHostCiEndpoint({} as pg.Pool, 'fixture-main', () => ({
    capabilities: () => [], request: async () => ({ payload: status }),
  }), { handle: async () => { throw new Error('Local runner must not be used.') } })
  const result = await endpoint.request(computer, { operation: 'status' })
  expect(result).toMatchObject({ operation: 'status', ready: version === 3 })
  if (version !== 3) expect(result).toMatchObject({ reasons: [expect.stringMatching(/CI start protocol.*update/i)] })
})

it('lists computers without waiting for a slow cloud recovery sweep', async () => {
  const cloud = { provider: { id: 'circleci' }, reconcile: () => new Promise<void>(() => {}),
    computers: () => [{ key: 'fixture:cloud:0', hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'circleci', slot: 0 },
      label: 'Cloud 1', priority: 30 }] }
  const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool
  const endpoint = new ProductionHostCiEndpoint(pool, 'fixture-main', () => undefined,
    { handle: async () => { throw new Error('Local runner must not be used.') } }, [cloud as never])
  const listed = await Promise.race([endpoint.computers(),
    new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 1000))])
  expect(listed).toEqual(cloud.computers())
})

it('answers a status request without waiting for a slow directory retention sweep', async () => {
  const computer: HostCiComputer = { key: 'fixture:main', hostRef: { kind: 'main', mainId: 'fixture-main' },
    label: 'Main computer', priority: 60 }
  const status = { operation: 'status' as const, ready: true, reasons: [], cpuCount: 8, memoryBytes: 16 * 2 ** 30,
    runs: [], startProtocolVersion: 3, cleanupSupported: true }
  const sweeping = deferred()
  const release = deferred()
  const completed = deferred()
  const cleanupRequests: CiHostRequest[] = []
  const runId = '00000000-0000-4000-8000-000000000001'
  const pool = { query: async () => {
    return { rows: [{ run_id: runId, state: 'passed', finished_at: '2026-01-01T00:00:00Z',
      collection: null, rank: '500' }] }
  } } as unknown as pg.Pool
  const endpoint = new ProductionHostCiEndpoint(pool, 'fixture-main', () => undefined, {
    handle: async payload => {
      const request = CiHostRequestSchema.parse(payload)
      if (request.operation === 'status' && request.cleanupRunIds) {
        cleanupRequests.push(request)
        sweeping.resolve()
        await release.promise
        completed.resolve()
        return { ...status, removedRunIds: request.cleanupRunIds }
      }
      return status
    },
  })
  const pending = endpoint.request(computer, { operation: 'status' })
  await sweeping.promise
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([pending,
      new Promise<'blocked'>(resolve => { timeout = setTimeout(() => resolve('blocked'), 1000) })])
    expect(result).toMatchObject({ operation: 'status', ready: true })
    const second = await endpoint.request(computer, { operation: 'status' })
    expect(second).toMatchObject({ operation: 'status', ready: true })
    expect(cleanupRequests).toHaveLength(1)
    expect(cleanupRequests).toEqual([{ operation: 'status', cleanupRunIds: [runId], buildAllowancePercent: 100 }])
  } finally {
    clearTimeout(timeout)
    release.resolve()
    await pending
    await completed.promise
  }
})

it('keeps yielded readiness in the planning snapshot without substituting a live run observation', async () => {
  const computer: HostCiComputer = { key: 'fixture:busy-worker',
    hostRef: { kind: 'device', mainId: 'fixture-main', deviceId: 'fixture-busy-worker' }, label: 'Busy Worker', priority: 50 }
  const status = { operation: 'status', ready: true, reasons: [], cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [],
    startProtocolVersion: 3 }
  let answered = false
  const endpoint = new ProductionHostCiEndpoint({} as pg.Pool, 'fixture-main', () => ({
    capabilities: () => [],
    request: async () => {
      if (answered) throw new DeviceApplicationAdmissionError('background_yield')
      answered = true
      return { payload: status }
    },
  }), { handle: async () => { throw new Error('Local runner must not be used.') } })
  const planning = new CiPlanningSnapshot(endpoint)
  expect(await planning.request(computer, { operation: 'status' })).toMatchObject({ ready: true })
  await expect(endpoint.request(computer, { operation: 'status' }))
    .rejects.toMatchObject({ reason: 'background_yield' })
  expect(await planning.request(computer, { operation: 'status' })).toMatchObject({ ready: true })
  planning.invalidate(computer)
  await expect(planning.request(computer, { operation: 'status' }))
    .rejects.toMatchObject({ reason: 'background_yield' })
})

it.each([{ cleanupRunIds: [] }, { cleanupRunIds: ['00000000-0000-4000-8000-000000000002'] }])(
  'does not reuse cleanup acknowledgments when a cleanup request for $cleanupRunIds yields', async ({ cleanupRunIds }) => {
    const computer: HostCiComputer = { key: 'fixture:cleanup-worker',
      hostRef: { kind: 'device', mainId: 'fixture-main', deviceId: 'fixture-cleanup-worker' },
      label: 'Cleanup Worker', priority: 50 }
    const removedRunIds = ['00000000-0000-4000-8000-000000000001']
    const status = { operation: 'status', ready: true, reasons: [], cpuCount: 8,
      memoryBytes: 16 * 2 ** 30, runs: [], startProtocolVersion: 3 }
    const request = vi.fn().mockResolvedValueOnce({ payload: { ...status, removedRunIds } })
      .mockRejectedValueOnce(new DeviceApplicationAdmissionError('background_yield'))
      .mockResolvedValueOnce({ payload: { ...status, removedRunIds: cleanupRunIds } })
    const endpoint = new ProductionHostCiEndpoint({} as pg.Pool, 'fixture-main', () => ({
      capabilities: () => [], request,
    }), { handle: async () => { throw new Error('Local runner must not be used.') } })
    expect(await endpoint.request(computer, { operation: 'status', cleanupRunIds: removedRunIds }))
      .toMatchObject({ removedRunIds })
    await expect(endpoint.request(computer, { operation: 'status', cleanupRunIds }))
      .rejects.toMatchObject({ reason: 'background_yield' })
    expect(await endpoint.request(computer, { operation: 'status', cleanupRunIds }))
      .toMatchObject({ removedRunIds: cleanupRunIds })
    expect(request).toHaveBeenCalledTimes(3)
  },
)

it('does not report readiness for a Worker that never answered when its status read yields', async () => {
  const computer: HostCiComputer = { key: 'fixture:silent-worker',
    hostRef: { kind: 'device', mainId: 'fixture-main', deviceId: 'fixture-silent-worker' }, label: 'Silent Worker', priority: 50 }
  const endpoint = new ProductionHostCiEndpoint({} as pg.Pool, 'fixture-main', () => ({
    capabilities: () => [], request: async () => { throw new DeviceApplicationAdmissionError('background_yield') },
  }), { handle: async () => { throw new Error('Local runner must not be used.') } })
  await expect(endpoint.request(computer, { operation: 'status' })).rejects.toBeInstanceOf(DeviceApplicationAdmissionError)
})

it('spends a start retry only after a live status reports the assigned run absent', async () => {
  const computer: HostCiComputer = { key: 'fixture:recovering-worker',
    hostRef: { kind: 'device', mainId: 'fixture-main', deviceId: 'fixture-recovering-worker' },
    label: 'Recovering Worker', priority: 50 }
  const status = { operation: 'status' as const, ready: true, reasons: [], cpuCount: 8,
    memoryBytes: 16 * 2 ** 30, runs: [], startProtocolVersion: 3 }
  const request = vi.fn().mockResolvedValue({ payload: status })
  const endpoint = new ProductionHostCiEndpoint({} as pg.Pool, 'fixture-main', () => ({
    capabilities: () => [], request,
  }), { handle: async () => { throw new Error('Local runner must not be used.') } })
  await endpoint.request(computer, { operation: 'status' })
  let run = CiRunRecordSchema.parse({
    id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace',
    groupId: '22222222-2222-4222-8222-222222222222', suite: 'lint', part: null,
    scope: 'full', files: [], partition: null, repository: 'owner/repo', commit: 'a'.repeat(40),
    state: 'starting', computer: { hostRef: computer.hostRef, label: computer.label }, step: 'dispatch',
    exitCode: null, message: null, queuedAt: new Date().toISOString(),
    startedAt: null, finishedAt: null, dispatchAttempts: 1,
    dispatchRequest: { operation: 'start', runId: '11111111-1111-4111-8111-111111111111',
      repository: 'owner/repo', commit: 'a'.repeat(40), suite: 'lint' },
    initiator: { principalId: 'worker', executionId: 'execution' },
  })
  const query = async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith('update ci_runs')) run = CiRunRecordSchema.parse(JSON.parse(parameters![3] as string))
    return { rows: [], rowCount: 1 }
  }
  const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as pg.Pool
  const retry = vi.fn(async () => { throw new Error('Start delivery lost') })
  const services = { pool, endpoint: { computers: async () => [computer], request: retry },
    read: async () => run, settle: vi.fn(async () => true) }
  request.mockRejectedValue(new DeviceApplicationAdmissionError('background_yield'))
  for (let poll = 0; poll < 4; poll++) {
    const reply = await endpoint.request(computer, { operation: 'status' }).catch(error => {
      if (error instanceof DeviceApplicationAdmissionError && error.reason === 'background_yield') return null
      throw error
    })
    await reconcileCiHostStart(services, run, computer, reply?.operation === 'status' ? reply : null)
  }
  expect(run).toMatchObject({ state: 'starting', dispatchAttempts: 1 })
  expect(retry).not.toHaveBeenCalled()
  request.mockResolvedValue({ payload: status })
  const reply = await endpoint.request(computer, { operation: 'status' })
  await reconcileCiHostStart(services, run, computer, reply.operation === 'status' ? reply : null)
  expect(run).toMatchObject({ state: 'starting', dispatchAttempts: 2 })
  expect(retry).toHaveBeenCalledExactlyOnceWith(computer, run.dispatchRequest)
})


it('classifies a failure before Start delivery as a refusal and preserves ambiguous Start errors', async () => {
  const computer: HostCiComputer = { key: 'fixture:main', hostRef: { kind: 'main', mainId: 'fixture-main' },
    label: 'Main computer', priority: 60 }
  const failure = new Error('Computer preferences unavailable')
  const query = vi.fn().mockRejectedValueOnce(failure)
  const handle = vi.fn().mockRejectedValue(failure)
  const endpoint = new ProductionHostCiEndpoint({ query } as unknown as pg.Pool, 'fixture-main',
    () => undefined, { handle })
  const request = CiHostRequestSchema.parse({ operation: 'start',
    runId: '11111111-1111-4111-8111-111111111111', repository: 'example/project',
    commit: 'a'.repeat(40), suite: 'unit' })
  const refusal = await endpoint.request(computer, request).catch(error => error)
  expect(rejectedCiStart(refusal)).toBe(true)
  expect(refusal).toMatchObject({ cause: failure })
  expect(handle).not.toHaveBeenCalled()
  expect(rejectedCiStart(failure)).toBe(false)
})

it('fetches another retention page after sending the first and keeps the five-minute sweep floor', async () => {
  const computer: HostCiComputer = { key: 'fixture:main', hostRef: { kind: 'main', mainId: 'fixture-main' },
    label: 'Main computer', priority: 60 }
  const rows = Array.from({ length: 1001 }, (_, index) => ({
    run_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    state: 'passed', finished_at: '2026-01-01T00:00:00Z', collection: null, rank: String(index + 201),
  }))
  const pages = [rows.slice(0, 1000).map(row => row.run_id), rows.slice(1000).map(row => row.run_id)]
  const requests: string[][] = []
  const expiredLogPages: string[][] = []
  const readPage = vi.fn(async (parameters: unknown[]) => {
    const limit = parameters[3] as number | undefined
    const offset = parameters[4] as number | undefined ?? 0
    if (offset > 0) expect(requests.at(-1)).toEqual(pages[0])
    return { rows: rows.slice(offset, limit === undefined ? undefined : offset + limit) }
  })
  const query = async (_sql: string, parameters: unknown[]) => {
    if (Array.isArray(parameters[0])) {
      expiredLogPages.push([...parameters[0]] as string[])
      return { rows: [], rowCount: parameters[0].length }
    }
    return readPage(parameters)
  }
  const status = { operation: 'status' as const, ready: true, reasons: [], cpuCount: 8,
    memoryBytes: 16 * 2 ** 30, runs: [], cleanupSupported: true }
  const endpoint = new ProductionHostCiEndpoint({ query } as unknown as pg.Pool, 'fixture-main', () => undefined, {
    handle: async payload => {
      const request = CiHostRequestSchema.parse(payload)
      if (request.operation === 'status' && request.cleanupRunIds) {
        requests.push([...request.cleanupRunIds])
        return { ...status, removedRunIds: request.cleanupRunIds }
      }
      return status
    },
  })
  const startedAt = Date.parse('2026-10-17T12:00:00Z')
  const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
  try {
    await endpoint.request(computer, { operation: 'status' })
    await expect.poll(() => requests.length).toBe(2)
    // Let the background sweep settle before advancing the clock.
    await nextTurn()
    expect(requests).toEqual(pages)
    expect(readPage).toHaveBeenCalledTimes(2)
    expect(expiredLogPages).toEqual(pages)
    await endpoint.request(computer, { operation: 'status' })
    await nextTurn()
    expect(readPage).toHaveBeenCalledTimes(2)
    expect(requests).toEqual(pages)
    expect(expiredLogPages).toEqual(pages)
    now.mockReturnValue(startedAt + 5 * 60_000 - 1)
    await endpoint.request(computer, { operation: 'status' })
    await nextTurn()
    expect(readPage).toHaveBeenCalledTimes(2)
    expect(requests).toEqual(pages)
    expect(expiredLogPages).toEqual(pages)
    now.mockReturnValue(startedAt + 5 * 60_000)
    await endpoint.request(computer, { operation: 'status' })
    await expect.poll(() => requests.length).toBe(4)
    await nextTurn()
    expect(readPage).toHaveBeenCalledTimes(4)
    expect(requests).toEqual([...pages, ...pages])
    expect(expiredLogPages).toEqual([...pages, ...pages])
  } finally { now.mockRestore() }
})

function remoteExecutionFixture(enabled?: boolean) {
  const mainId = '11111111-1111-4111-8111-111111111111'
  const registration = { mainId, deviceId: '22222222-2222-4222-8222-222222222222',
    workerInstallationId: '33333333-3333-4333-8333-333333333333', status: 'paired',
    keyRevision: 1, authorizationRevision: 1, scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'a'.repeat(64) }
  const target = { hostRef: { kind: 'device' as const, mainId, deviceId: registration.deviceId },
    applicationInstallationId: registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
  const row = { host_key: 'fixture:worker', target, build_enabled: true, build_priority: 50, build_allowance_percent: 75 }
  const pool = { query: async (sql: string) => {
    if (sql.includes('from application_installation')) return { rows: [{ id: mainId }] }
    if (sql.includes('from device_registrations')) return { rows: [{ record: registration }] }
    return { rows: [row] }
  } } as unknown as pg.Pool
  const policy = new WorkerExecutionPolicy({ enabled: enabled ?? true, managedBy: 'startup' })
  const status = { operation: 'status' as const, ready: true, reasons: [], cpuCount: 8,
    memoryBytes: 16 * 2 ** 30, runs: [], startProtocolVersion: 3 }
  const request = vi.fn(async (_device: string, _namespace: string, payload: CiHostRequest) => ({ payload:
    payload.operation === 'cancel' ? { operation: 'cancel', runId: payload.runId, cancelled: true } : status }))
  const devices = { capabilities: () => [{ namespace: CI_HOST_NAMESPACE, mainCanRequest: true }], request }
  const endpoint = new ProductionHostCiEndpoint(pool, mainId, () => devices,
    { handle: async () => status }, [], undefined, enabled === undefined ? undefined : policy)
  const computer: HostCiComputer = { key: row.host_key, hostRef: target.hostRef, label: 'Worker', priority: 50 }
  const start = CiHostRequestSchema.parse({ operation: 'start', runId: '44444444-4444-4444-8444-444444444444',
    repository: 'example/project', commit: 'a'.repeat(40), suite: 'unit' })
  return { endpoint, policy, request, computer, start, status }
}

it('excludes Workers from selection and refuses new starts while remote execution is disabled', async () => {
  const f = remoteExecutionFixture(false)
  expect(await f.endpoint.computers()).toEqual([])
  await expect(f.endpoint.request(f.computer, f.start)).rejects.toMatchObject({
    cause: { code: 'WORKER_EXECUTION_DISABLED' },
  })
  expect(f.request).not.toHaveBeenCalled()
  expect(await f.endpoint.request(f.computer, { operation: 'status' })).toMatchObject({ operation: 'status' })
})

it('rechecks remote execution after a status probe and before delivering Start', async () => {
  const f = remoteExecutionFixture(true)
  f.request.mockImplementation(async () => {
    f.policy.apply({ enabled: false, managedBy: 'startup' })
    return { payload: f.status }
  })
  await expect(f.endpoint.request(f.computer, f.start)).rejects.toMatchObject({
    cause: { code: 'WORKER_EXECUTION_DISABLED' },
  })
  expect(f.request).toHaveBeenCalledTimes(1)
  expect(f.request.mock.calls[0]?.[2].operation).toBe('status')
})

it('requires execution opt-in before selecting paired computers', async () => {
  const f = remoteExecutionFixture()
  expect(await f.endpoint.computers()).toEqual([])
})
