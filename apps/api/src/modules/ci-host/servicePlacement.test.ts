import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { CiHostRequestSchema, CiRunRecordSchema, type CiDurations, type CiHostRequest, type CiRunRecord } from '@foreman-code/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from './service.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { DomainError } from '../errors.js'
import { planIntegrationParts } from './integrationParts.js'
import { readExecutorSpeeds } from './executorSpeed.js'
import { ciExecutionRunId } from './executionAttempt.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const host: HostCiComputer = {
  key: 'main:builder', hostRef: { kind: 'main', mainId: 'main' }, label: 'Builder', priority: 0,
}
const cloud: HostCiComputer = {
  key: 'cloud:circleci', hostRef: { kind: 'cloud', mainId: 'main', provider: 'circleci', slot: 0 },
  label: 'CircleCI', priority: 10,
}

function queuedRuns(count: number) {
  const groupId = randomUUID()
  return Array.from({ length: count }, (_, index) => CiRunRecordSchema.parse({
    id: `${groupId.slice(0, 24)}${String(index).padStart(12, '0')}`,
    workspaceId: 'workspace', groupId, suite: 'integration', part: null,
    scope: 'full', files: [], partition: count > 1 ? { index, count } : null,
    repository: 'owner/repo', ciMirror: 'example/ci-mirror', commit: 'a'.repeat(40),
    state: 'queued', computer: null, step: null,
    exitCode: null, message: null, queuedAt: '2026-10-12T00:00:00.000Z', startedAt: null, finishedAt: null,
    initiator: { principalId: 'operator', executionId: null },
  }))
}

function fleet(records: CiRunRecord[], available: HostCiComputer[],
  unavailable = new Map<string, string>(), occupied = new Set<string>(), slots = new Map<string, number>(),
  options: { cpuCounts?: Map<string, number>; durations?: CiDurations; reservedCloudSlots?: number;
    publishMirror?: HostCiEndpoint['publishMirror'] } = {}) {
  const started: { computer: HostCiComputer; request: CiHostRequest; assigned: CiRunRecord }[] = []
  const pool = { options: { max: 10 }, query: async (sql: string, parameters?: unknown[]) => {
    if (sql.includes('from application_settings')) return { rows: [] }
    if (sql.includes('ci_dispatch_claims')) return { rows: [], rowCount: 1 }
    if (sql.startsWith('select record from ci_runs where id=')) {
      return { rows: records.filter(record => record.id === parameters![0]).map(record => ({ record })) }
    }
    if (sql.startsWith("select id from ci_runs where record->'retainedExecutions'")) {
      const [reservation] = JSON.parse(parameters![0] as string) as { hostKey: string; executor: string }[]
      return { rows: records.filter(record => record.retainedExecutions?.some(attempt =>
        attempt.hostKey === reservation!.hostKey && attempt.executor === reservation!.executor))
        .map(record => ({ id: record.id })) }
    }
    if (sql.startsWith('insert into ci_runs')) {
      records.push(CiRunRecordSchema.parse(JSON.parse(parameters![3] as string)))
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('update ci_runs')) {
      if (parameters?.length === 2) {
        const plans = JSON.parse(parameters[0] as string) as { id: string; patch: Partial<CiRunRecord> }[]
        const rows = plans.map(plan => {
          const index = records.findIndex(item => item.id === plan.id)
          records[index] = CiRunRecordSchema.parse({ ...records[index], ...plan.patch })
          return { record: records[index] }
        })
        return { rows, rowCount: rows.length }
      }
      const record = CiRunRecordSchema.parse(JSON.parse(parameters![3] as string))
      const previous = records.find(item => item.id === record.id)
      if (sql.includes("state='queued'") && (previous?.state !== 'queued'
        || JSON.stringify(previous) !== parameters![4])) return { rows: [], rowCount: 0 }
      records[records.findIndex(item => item.id === record.id)] = record
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('select distinct group_id')) {
      return { rows: records.filter(record => record.gate && ['failed', 'lost'].includes(record.state))
        .map(record => ({ group_id: record.groupId })) }
    }
    if (sql.includes('where group_id=any')) {
      return { rows: records.map(record => ({ record })) }
    }
    if (sql.includes("state='queued'")) {
      return { rows: records.filter(record => record.state === 'queued')
        .map(record => ({ record, durations: options.durations ?? null })) }
    }
    if (sql.includes("'gate'='true'")) {
      return { rows: records.filter(record => record.gate)
        .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt))
        .map(record => ({ record, created_at: new Date(record.queuedAt) })) }
    }
    if (sql.includes("state in ('passed','failed')")) return { rows: [] }
    const active = records.filter(record => ['starting', 'running'].includes(record.state))
      .map(record => ({ id: record.id, record, host_key: available.find(computer =>
        isDeepStrictEqual(computer.hostRef, record.computer?.hostRef))?.key ?? host.key }))
    if (sql.startsWith('select id from ci_runs') && parameters?.length === 4) {
      return { rows: active.filter(row => {
        const ref = row.record.computer?.hostRef
        if (ref?.kind !== 'cloud' || ref.provider !== 'circleci') return false
        const owner = ref.account ?? row.record.ciMirror?.split('/')[0]
        return ref.mainId === parameters[0] && (ref.circleAccountId ?? 'default') === parameters[1]
          && String(ref.slot ?? 0) === parameters[2]
          && (owner?.toLowerCase() === parameters[3] || ref.account === undefined && row.record.ciMirror == null)
      }) }
    }
    return { rows: sql.startsWith('select host_key from ci_runs')
      ? active.filter(row => row.host_key === parameters![0]) : active }
  }, connect: async () => ({ query: pool.query, release: () => {} }) } as unknown as pg.Pool
  const endpoint: HostCiEndpoint = {
    computers: async () => available,
    request: async (computer, request) => {
      if (request.operation === 'status') {
        const reason = unavailable.get(computer.key)
        if (reason === 'offline' || reason === 'extension-rejected') throw new Error(reason)
        return { operation: 'status', ready: !reason, reasons: reason ? [reason] : [],
          cpuCount: options.cpuCounts?.get(computer.key) ?? 8,
          memoryBytes: (options.cpuCounts?.get(computer.key) ?? 16) * 2 * 2 ** 30, runs: [],
          slotsTotal: slots.get(computer.key) ?? 1, slotsUsed: occupied.has(computer.key) ? 1 : 0 }
      }
      if (request.operation === 'read') {
        const record = records.find(run => ciExecutionRunId(run) === request.runId)!
        return { operation: 'read', text: '', nextOffset: 0,
          run: { runId: request.runId, state: record.state, step: record.step,
            startedAt: record.startedAt ?? record.queuedAt, finishedAt: record.finishedAt,
            exitCode: record.exitCode, message: record.message, logBytes: 0 } }
      }
      if (request.operation !== 'start') throw new Error('Unexpected fixture request')
      if (unavailable.has(computer.key)) throw new Error('Unavailable executor cannot start work')
      if (occupied.has(computer.key)) throw new DomainError('CI_HOST_BUSY', 'All CI slots are in use', 409)
      const assigned = CiRunRecordSchema.parse(records.find(record => ciExecutionRunId(record) === request.runId))
      started.push({ computer, request, assigned })
      return { operation: 'start', run: { runId: request.runId, state: 'running', step: 'integration',
        exitCode: null, startedAt: '2026-10-12T00:00:01.000Z', finishedAt: null, logBytes: 0, message: null } }
    },
  }
  if (options.publishMirror) endpoint.publishMirror = options.publishMirror
  const service = new HostCiService(pool, {} as PostgresCommandCoordinator, {} as CiAuthority, {} as CiCommits,
    endpoint, undefined, options)
  return { service, endpoint, started }
}

const secondHost: HostCiComputer = {
  key: 'device:builder', hostRef: { kind: 'device', mainId: 'main', deviceId: 'builder' },
  label: 'Second builder', priority: -1,
}

it('uses persisted jsonb host references to measure each build computer independently', async () => {
  const file = 'apps/api/test/history.integration.test.ts'
  const rows = [host, secondHost].map((computer, index) => ({
    record: pg.types.getTypeParser(3802, 'text')(JSON.stringify({ ...queuedRuns(1)[0],
      gate: true, state: 'passed', files: [file],
      computer: { hostRef: computer.hostRef, label: computer.label },
      startedAt: '2026-10-12T00:00:00.000Z',
      finishedAt: new Date(Date.parse('2026-10-12T00:00:00.000Z') + (index + 1) * 200_000).toISOString(),
    })),
    durations: { [file]: 400_000 },
  }))
  const pool = { query: async () => ({ rows }) } as unknown as pg.Pool
  const endpoint = { computers: async () => [host, secondHost] } as HostCiEndpoint
  const speeds = await readExecutorSpeeds(pool, endpoint)
  expect(speeds.get(host.key)).toMatchObject({ throughput: 2, conservativeThroughput: 2 })
  expect(speeds.get(secondHost.key)).toMatchObject({ throughput: 1, conservativeThroughput: 1 })
})

it.each([false, true])('keeps cloud computers out of a workspace without a mirror, gate=%s', async gate => {
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, suite: 'build',
    partition: null, ciMirror: null, gate, ...(gate ? { plannedHostKey: cloud.key } : {}) }))
  const github: HostCiComputer = { ...cloud, key: 'cloud:github',
    hostRef: { ...cloud.hostRef, provider: 'github' } }
  const occupied = new Set([host.key])
  const f = fleet(records, [cloud, github, host], new Map(), occupied)
  try {
    await f.service.dispatch()
    expect(f.started).toEqual([])
    expect(records[0]).toMatchObject({ state: 'queued', computer: null })
    occupied.clear()
    await f.service.close()
    const available = fleet(records, [cloud, github, host])
    try {
      await available.service.dispatch()
      expect(available.started.map(start => start.computer.key)).toEqual([host.key])
    } finally {
      await available.service.close()
    }
  } finally {
    await f.service.close()
  }
})

it.each(['github', 'circleci'] as const)('checks %s login readiness before claiming an ordinary ticket', async provider => {
  const computer: HostCiComputer = { ...cloud, key: `cloud:${provider}`,
    hostRef: { ...cloud.hostRef, provider } }
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, suite: 'build', partition: null }))
  const f = fleet(records, [computer], new Map([[computer.key, 'Provider login required']]))
  const request = vi.spyOn(f.endpoint, 'request')
  try {
    await f.service.dispatch()
    expect(request.mock.calls.filter(([, input]) => input.operation === 'start')).toEqual([])
    expect(records[0]).toMatchObject({ state: 'queued', computer: null })
  } finally {
    await f.service.close()
  }
})

it.each(['CI_HOST_BUSY', 'CI_CLOUD_UNAVAILABLE'])(
  'excludes every unchanged provider slot after %s and retries after readiness changes', async code => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, suite: 'build', partition: null }))
    const peer: HostCiComputer = { ...cloud, key: 'cloud:circleci:1', hostRef: { ...cloud.hostRef, slot: 1 } }
    const unavailable = new Map<string, string>()
    const f = fleet(records, [cloud, peer], unavailable)
    let reject = true
    const request = f.endpoint.request
    const calls = vi.spyOn(f.endpoint, 'request').mockImplementation(async (computer, input) => {
      if (input.operation === 'start' && reject) throw new DomainError(code, 'Executor rejected the ticket', 409)
      return request(computer, input)
    })
    const starts = () => calls.mock.calls.filter(([, input]) => input.operation === 'start')
    try {
      for (let pass = 0; pass < 4; pass++) {
        vi.setSystemTime(Date.now() + 6000)
        await f.service.dispatch()
      }
      expect(starts()).toHaveLength(1)
      expect(records[0]).toMatchObject({ state: 'queued', computer: null })
      const unchanged = structuredClone(records[0])
      reject = false
      await f.service.dispatch()
      expect(starts()).toHaveLength(1)
      expect(records[0]).toEqual(unchanged)

      for (const computer of [cloud, peer]) unavailable.set(computer.key, 'Provider login required')
      vi.setSystemTime(Date.now() + 6000)
      await f.service.dispatch()
      expect(starts()).toHaveLength(1)
      unavailable.clear()
      vi.setSystemTime(Date.now() + 6000)
      await f.service.dispatch()
      expect(starts()).toHaveLength(2)
      expect(records[0]).toMatchObject({ state: 'running', computer: { hostRef: cloud.hostRef } })
    } finally {
      await f.service.close()
    }
  },
)

it('keeps a rejected build computer excluded until its capacity changes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, suite: 'build', partition: null }))
  const slots = new Map([[host.key, 1]])
  const f = fleet(records, [host], new Map(), new Set(), slots)
  const request = f.endpoint.request
  let reject = true
  let attempts = 0
  const calls = vi.spyOn(f.endpoint, 'request').mockImplementation(async (computer, input) => {
    if (input.operation === 'start') {
      attempts++
      // Bound a broken dispatch loop so the regression can report its failed assertion.
      if (reject && attempts <= 10) throw new DomainError('CI_HOST_BUSY', 'Preparation capacity changed', 409)
    }
    return request(computer, input)
  })
  const starts = () => calls.mock.calls.filter(([, input]) => input.operation === 'start')
  try {
    for (let pass = 0; pass < 4; pass++) {
      vi.setSystemTime(Date.now() + 6000)
      await f.service.dispatch()
    }
    expect(starts()).toHaveLength(1)
    reject = false
    slots.set(host.key, 2)
    vi.setSystemTime(Date.now() + 6000)
    await f.service.dispatch()
    expect(starts()).toHaveLength(2)
    expect(records[0]?.state).toBe('running')
  } finally {
    await f.service.close()
  }
})

it('moves an expired cloud dispatch to another computer and preserves the lookup reason', async () => {
  const reason = 'CircleCI execution could not be reconciled: CircleCI run is not visible.'
  const startedAt = new Date(Date.now() - 225_100).toISOString()
  const records = [CiRunRecordSchema.parse({ ...queuedRuns(1)[0], state: 'starting', startedAt,
    computer: { hostRef: cloud.hostRef, label: cloud.label }, step: 'dispatch',
    message: reason, messageHistory: [reason], providerMessage: reason })]
  const f = fleet(records, [host, cloud])
  const request = f.endpoint.request
  vi.spyOn(f.endpoint, 'request').mockImplementation(async (computer, input, options) => {
    if (computer.key === cloud.key && (input.operation === 'read' || input.operation === 'cancel')) {
      const run = { runId: records[0]!.id, state: 'starting' as const, step: 'dispatch',
        startedAt, finishedAt: null, exitCode: null, logBytes: 0, message: reason }
      if (input.operation === 'cancel') return { operation: 'cancel', run: { ...run, state: 'canceled' } }
      return { operation: 'read', run, text: '', nextOffset: 0 }
    }
    return request(computer, input, options)
  })

  await f.service.dispatch()
  await expect.poll(() => records[0]!.state).not.toBe('starting')
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(f.started[0]!.computer.key).toBe(host.key)
  expect(f.started[0]!.assigned).toMatchObject({ unstartedProviders: ['circleci'],
    executionHistory: [{ runId: records[0]!.id, hostRef: cloud.hostRef }],
    messageHistory: expect.arrayContaining([reason, expect.stringContaining('queued for another computer')]) })
  expect(f.started[0]!.request).toMatchObject({ runId: records[0]!.executionRunId })
  expect(records[0]!.executionRunId).not.toBe(records[0]!.id)
  expect(records[0]!.state).toBe('running')
})

it.each([false, true])('spreads a two-part integration group across free computers with a saved plan=%s', async saved => {
  const records = queuedRuns(2).map(run => CiRunRecordSchema.parse({ ...run,
    ...(saved ? { partition: { ...run.partition, weights: [1, 1], tier: 'fast' }, plannedHostKey: host.key } : {}),
  }))
  const f = fleet(records, [host, secondHost], new Map(), new Set(), new Map([[host.key, 2]]))
  await f.service.dispatch()
  expect(f.started.map(item => item.computer.key)).toEqual([host.key, secondHost.key])
  expect(records.map(run => run.state)).toEqual(['running', 'running'])
  if (!saved) expect(records.map(run => run.plannedHostKey)).toEqual([host.key, secondHost.key])
})

it('spreads a queued partition away from a sibling dispatched in an earlier pass', async () => {
  const records = queuedRuns(2).map(run => CiRunRecordSchema.parse({ ...run,
    partition: { ...run.partition, weights: [1, 1], tier: 'fast' }, plannedHostKey: host.key,
  }))
  records[0] = CiRunRecordSchema.parse({ ...records[0], state: 'running',
    computer: { hostRef: host.hostRef, label: host.label } })
  const f = fleet(records, [host, secondHost], new Map(), new Set(), new Map([[host.key, 2]]))
  await f.service.dispatch()
  expect(f.started.map(item => item.computer.key)).toEqual([secondHost.key])
})

it.each(['typecheck', 'lint', 'build'] as const)('spreads unpartitioned %s parts across free computers', async suite => {
  const records = queuedRuns(2).map((run, index) => CiRunRecordSchema.parse({ ...run,
    suite, part: `${suite}-${index === 0 ? 'api' : 'other'}`, partition: null,
  }))
  const f = fleet(records, [host, secondHost], new Map(), new Set(), new Map([[host.key, 2]]))
  await f.service.dispatch()
  expect(f.started.map(item => item.computer.key)).toEqual([host.key, secondHost.key])
  expect(records.map(run => run.state)).toEqual(['running', 'running'])
})

it('rechecks sibling placement before falling back after a busy start', async () => {
  const records = queuedRuns(2).map(run => CiRunRecordSchema.parse({ ...run,
    partition: { ...run.partition, weights: [1, 1], tier: 'fast' }, plannedHostKey: host.key,
  }))
  const spare: HostCiComputer = { key: 'device:spare', label: 'Spare builder', priority: -2,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'spare' } }
  const f = fleet(records, [host, secondHost, spare], new Map(), new Set(), new Map([[secondHost.key, 2]]))
  const request = f.endpoint.request
  const siblingStarted = deferred()
  let retriedRunId: string | undefined
  vi.spyOn(f.endpoint, 'request').mockImplementation(async (computer, input) => {
    if (input.operation === 'start' && computer.key === host.key) {
      retriedRunId = input.runId
      await siblingStarted.promise
      throw new DomainError('CI_HOST_BUSY', 'All CI slots are in use', 409)
    }
    if (input.operation === 'start' && computer.key === secondHost.key) siblingStarted.resolve()
    return request(computer, input)
  })
  await f.service.dispatch()
  expect(f.started.map(item => item.computer.key)).toEqual([secondHost.key, spare.key])
  expect(records.map(run => run.state)).toEqual(['running', 'running'])
  expect(records.find(run => run.id === retriedRunId)?.computer?.hostRef).toEqual(spare.hostRef)
})

it.each([false, true])('retains preparation capacity reasons and retries placement, alternate computer: %s', async alternate => {
  const records = queuedRuns(1)
  const occupied = new Set<string>()
  const slots = new Map<string, number>()
  const f = fleet(records, alternate ? [host, secondHost] : [host], new Map(), occupied, slots)
  const request = f.endpoint.request
  const reason = 'All CI slots are in use (1/1); this commit needs exclusive database capacity.'
  let busy = true
  vi.spyOn(f.endpoint, 'request').mockImplementation(async (computer, input) => {
    if (input.operation === 'start' && computer.key === host.key && busy) {
      occupied.add(computer.key)
      throw new DomainError('CI_HOST_BUSY', reason, 409)
    }
    return request(computer, input)
  })
  await f.service.dispatch()
  expect(records[0]).toMatchObject({ state: alternate ? 'running' : 'queued',
    messageHistory: [reason], exitCode: null, finishedAt: null })
  if (alternate) {
    expect(records[0]!.computer?.hostRef).toEqual(secondHost.hostRef)
  } else {
    expect(records[0]).toMatchObject({ computer: null, startedAt: null })
    expect(records[0]!.dispatchHostKey).toBeUndefined()
    busy = false
    occupied.clear()
    // A fresh copy of the status the start was rejected under cannot make the executor eligible again;
    // the executor now reports a changed state.
    slots.set(host.key, 2)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000)
    await f.service.dispatch()
    expect(records[0]).toMatchObject({ state: 'running', messageHistory: [reason],
      computer: { hostRef: host.hostRef } })
  }
  await f.service.close()
})

it.each(['busy', 'not-ready', 'offline'])('uses a second slot when the other computer is %s', async reason => {
  const records = queuedRuns(2).map(run => CiRunRecordSchema.parse({ ...run,
    partition: { ...run.partition, weights: [1, 1], tier: 'fast' },
  }))
  const unavailable = reason === 'busy' ? new Map<string, string>() : new Map([[secondHost.key, reason]])
  const occupied = reason === 'busy' ? new Set([secondHost.key]) : new Set<string>()
  const f = fleet(records, [host, secondHost], unavailable, occupied, new Map([[host.key, 2]]))
  await f.service.dispatch()
  expect(f.started.map(item => item.computer.key)).toEqual([host.key, host.key])
  expect(records.map(run => run.state)).toEqual(['running', 'running'])
})

const gateChecks = [
  { suite: 'typecheck', part: 'typecheck-api' },
  { suite: 'lint', part: 'lint-api' },
  { suite: 'unit', part: 'unit-api' },
] as const

it('finishes the running gate before dispatching an earlier-prepared gate admitted during its run', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-12T00:00:02.000Z'))
  const records = queuedRuns(2).map((run, index) => CiRunRecordSchema.parse({ ...run,
    suite: 'typecheck', part: 'typecheck-api', partition: null, gate: true,
    queuedAt: '2026-10-12T00:00:01.000Z', plannedHostKey: index === 0 ? cloud.key : host.key }))
  const earlier = CiRunRecordSchema.parse({ ...queuedRuns(1)[0], suite: 'typecheck', part: 'typecheck-api',
    partition: null, gate: true, plannedHostKey: host.key })
  const entered = deferred()
  const release = deferred()
  const admission = (async () => {
    entered.resolve()
    await release.promise
    records.push(earlier)
  })()
  const occupied = new Set([host.key])
  const f = fleet(records, [cloud, host], new Map(), occupied)
  try {
    await entered.promise
    await f.service.dispatch()
    expect(f.started).toHaveLength(1)
    expect(records[0]?.state).toBe('running')
    expect(records[1]?.state).toBe('queued')
    release.resolve()
    await admission
    occupied.delete(host.key)
    vi.setSystemTime(new Date('2026-10-12T00:00:08.000Z'))
    await f.service.dispatch()
    await f.service.drain()
    expect(f.started.map(item => item.assigned.groupId)).toEqual([records[0]!.groupId, records[0]!.groupId])
    expect(records[1]?.state).toBe('running')
    expect(records.find(run => run.id === earlier.id)?.state).toBe('queued')
  } finally {
    release.resolve()
    await admission
    await f.service.close()
  }
})

function buildGateRun(files = ['apps/api/test/feature.integration.test.ts']) {
  return CiRunRecordSchema.parse({ ...queuedRuns(1)[0], gate: true, noSupersede: true,
    priority: 'high', priorityReason: 'gate', plannedHostKey: host.key, integrationShards: 12,
    expectedDurationMs: 300_000, files, requiresBuildComputer: false })
}

it.each(['not-ready', 'offline', 'disabled'])(
  'keeps a build-sized gate part off cloud while its planned computer is %s during the grace period', async reason => {
    const records = [buildGateRun()]
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(records[0]!.queuedAt) + 90_000)
    const available = reason === 'disabled' ? [cloud] : [host, cloud]
    const f = fleet(records, available, new Map([[host.key, reason]]), new Set(), new Map(),
      { cpuCounts: new Map([[cloud.key, 4]]) })
    await f.service.dispatch()
    expect(f.started).toEqual([])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ state: 'queued', plannedHostKey: host.key, integrationShards: 12 })
  })

it.each([8, 12, 16])('requires planned capacity before a %i-shard spare can steal a build gate part', async cpuCount => {
  const replacement: HostCiComputer = { key: 'device:spare', label: 'Spare builder', priority: 0,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'spare' } }
  const records = [buildGateRun()]
  const elapsed = cpuCount >= 12 ? 91_000 : 30_000
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(records[0]!.queuedAt) + elapsed)
  const f = fleet(records, [host, replacement, cloud], new Map([[host.key, 'not-ready']]), new Set(), new Map(),
    { cpuCounts: new Map([[replacement.key, cpuCount], [cloud.key, 4]]) })
  await f.service.dispatch()
  expect(f.started).toHaveLength(cpuCount >= 12 ? 1 : 0)
  if (cpuCount >= 12) {
    expect(f.started[0]?.computer.key).toBe(replacement.key)
    expect(f.started[0]?.request).toMatchObject({ files: records[0]!.files, integrationShards: cpuCount })
    expect(records[0]).toMatchObject({ plannedHostKey: host.key, integrationShards: 12 })
  } else expect(records[0]?.state).toBe('queued')
})

it('uses the spare build allowance when checking capacity for a gate takeover', async () => {
  const replacement: HostCiComputer = { key: 'device:spare', label: 'Spare builder', priority: 0,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'spare' }, buildAllowancePercent: 50 }
  const records = [buildGateRun()]
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(records[0]!.queuedAt) + 30_000)
  const f = fleet(records, [host, replacement], new Map(), new Set([host.key]), new Map(),
    { cpuCounts: new Map([[replacement.key, 16]]) })
  await f.service.dispatch()
  expect(f.started).toEqual([])
  expect(records[0]).toMatchObject({ state: 'queued', plannedHostKey: host.key, integrationShards: 12 })
})

it('splits an unavailable build gate after 90 seconds by file duration and fills only free unreserved cloud slots', async () => {
  const files = Array.from({ length: 80 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const durations = Object.fromEntries(files.map((file, index) => [file, index < 24 ? 60_000 : 5_000]))
  const records = [buildGateRun(files)]
  const original = { ...records[0]! }
  const clouds = Array.from({ length: 4 }, (_, slot) => ({ ...cloud, key: `cloud:circleci:${slot}`,
    hostRef: { ...cloud.hostRef, slot } }))
  const occupied = new Set([clouds[2]!.key])
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(original.queuedAt) + 90_001)
  const f = fleet(records, [host, ...clouds], new Map([[host.key, 'not-ready']]), occupied, new Map(),
    { durations, cpuCounts: new Map(clouds.map(computer => [computer.key, 4])), reservedCloudSlots: 1 })
  await f.service.dispatch()
  expect(records.length).toBeGreaterThan(1)
  expect(records.some(record => record.id === original.id)).toBe(true)
  expect(records.flatMap(record => record.files).sort()).toEqual([...files].sort())
  for (const record of records) {
    expect(record).toMatchObject({ groupId: original.groupId, workspaceId: original.workspaceId,
      commit: original.commit, gate: true, noSupersede: true, queuedAt: original.queuedAt,
      integrationShards: 4, partition: null, initiator: original.initiator })
    const measured = record.files.reduce((sum, file) => sum + durations[file]!, 0)
    expect(measured).toBeLessThanOrEqual(240_000)
    expect(record.expectedDurationMs).toBe(90_000 + measured)
  }
  expect(f.started).toHaveLength(2)
  expect(f.started.map(item => item.computer.key).sort()).toEqual([clouds[0]!.key, clouds[1]!.key])
  expect(records.filter(record => record.state === 'queued').length).toBeGreaterThan(0)
  for (const item of f.started) {
    expect(item.request).toMatchObject({ operation: 'start', gate: true, scope: 'full', integrationShards: 4,
      durations, files: item.assigned.files })
    expect(item.assigned.files.length).toBeLessThan(files.length)
  }
  const ids = records.map(record => record.id).sort()
  for (const record of records.filter(record => record.state === 'running')) record.state = 'passed'
  for (const computer of clouds) occupied.add(computer.key)
  await f.service.dispatch()
  expect(records.map(record => record.id).sort()).toEqual(ids)
  expect(f.started).toHaveLength(2)
})

it('keeps an expired build gate intact while its planned computer is ready but occupied', async () => {
  const records = [buildGateRun()]
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(records[0]!.queuedAt) + 91_000)
  const f = fleet(records, [host, cloud], new Map(), new Set([host.key]), new Map(),
    { cpuCounts: new Map([[cloud.key, 4]]) })
  await f.service.dispatch()
  expect(f.started).toEqual([])
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ state: 'queued', plannedHostKey: host.key })
})

it.each(gateChecks)('runs a gate $suite part on another free slot of its planned provider', async check => {
  const planned: HostCiComputer = { ...cloud, key: 'cloud:github:0', label: 'GitHub slot 0',
    hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 0 } }
  const replacement: HostCiComputer = { ...planned, key: 'cloud:github:1', label: 'GitHub slot 1',
    hostRef: { ...planned.hostRef, slot: 1 } }
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, ...check, gate: true,
    plannedHostKey: planned.key, expectedDurationMs: 150_000, partition: null }))
  const f = fleet(records, [planned, cloud, host, replacement], new Map(), new Set([planned.key]))
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(f.started[0]?.computer.key).toBe(replacement.key)
  expect(f.started[0]?.request).toMatchObject({ operation: 'start', runId: records[0]!.id, ...check })
  expect(records[0]).toMatchObject({ state: 'running', plannedHostKey: planned.key,
    expectedDurationMs: 150_000, computer: { hostRef: replacement.hostRef } })
})

it.each(gateChecks)('runs a gate $suite part on an idle build computer when cloud slots are busy', async check => {
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, ...check, gate: true,
    plannedHostKey: cloud.key, partition: null }))
  const f = fleet(records, [cloud, host], new Map(), new Set([cloud.key]))
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(f.started[0]?.computer.key).toBe(host.key)
  expect(f.started[0]?.request).toMatchObject({ operation: 'start', runId: records[0]!.id, ...check })
  expect(records[0]).toMatchObject({ state: 'running', plannedHostKey: cloud.key,
    computer: { hostRef: host.hostRef } })
})

it.each(['github', 'circleci'] as const)(
  'moves a gate check from a busy %s provider to an eligible idle provider', async provider => {
    const planned: HostCiComputer = { ...cloud, key: `cloud:${provider}:0`,
      hostRef: { ...cloud.hostRef, provider } }
    const replacement: HostCiComputer = { ...cloud, key: 'cloud:replacement',
      hostRef: { ...cloud.hostRef, provider: provider === 'github' ? 'circleci' : 'github' } }
    const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true,
      suite: 'lint', part: 'lint-api', partition: null, plannedHostKey: planned.key }))
    const f = fleet(records, [planned, replacement, host], new Map(), new Set([planned.key, host.key]))
    await f.service.dispatch()
    expect(f.started.map(item => item.computer.key)).toEqual([replacement.key])
    expect(records[0]).toMatchObject({ state: 'running', plannedHostKey: planned.key,
      computer: { hostRef: replacement.hostRef } })
  },
)

it.each([false, true])('preserves systemd support when stealing across cloud providers: %s', async supported => {
  const planned: HostCiComputer = { ...cloud, key: 'cloud:github:0',
    hostRef: { ...cloud.hostRef, provider: 'github' } }
  const replacement = { ...cloud, userSystemd: { supported, reason: supported ? null : 'No user manager' } }
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true,
    plannedHostKey: planned.key, partition: null, integrationShards: 8, requiresBuildComputer: true,
    files: ['apps/api/test/native-service-restart.integration.test.ts'] }))
  const f = fleet(records, [planned, replacement], new Map(), new Set([planned.key]))
  await f.service.dispatch()
  expect(f.started).toHaveLength(supported ? 1 : 0)
  expect(records[0]?.state).toBe(supported ? 'running' : 'queued')
})

it('keeps Worker unit tests off CircleCI when their planned GitHub provider is busy', async () => {
  const planned: HostCiComputer = { ...cloud, key: 'cloud:github:0',
    hostRef: { ...cloud.hostRef, provider: 'github' } }
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true,
    suite: 'unit', part: 'unit-other', partition: null, plannedHostKey: planned.key }))
  const f = fleet(records, [planned, cloud], new Map(), new Set([planned.key]))
  await f.service.dispatch()
  expect(f.started).toEqual([])
  expect(records[0]?.state).toBe('queued')
})

it.each(['read', 'status'] as const)('dispatches on idle computers while another executor %s is stalled', async operation => {
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, suite: 'lint', partition: null,
    state: 'running', computer: { hostRef: host.hostRef, label: host.label } }))
  const pending = () => CiRunRecordSchema.parse({ ...queuedRuns(1)[0], suite: 'lint', partition: null })
  records.push(pending())
  const f = fleet(records, [host, secondHost, cloud])
  const stalled = deferred()
  const entered = deferred()
  const request = f.endpoint.request
  vi.spyOn(f.endpoint, 'request').mockImplementation(async (computer, input) => {
    if (computer.key === host.key && input.operation === operation) {
      entered.resolve()
      await stalled.promise
    }
    if (input.operation === 'read') {
      return { operation: 'read', run: { runId: input.runId, state: 'running', step: 'lint',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, logBytes: 0, message: null },
      text: '', nextOffset: 0 }
    }
    return request(computer, input)
  })
  const dispatch = f.service.dispatch()
  try {
    await entered.promise
    await vi.waitFor(() => expect(f.started).toHaveLength(1), { timeout: 1000 })
    records.push(pending())
    const next = f.service.dispatch()
    await vi.waitFor(() => expect(f.started).toHaveLength(2), { timeout: 1000 })
    await next
    // Which idle computer answers its status first decides who gets the first ticket.
    expect(f.started.map(item => item.computer.key).sort()).toEqual([secondHost.key, cloud.key].sort())
    expect(records.slice(1).map(run => run.state)).toEqual(['running', 'running'])
  } finally {
    stalled.resolve()
    await dispatch
    await f.service.close()
  }
})

it.each([false, true])('moves a systemd gate integration part to a free provider slot only with support: %s',
  async supported => {
    const replacement = { ...cloud, key: 'cloud:circleci:1', hostRef: { ...cloud.hostRef, slot: 1 },
      userSystemd: { supported, reason: supported ? null : 'No user manager' } }
    const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true,
      plannedHostKey: cloud.key, partition: null, integrationShards: 32, requiresBuildComputer: true,
      files: ['apps/api/test/native-service-restart.integration.test.ts'] }))
    const f = fleet(records, [cloud, replacement], new Map(), new Set([cloud.key]))
    await f.service.dispatch()
    expect(f.started).toHaveLength(supported ? 1 : 0)
    expect(records[0]?.state).toBe(supported ? 'running' : 'queued')
    if (supported) {
      expect(f.started[0]?.computer.key).toBe(replacement.key)
      expect(f.started[0]?.request).toMatchObject({ gate: true, files: records[0]!.files, integrationShards: 8 })
      expect(records[0]?.plannedHostKey).toBe(cloud.key)
      expect(records[0]?.integrationShards).toBe(32)
    }
  })

it.each(gateChecks)('keeps a gate $suite check queued while the build computer starts its own exclusive gate part', async check => {
  const records = queuedRuns(2).map((run, index) => CiRunRecordSchema.parse({ ...run, gate: true,
    ...(index === 0 ? { ...check, plannedHostKey: cloud.key }
      : { plannedHostKey: host.key, integrationShards: 16, requiresBuildComputer: false,
        files: ['apps/api/test/workflow.integration.test.ts'] }),
    partition: null }))
  const f = fleet(records, [cloud, host], new Map(), new Set([cloud.key]))
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(f.started[0]?.computer.key).toBe(host.key)
  expect(f.started[0]?.request).toMatchObject({ operation: 'start', runId: records[1]!.id,
    suite: 'integration', gate: true, scope: 'full', integrationShards: 8,
    files: ['apps/api/test/workflow.integration.test.ts'] })
  expect(records[0]).toMatchObject({ state: 'queued', computer: null })
  expect(records[1]).toMatchObject({ state: 'running', plannedHostKey: host.key, integrationShards: 16,
    computer: { hostRef: host.hostRef } })
})

it('does not start a gate check on a build computer with an occupied CI slot', async () => {
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, suite: 'typecheck',
    part: 'typecheck-api', gate: true, plannedHostKey: cloud.key, partition: null }))
  const f = fleet(records, [cloud, host], new Map(), new Set([cloud.key, host.key]))
  await f.service.dispatch()
  expect(f.started).toEqual([])
  expect(records[0]).toMatchObject({ state: 'queued', computer: null })
})

it.each([
  { ownPart: 'none', requiresBuildComputer: false },
  { ownPart: 'passed', requiresBuildComputer: false },
  { ownPart: 'none', requiresBuildComputer: true },
  { ownPart: 'passed', requiresBuildComputer: true },
])('steals a busy build computer integration part with own part=$ownPart and systemd=$requiresBuildComputer',
  async ({ ownPart, requiresBuildComputer }) => {
    const replacement: HostCiComputer = { key: 'device:spare', label: 'Spare builder', priority: 0,
      hostRef: { kind: 'device', mainId: 'main', deviceId: 'spare' } }
    const records = queuedRuns(2).map(run => CiRunRecordSchema.parse({ ...run, gate: true,
      plannedHostKey: host.key, partition: null, integrationShards: 32, requiresBuildComputer,
      expectedDurationMs: 120_000,
      files: [requiresBuildComputer ? 'apps/api/test/native-service-restart.integration.test.ts'
        : 'apps/api/test/workflow.integration.test.ts'],
    }))
    if (ownPart === 'passed') {
      records[1] = CiRunRecordSchema.parse({ ...records[1], plannedHostKey: replacement.key, state: 'passed',
        computer: { hostRef: replacement.hostRef, label: replacement.label },
        startedAt: '2026-10-12T00:00:01.000Z', finishedAt: '2026-10-12T00:01:00.000Z' })
    } else records.pop()
    const f = fleet(records, [host, replacement, cloud], new Map(), new Set([host.key]), new Map(),
      { cpuCounts: new Map([[replacement.key, 32]]) })
    await f.service.dispatch()
    expect(f.started).toHaveLength(1)
    expect(f.started[0]?.computer.key).toBe(replacement.key)
    expect(f.started[0]?.request).toMatchObject({ operation: 'start', runId: records[0]!.id,
      suite: 'integration', gate: true, scope: 'full', files: records[0]!.files, integrationShards: 32 })
    expect(f.started[0]?.assigned).toMatchObject({ state: 'starting', step: 'dispatch',
      plannedHostKey: host.key, integrationShards: 32, expectedDurationMs: 120_000,
      computer: { hostRef: replacement.hostRef }, dispatchHostKey: replacement.key,
      dispatchedAt: expect.any(String), dispatchAttempts: 1, dispatchRequest: f.started[0]!.request })
    expect(records[0]).toMatchObject({ state: 'running', plannedHostKey: host.key, integrationShards: 32,
      step: 'integration', expectedDurationMs: 120_000, computer: { hostRef: replacement.hostRef } })
    expect(records[0]?.dispatchRequest).toBeUndefined()
    expect(records[0]?.dispatchHostKey).toBeUndefined()
    expect(records[0]?.dispatchedAt).toBeUndefined()
    if (ownPart === 'passed') expect(records[1]?.state).toBe('passed')
  })

it.each(['queued-own-part', 'occupied-slot', 'not-ready'])(
  'keeps a busy build computer integration part queued when the spare has %s', async reason => {
    const replacement: HostCiComputer = { key: 'device:spare', label: 'Spare builder', priority: 0,
      hostRef: { kind: 'device', mainId: 'main', deviceId: 'spare' } }
    const records = queuedRuns(2).map((run, index) => CiRunRecordSchema.parse({ ...run, gate: true,
      plannedHostKey: index ? replacement.key : host.key, partition: null,
      integrationShards: 32, requiresBuildComputer: false,
      files: ['apps/api/test/workflow.integration.test.ts'],
    }))
    if (reason !== 'queued-own-part') records.pop()
    const occupied = new Set([host.key])
    if (reason === 'occupied-slot') occupied.add(replacement.key)
    const unavailable = new Map<string, string>()
    if (reason === 'not-ready') unavailable.set(replacement.key, reason)
    const f = fleet(records, [host, replacement, cloud], unavailable, occupied, new Map([[replacement.key, 2]]),
      { cpuCounts: new Map([[replacement.key, 32]]) })
    await f.service.dispatch()
    expect(records[0]).toMatchObject({ state: 'queued', computer: null })
    expect(f.started).toHaveLength(reason === 'queued-own-part' ? 1 : 0)
    if (reason === 'queued-own-part') {
      expect(f.started[0]?.request).toMatchObject({ runId: records[1]!.id })
      expect(records[1]).toMatchObject({ state: 'running', computer: { hostRef: replacement.hostRef } })
    }
  })

it.each(['not-ready', 'offline', 'extension-rejected', 'disabled'])(
  'dispatches a queued gate part elsewhere after its planned computer becomes %s', async reason => {
    const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true,
      plannedHostKey: host.key, partition: null, integrationShards: 32, requiresBuildComputer: false,
      files: ['apps/api/test/workflow.integration.test.ts'],
    }))
    const replacement: HostCiComputer = { key: 'device:replacement', label: 'Replacement builder', priority: 0,
      hostRef: { kind: 'device', mainId: 'main', deviceId: 'replacement' } }
    const available = [host, replacement, cloud]
    const unavailable = new Map<string, string>()
    const f = fleet(records, available, unavailable, new Set([host.key]), new Map(),
      { cpuCounts: new Map([[replacement.key, 32]]) })
    if (reason === 'disabled') available.splice(0, 1)
    else unavailable.set(host.key, reason)
    await f.service.dispatch()
    expect(f.started).toHaveLength(1)
    expect(f.started[0]?.computer.key).toBe(replacement.key)
    expect(f.started[0]?.request).toMatchObject({ operation: 'start', runId: records[0]!.id,
      gate: true, files: records[0]!.files, integrationShards: 32 })
    expect(records[0]).toMatchObject({ state: 'running', plannedHostKey: host.key, integrationShards: 32,
      computer: { hostRef: replacement.hostRef } })
    expect(records[0]?.files).toEqual(['apps/api/test/workflow.integration.test.ts'])
    expect(records[0]?.gate).toBe(true)
  },
)

it.each([false, true])('splits an expired systemd gate part only onto a capable cloud slot: supported=%s', async supported => {
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true,
    plannedHostKey: host.key, partition: null, integrationShards: 32, requiresBuildComputer: true,
    files: ['apps/api/test/native-service-restart.integration.test.ts'],
  }))
  const capable = { ...cloud, userSystemd: { supported, reason: supported ? null : 'No user manager' } }
  const f = fleet(records, [capable])
  await f.service.dispatch()
  expect(f.started).toHaveLength(supported ? 1 : 0)
  expect(records[0]?.state).toBe(supported ? 'running' : 'queued')
  if (supported) {
    expect(f.started[0]?.computer.key).toBe(cloud.key)
    expect(f.started[0]?.request).toMatchObject({ gate: true, files: records[0]!.files, integrationShards: 8 })
    expect(records[0]?.computer?.hostRef).toEqual(cloud.hostRef)
    expect(records[0]).toMatchObject({ plannedHostKey: cloud.key, integrationShards: 8 })
  }
})

it('keeps an unavailable planned gate queued when no replacement is ready', async () => {
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true,
    plannedHostKey: host.key, partition: null, integrationShards: 16, requiresBuildComputer: false,
    files: ['apps/api/test/workflow.integration.test.ts'],
  }))
  const f = fleet(records, [cloud], new Map([[cloud.key, 'not-ready']]))
  await f.service.dispatch()
  expect(f.started).toEqual([])
  expect(records[0]).toMatchObject({ state: 'queued', computer: null })
})

it.each([
  { suite: 'integration', requiresBuildComputer: true,
    files: ['apps/api/test/native-service-restart.integration.test.ts'] },
  { suite: 'integration', requiresBuildComputer: false,
    files: ['apps/api/test/workflow.integration.test.ts'] },
  { suite: 'unit', requiresBuildComputer: false,
    files: ['apps/api/src/modules/ci-host/servicePlacement.test.ts'] },
] as const)('prefers an idle build computer for affected $suite with requiresBuildComputer=$requiresBuildComputer',
  async ({ suite, requiresBuildComputer, files }) => {
    const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run,
      suite, scope: 'affected', files, requiresBuildComputer,
    }))
    const circleci = { ...cloud, userSystemd: { supported: true, reason: null } }
    const github: HostCiComputer = {
      ...circleci, key: 'cloud:github', label: 'GitHub',
      hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 0 },
    }
    const f = fleet(records, [circleci, github, host])
    await f.service.dispatch()
    expect(f.started).toHaveLength(1)
    expect(f.started[0]?.computer.key).toBe(host.key)
    expect(f.started[0]?.request).toMatchObject({ operation: 'start', suite, scope: 'affected', files })
    expect(records[0]).toMatchObject({ state: 'running', computer: { hostRef: host.hostRef } })
  })

it('assigns host slices to build computers even when a cloud computer has higher priority', async () => {
  const records = queuedRuns(2)
  const f = fleet(records, [cloud, host])
  await f.service.dispatch()
  expect(f.started).toHaveLength(2)
  expect(f.started.find(item => item.computer.key === host.key)?.request)
    .toMatchObject({ partition: { index: 0, hostIndexes: [0] } })
  expect(f.started.find(item => item.computer.key === cloud.key)?.request)
    .toMatchObject({ partition: { index: 1, hostIndexes: [0] } })
  expect(records.map(record => record.state)).toEqual(['running', 'running'])
})

it('keeps the host slice queued when only cloud slots are available', async () => {
  const records = queuedRuns(2)
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(f.started[0]?.request).toMatchObject({ partition: { index: 1, hostIndexes: [0] } })
  expect(records[0]).toMatchObject({ state: 'queued', computer: null, partition: { hostIndexes: [0] },
    message: 'Waiting for a build computer: this integration slice needs one; no eligible computers' })
  expect(records[1]?.state).toBe('running')
  const waiting = { ...records[0]! }
  await f.service.dispatch()
  expect(records[0]).toEqual(waiting)
  const withHost = fleet(records, [cloud, host])
  await withHost.service.dispatch()
  expect(withHost.started).toHaveLength(1)
  expect(withHost.started[0]?.computer.key).toBe(host.key)
  expect(records[0]).toMatchObject({ state: 'running', message: null })
})

it('keeps an unpartitioned integration suite on a build computer', async () => {
  const records = queuedRuns(1)
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started).toEqual([])
  expect(records[0]?.state).toBe('queued')
})

it.each(['github', 'circleci'] as const)('assigns systemd slices to %s when its executor declares support', async provider => {
  const records = queuedRuns(2)
  const capable = { ...cloud, hostRef: { ...cloud.hostRef, provider },
    userSystemd: { supported: true, reason: null } }
  const f = fleet(records, [capable])
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(f.started[0]?.request).toMatchObject({ partition: { index: 0, hostIndexes: [0] } })
  expect(records[0]).toMatchObject({ state: 'running', computer: { hostRef: { kind: 'cloud', provider } } })
})

it('runs an unpartitioned systemd selection on a capable cloud slot', async () => {
  const records = queuedRuns(1)
  records[0] = CiRunRecordSchema.parse({ ...records[0], scope: 'affected',
    files: ['apps/api/test/native-service-restart.integration.test.ts'] })
  const f = fleet(records, [{ ...cloud, userSystemd: { supported: true, reason: null } }])
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(records[0]?.state).toBe('running')
})

it('plans systemd files on capable cloud capacity and keeps a build computer available for other slices', async () => {
  const records = queuedRuns(2)
  const f = fleet(records, [host, { ...cloud, userSystemd: { supported: true, reason: null } }])
  await f.service.dispatch()
  expect(f.started.find(item => item.computer.key === cloud.key)?.request)
    .toMatchObject({ partition: { index: 0, hostIndexes: [0] } })
  expect(f.started.find(item => item.computer.key === host.key)?.request)
    .toMatchObject({ partition: { index: 1, hostIndexes: [0] } })
})

it.each([host, cloud])('dispatches high priority then oldest tickets on $label', async computer => {
  const records = queuedRuns(4).map((record, index) => CiRunRecordSchema.parse({ ...record,
    suite: 'install', partition: null, priority: index > 1 ? 'high' : 'normal',
    queuedAt: new Date(Date.parse(record.queuedAt) + index * 1000).toISOString(),
  }))
  const f = fleet(records, [computer])
  const expected = [records[2]!.id, records[3]!.id, records[0]!.id, records[1]!.id]
  for (const id of expected) {
    await f.service.dispatch()
    expect(f.started.at(-1)?.request).toMatchObject({ runId: id })
    const running = records.find(record => record.id === id)!
    running.state = 'passed'
  }
  expect(f.started.map(item => item.request.operation === 'start' ? item.request.runId : null)).toEqual(expected)
})

it('dispatches a duration-planned single ordinary full slice to cloud', async () => {
  const records = queuedRuns(1).map(run => ({ ...run, expectedDurationMs: 210_000, requiresBuildComputer: false }))
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(f.started[0]!.computer.key).toBe(cloud.key)
  expect(records[0]!.state).toBe('running')
})


function tieredRuns({ gate = false }: { gate?: boolean } = {}) {
  const fastFile = 'apps/api/test/workflow.integration.test.ts'
  const slowFile = 'apps/api/test/workflow-recovery.integration.test.ts'
  return queuedRuns(2).map((run, index) => {
    const file = index === 0 ? fastFile : slowFile
    const tier = index === 0 ? 'fast' : 'slow'
    const selection = gate
      ? { partition: null, files: [file],
        integrationShards: 8, plannedHostKey: cloud.key, requiresBuildComputer: false }
      : { partition: { index: 0, count: 1, weights: [1], tier, slowFiles: [slowFile] } }
    return CiRunRecordSchema.parse({ ...run, ...selection, gate })
  })
}

it('dispatches the gate selection with valid host requests after a fast failure', async () => {
  const records = tieredRuns({ gate: true })
  records[0] = CiRunRecordSchema.parse({ ...records[0]!, state: 'failed', exitCode: 1,
    finishedAt: '2026-10-12T00:05:00.000Z' })
  const failed = { ...records[0]! }
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(CiHostRequestSchema.parse(f.started[0]!.request)).toMatchObject({
    operation: 'start', runId: records[1]!.id, gate: true, scope: 'full',
    files: records[1]!.files, integrationShards: 8,
  })
  expect(records[1]).toMatchObject({ state: 'running' })
  expect(records[0]).toEqual(failed)
})

function plannedTierRuns(scope: 'full' | 'affected' = 'full') {
  const files = ['quick', 'short', 'medium', 'long'].map(name => `apps/api/test/${name}.integration.test.ts`)
  const durations = Object.fromEntries(files.map((file, index) => [file, [10_000, 60_000, 90_000, 180_000][index]!]))
  const parts = planIntegrationParts({ suite: 'integration', scope, files }, { files, durations },
    { host: 0, ordinary: 4 })
  return queuedRuns(parts.length).map((run, index) => CiRunRecordSchema.parse({ ...run, ...parts[index], scope,
    id: `00000000-0000-4000-8000-${String(parts.length - index).padStart(12, '0')}` }))
}

it.each(['full', 'affected'] as const)('dispatches slow and fast parts together with spare capacity for %s scope', async scope => {
  const records = plannedTierRuns(scope)
  const computers = Array.from({ length: records.length }, (_, slot) => ({ ...cloud,
    key: `cloud:circleci:${slot}`, hostRef: { ...cloud.hostRef, slot } }))
  const f = fleet(records, computers)
  await f.service.dispatch()
  expect(f.started).toHaveLength(records.length)
  expect(records.every(run => run.state === 'running')).toBe(true)
})

it('gives waiting fast parts priority, then starts the longest slow part as soon as a slot frees', async () => {
  const [fast, ...slow] = plannedTierRuns()
  const longestFirst = [...slow].sort((left, right) => right.expectedDurationMs! - left.expectedDurationMs!)
  const records = [...slow].reverse().concat(fast!)
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started.map(item => item.assigned.id)).toEqual([fast!.id])
  records[records.findIndex(run => run.id === fast!.id)]!.state = 'passed'
  const expected = [fast!.id]
  for (const run of longestFirst) {
    await f.service.dispatch()
    expected.push(run.id)
    expect(f.started.map(item => item.assigned.id)).toEqual(expected)
    records[records.findIndex(record => record.id === run.id)]!.state = 'passed'
  }
})

it('uses a newly freed slot for slow work while another fast part is still running', async () => {
  const [fast, slow] = plannedTierRuns()
  const second = { ...cloud, key: 'cloud:circleci:1', hostRef: { ...cloud.hostRef, slot: 1 } }
  const running = CiRunRecordSchema.parse({ ...fast!, id: randomUUID(), state: 'running',
    computer: { hostRef: cloud.hostRef, label: cloud.label } })
  const finishing = CiRunRecordSchema.parse({ ...fast!, id: randomUUID(), state: 'running',
    computer: { hostRef: second.hostRef, label: second.label } })
  const records = [running, finishing, slow!]
  const f = fleet(records, [cloud, second])
  await f.service.dispatch()
  expect(f.started).toEqual([])
  records[1]!.state = 'passed'
  await f.service.dispatch()
  expect(f.started.map(item => item.assigned.id)).toEqual([slow!.id])
  expect(records[0]!.state).toBe('running')
})

it.each(['full', 'affected'] as const)('continues slow work after a fast failure for %s scope', async scope => {
  const [fast, slow] = plannedTierRuns(scope)
  const failed = CiRunRecordSchema.parse({ ...fast!, state: 'failed', exitCode: 1,
    finishedAt: '2026-10-12T00:05:00.000Z' })
  const records = [failed, slow!]
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started.map(item => item.assigned.id)).toEqual([slow!.id])
  expect(records[0]).toEqual(failed)
  expect(records[1]!.state).toBe('running')
})

it('lets later full requests dispatch when the oldest gate already has a failed part', async () => {
  const [failed, straggler] = queuedRuns(2).map((run, index) => CiRunRecordSchema.parse({ ...run, gate: true,
    state: index ? 'running' : 'failed', computer: index ? { hostRef: cloud.hostRef, label: cloud.label } : null,
    startedAt: '2026-10-12T00:00:01.000Z', finishedAt: index ? null : '2026-10-12T00:01:00.000Z' }))
  const [later] = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, suite: 'lint', partition: null,
    queuedAt: '2026-10-12T00:02:00.000Z' }))
  const records = [failed!, straggler!, later!]
  const second = { ...cloud, key: 'cloud:circleci:1', hostRef: { ...cloud.hostRef, slot: 1 } }
  const f = fleet(records, [cloud, second])
  await f.service.dispatch()
  expect(f.started.map(item => item.request.operation === 'start' ? item.request.runId : null)).toEqual([later!.id])
  expect(records[2]).toMatchObject({ state: 'running', message: null })
  expect(records[1]!.state).toBe('running')
})

it('lets an unrelated full request use idle capacity while another workspace gate runs', async () => {
  const [gate] = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true, partition: null,
    state: 'running', computer: { hostRef: cloud.hostRef, label: cloud.label },
    startedAt: '2026-10-12T00:00:01.000Z' }))
  const [later] = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, suite: 'lint', partition: null,
    queuedAt: '2026-10-12T00:02:00.000Z' }))
  const records = [gate!, later!]
  const second = { ...cloud, key: 'cloud:circleci:1', hostRef: { ...cloud.hostRef, slot: 1 } }
  const f = fleet(records, [cloud, second])
  await f.service.dispatch()
  expect(f.started.map(item => item.request.operation === 'start' ? item.request.runId : null)).toEqual([later!.id])
  expect(records[1]).toMatchObject({ state: 'running', message: null })
  expect(records[0]!.state).toBe('running')
})

it('publishes the mirror snapshot before a cloud ticket claims its slot', async () => {
  const github: HostCiComputer = { ...cloud, key: 'cloud:github:0', hostRef: { ...cloud.hostRef, provider: 'github' } }
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, suite: 'build', partition: null }))
  const publication = deferred()
  const publishMirror = vi.fn(async () => publication.promise)
  const f = fleet(records, [github], new Map(), new Set(), new Map(), { publishMirror })
  try {
    await f.service.dispatch()
    expect(publishMirror).toHaveBeenCalledWith(expect.objectContaining({ repository: 'owner/repo',
      mirror: 'example/ci-mirror', commit: 'a'.repeat(40) }))
    expect(f.started).toEqual([])
    expect(records[0]).toMatchObject({ state: 'queued', computer: null })
    publication.resolve()
    await expect.poll(() => f.started.length).toBe(1)
    expect(records[0]).toMatchObject({ state: 'running' })
    expect(publishMirror).toHaveBeenCalledTimes(1)
  } finally {
    publication.resolve()
    await f.service.close()
  }
})

it('keeps GitHub integration slots free when the only queued check is blocked behind a gate', async () => {
  const githubs = Array.from({ length: 5 }, (_, slot): HostCiComputer => ({ ...cloud, key: `cloud:github:${slot}`,
    hostRef: { ...cloud.hostRef, provider: 'github', slot }, label: `GitHub ${slot + 1}` }))
  const [gate] = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true, state: 'running',
    computer: { hostRef: cloud.hostRef, label: cloud.label }, startedAt: '2026-10-12T00:00:01.000Z' }))
  // Only another gate waits behind the running gate; other checks backfill.
  const [blocked] = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true, suite: 'lint', partition: null,
    queuedAt: '2026-10-12T00:02:00.000Z' }))
  const integrations = [1, 2].map(index => CiRunRecordSchema.parse({ ...queuedRuns(1)[0], suite: 'integration',
    partition: null, id: randomUUID(), groupId: randomUUID(), scope: 'affected',
    files: [`apps/api/test/example-${index}.integration.test.ts`], queuedAt: '2026-10-12T00:03:00.000Z' }))
  const records = [gate!, blocked!, ...integrations]
  const f = fleet(records, [cloud, ...githubs])
  try {
    await f.service.dispatch()
    expect(integrations.map(run => records.find(record => record.id === run.id)!.state)).toEqual(['running', 'running'])
    expect(records.find(record => record.id === blocked!.id)!.state).toBe('queued')
  } finally {
    await f.service.close()
  }
})


it.each(['CI_HOST_BUSY', 'CI_CLOUD_UNAVAILABLE'])(
  'retries transient %s after bounded backoff when healthy status never changed', async code => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, suite: 'build', partition: null }))
    const peer: HostCiComputer = { ...cloud, key: 'cloud:circleci:1', hostRef: { ...cloud.hostRef, slot: 1 } }
    const f = fleet(records, [cloud, peer])
    const request = f.endpoint.request
    let attempts = 0
    vi.spyOn(f.endpoint, 'request').mockImplementation(async (computer, input) => {
      if (input.operation === 'start' && ++attempts === 1) {
        throw new DomainError(code, 'Transient capacity refusal', 409)
      }
      return request(computer, input)
    })
    try {
      await f.service.dispatch()
      expect(attempts).toBe(1)
      expect(records[0]).toMatchObject({ state: 'queued', computer: null })
      vi.setSystemTime(Date.now() + 59_999)
      await f.service.dispatch()
      expect(attempts).toBe(1)
      vi.setSystemTime(Date.now() + 6000)
      await f.service.dispatch()
      expect(attempts).toBe(2)
      expect(records[0]).toMatchObject({ state: 'running', computer: { hostRef: cloud.hostRef } })
    } finally {
      await f.service.close()
    }
  },
)

it('keeps structural protocol rejections blocked across time until executor status changes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, suite: 'build', partition: null }))
  const slots = new Map([[host.key, 1]])
  const f = fleet(records, [host], new Map(), new Set(), slots)
  const request = f.endpoint.request
  let attempts = 0
  vi.spyOn(f.endpoint, 'request').mockImplementation(async (computer, input) => {
    if (input.operation === 'start' && ++attempts === 1) {
      throw new DomainError('CI_HOST_PROTOCOL_UNSUPPORTED', 'Update Worker protocol', 409)
    }
    return request(computer, input)
  })
  try {
    await f.service.dispatch()
    vi.setSystemTime(Date.now() + 86_400_000)
    await f.service.dispatch()
    expect(attempts).toBe(1)
    expect(records[0]?.state).toBe('queued')
    slots.set(host.key, 2)
    vi.setSystemTime(Date.now() + 6000)
    await f.service.dispatch()
    expect(attempts).toBe(2)
    expect(records[0]?.state).toBe('running')
  } finally {
    await f.service.close()
  }
})
