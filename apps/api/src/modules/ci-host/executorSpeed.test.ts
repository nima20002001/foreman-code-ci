import { expect, it } from 'vitest'
import type pg from 'pg'
import { CiRunRecordSchema, type CiRunInput, type CiRunRecord } from '@foreman-code/contracts'
import { planCiGate } from './gate.js'
import { estimateExecutorSpeeds, invalidateExecutorSpeeds, readExecutorSpeeds } from './executorSpeed.js'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import { weighCiPartitions } from './partitionPlanning.js'
import { CiPlanningSnapshot } from './planningSnapshot.js'

const computers: HostCiComputer[] = [
  { key: 'builder-main', label: 'Main builder', priority: 60, hostRef: { kind: 'main', mainId: 'main' } },
  { key: 'builder-paired', label: 'Paired builder', priority: 50,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'paired' } },
  { key: 'builder-spare', label: 'Spare builder', priority: 40,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'spare' } },
  ...[0, 1].map(slot => ({ key: `cloud-${slot}`, label: `Cloud ${slot}`, priority: 30,
    hostRef: { kind: 'cloud' as const, mainId: 'main', provider: 'github' as const, slot },
    userSystemd: { supported: true, reason: null } })),
]

let sequence = 0
function gatePart(ranOn: HostCiComputer, plannedHostKey: string, expectedDurationMs: number, actualMs: number,
  extra: Partial<CiRunRecord> = {}): CiRunRecord {
  sequence += 1
  const started = Date.parse('2026-10-13T10:00:00.000Z')
  return CiRunRecordSchema.parse({
    id: `11111111-1111-4111-8111-${String(sequence).padStart(12, '0')}`, workspaceId: 'workspace',
    groupId: '22222222-2222-4222-8222-222222222222', suite: 'integration', part: null, gate: true,
    scope: 'full', files: [], partition: null, repository: 'owner/repo', commit: 'a'.repeat(40),
    state: 'passed', computer: { hostRef: ranOn.hostRef, label: ranOn.label }, step: 'integration',
    exitCode: 0, message: null, queuedAt: new Date(started).toISOString(),
    startedAt: new Date(started).toISOString(), finishedAt: new Date(started + actualMs).toISOString(),
    initiator: { principalId: 'worker', executionId: 'execution' },
    plannedHostKey, expectedDurationMs, ...extra,
  })
}

it('learns each executor speed from recent passed gate parts it was planned for', () => {
  const [main, paired, spare, cloud0, cloud1] = computers as [HostCiComputer, HostCiComputer, HostCiComputer,
    HostCiComputer, HostCiComputer]
  const runs = [
    ...[2, 1.8, 2.2, 2, 2.1].map(ratio => gatePart(main, main.key, 300_000, 300_000 * ratio)),
    // A part planned with a factor already applied still reveals the unscaled speed.
    gatePart(cloud1, cloud0.key, 150_000, 150_000, { speedFactor: 0.6 }),
    gatePart(cloud0, cloud0.key, 150_000, 90_000),
    // Stolen parts were sized for another computer, and failures say nothing about speed.
    gatePart(paired, cloud0.key, 100_000, 900_000),
    gatePart(paired, paired.key, 100_000, 900_000, { state: 'failed', exitCode: 1 }),
    gatePart(spare, spare.key, 100_000, 900_000),
  ]
  const speeds = estimateExecutorSpeeds(runs, computers)
  expect(speeds.get(main.key)).toBe(2)
  expect(speeds.get('cloud:github')).toBeCloseTo(0.6)
  expect(speeds.has(paired.key)).toBe(false)
  expect(speeds.get(spare.key)).toBe(3)
  expect(estimateExecutorSpeeds([], computers).size).toBe(0)
})

function endpoint(): HostCiEndpoint {
  const fleet = computers.filter(computer => computer.key !== 'builder-spare')
  return {
    computers: async () => fleet,
    request: async computer => ({ operation: 'status', ready: true, reasons: [],
      cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 2, memoryBytes: 32 * 2 ** 30,
      slotsUsed: 0, slotsTotal: 1, runs: [] }),
  }
}

async function builderPlan(speeds?: Map<string, number>) {
  const files = Array.from({ length: 160 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 30_000]))
  const input: CiRunInput = { suite: 'integration', scope: 'full', gate: true, commandId: 'gate' }
  const parts = await planCiGate(input, { files, durations },
    { files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] }, {}, endpoint(), speeds)
  const integration = parts.filter(part => part.suite === 'integration')
  expect(integration.flatMap(part => part.files).sort()).toEqual([...files].sort())
  const part = (key: string) => integration.find(item => item.plannedHostKey === key)!
  const work = (key: string) => part(key).files.length * 30_000
  return { main: part('builder-main'), paired: part('builder-paired'),
    mainWork: work('builder-main'), pairedWork: work('builder-paired') }
}

it('gives a slower computer proportionally less work so predicted finishes balance', async () => {
  const { main, paired, mainWork, pairedWork } = await builderPlan(new Map([['builder-main', 2]]))
  expect(mainWork).toBeLessThan(pairedWork * 0.55)
  expect(main.speedFactor).toBe(2)
  expect(Math.abs(main.expectedDurationMs - paired.expectedDurationMs)).toBeLessThanOrEqual(60_000)
})

it('treats computers without speed history as nominal', async () => {
  const { main, paired, mainWork, pairedWork } = await builderPlan()
  expect(Math.abs(mainWork - pairedWork)).toBeLessThanOrEqual(30_000)
  expect(main.speedFactor ?? 1).toBe(1)
  expect(Math.abs(main.expectedDurationMs - paired.expectedDurationMs)).toBeLessThanOrEqual(30_000)
})

it.each([
  { cpuCount: 8, wallTimes: [800_000, 800_000, 800_000, 100_000] },
  { cpuCount: 32, wallTimes: [800_000, 800_000, 800_000, 100_000] },
  { cpuCount: 32, wallTimes: [800_000, 100_000, 100_000, 100_000] },
])('bounds a build part by measured throughput with $cpuCount reported CPUs and $wallTimes history',
  async ({ cpuCount, wallTimes }) => {
  const builder = computers[0]!
  const historyFiles = Array.from({ length: 148 }, (_, index) => `apps/api/test/history-${index}.integration.test.ts`)
  const rows = wallTimes.map(actualMs => ({
    record: gatePart(builder, builder.key, 272_000, actualMs, { files: historyFiles, integrationShards: 12,
      speedFactor: 0.5 }),
    test_results: { summary: { passed: 148, failed: 0, skipped: 0 }, truncated: false,
      files: historyFiles.map(file => ({ file, status: 'passed', durationMs: 20_000, tests: [] })) },
    durations: Object.fromEntries(historyFiles.map(file => [file, 20_000])),
  }))
  const pool = { query: async () => ({ rows }) } as unknown as pg.Pool
  const fleet: HostCiEndpoint = {
    computers: async () => [builder, ...Array.from({ length: 24 }, (_, slot) => ({
      ...computers[3]!, key: `cloud-${slot}`, hostRef: { kind: 'cloud' as const, mainId: 'main',
        provider: 'github' as const, slot },
    }))],
    request: async computer => ({ operation: 'status', ready: true, reasons: [],
      cpuCount: computer.hostRef.kind === 'cloud' ? 4 : cpuCount, memoryBytes: 64 * 2 ** 30,
      slotsUsed: 0, slotsTotal: 1, runs: [] }),
  }
  const speeds = await readExecutorSpeeds(pool, fleet)
  const files = Array.from({ length: 700 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true, commandId: 'throughput' },
    { files, durations: Object.fromEntries(files.map(file => [file, 20_000])) },
    { files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] }, {}, fleet, speeds)
  expect(parts.filter(part => part.suite === 'integration').flatMap(part => part.files).sort())
    .toEqual([...files].sort())
  const host = parts.find(part => part.plannedHostKey === builder.key)!
  const cloudEnd = Math.max(...parts.filter(part => part.plannedHostKey !== builder.key)
    .map(part => part.expectedDurationMs))
  const measuredEnd = host.files.length * 20_000 / (148 * 20_000 / 800_000)
  expect(measuredEnd).toBeLessThanOrEqual(cloudEnd)
  expect(host.expectedDurationMs).toBeGreaterThanOrEqual(measuredEnd)
})

it('uses the same measured file throughput for persisted partition weights', async () => {
  const builder = computers[0]!
  const cloud = computers[3]!
  const files = Array.from({ length: 20 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const queued = [0, 1].map(index => gatePart(builder, builder.key, 100_000, 100_000, {
    gate: false, state: 'queued', computer: null, scope: 'affected', files,
    startedAt: null, finishedAt: null, partition: { index, count: 2 },
  }))
  const history = [builder, cloud].map(computer => ({
    record: gatePart(computer, computer.key, 100_000, 200_000, { files, partition: { index: 0, count: 1 } }),
    test_results: { summary: { passed: 20, failed: 0, skipped: 0 }, truncated: false,
      files: files.map(file => ({ file, status: 'passed', durationMs: computer === builder ? 20_000 : 40_000,
        tests: [] })) },
  }))
  let reads = 0
  const pool = { query: async (_query: string, values?: unknown[]) => {
    reads += 1
    if (reads === 1) return { rows: queued.map(record => ({ record })) }
    if (reads === 2) return { rows: history }
    const plan = JSON.parse(values![0] as string) as { id: string; patch: Partial<CiRunRecord> }[]
    return { rows: plan.map(item => ({ record: { ...queued.find(run => run.id === item.id)!, ...item.patch } })) }
  } } as unknown as pg.Pool
  const fleet: HostCiEndpoint = {
    computers: async () => [builder, cloud],
    request: async computer => ({ operation: 'status', ready: true, reasons: [],
      cpuCount: computer === builder ? 32 : 4, memoryBytes: 64 * 2 ** 30, runs: [] }),
  }
  const planned = await weighCiPartitions(pool, fleet, queued, [builder, cloud],
    async id => queued.find(run => run.id === id)!)
  const host = planned.find(run => run.plannedHostKey === builder.key)!
  const cloudPart = planned.find(run => run.plannedHostKey === cloud.key)!
  const weights = host.partition!.weights!
  expect(weights[host.partition!.index]! / weights[cloudPart.partition!.index]!).toBeCloseTo(0.5)
})

function plannedPartitionFixture() {
  const builder = computers[0]!
  const cloud = computers[3]!
  const files = Array.from({ length: 20 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const queued = [0, 1].map(index => gatePart(builder, builder.key, 100_000, 100_000, {
    gate: false, state: 'queued', computer: null, scope: 'affected', files,
    startedAt: null, finishedAt: null, partition: { index, count: 2 },
  }))
  const history = [{
    record: gatePart(builder, builder.key, 100_000, 200_000, { files, partition: { index: 0, count: 1 } }),
    test_results: { files: files.map(file => ({ file, durationMs: 20_000 })) },
  }]
  let reads = 0
  const pool = { query: async (_query: string, values?: unknown[]) => {
    reads += 1
    if (reads === 1) return { rows: queued.map(record => ({ record })) }
    if (reads === 2) return { rows: history }
    const plan = JSON.parse(values![0] as string) as { id: string; patch: Partial<CiRunRecord> }[]
    return { rows: plan.map(item => ({ record: { ...queued.find(run => run.id === item.id)!, ...item.patch } })) }
  } } as unknown as pg.Pool
  return { builder, cloud, queued, pool }
}

it('plans partition weights after a bounded wait for a Worker whose status is slow', async () => {
  const { builder, cloud, queued, pool } = plannedPartitionFixture()
  const requested: string[] = []
  const snapshot = new CiPlanningSnapshot({
    computers: async () => [builder, cloud],
    request: async computer => {
      requested.push(computer.key)
      return new Promise(() => {})
    },
  })
  snapshot.observeStatus(builder, { operation: 'status', ready: true, reasons: [], cpuCount: 2,
    memoryBytes: 32 * 2 ** 30, slotsUsed: 0, slotsTotal: 1, runs: [] })
  const outcome = await Promise.race([
    weighCiPartitions(pool, snapshot, queued, [builder, cloud], async id => queued.find(run => run.id === id)!),
    // A status read that never answers delays planning by about a second, not indefinitely.
    new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 3000)),
  ])
  expect(outcome).not.toBe('blocked')
  const planned = outcome as CiRunRecord[]
  expect(planned.every(run => run.partition!.weights?.length === 2)).toBe(true)
  expect(requested).toEqual([cloud.key])
})

it('weights a partition from the status dispatch already holds instead of asking the Worker', async () => {
  const { builder, cloud, queued, pool } = plannedPartitionFixture()
  const requested: string[] = []
  const snapshot = new CiPlanningSnapshot({
    computers: async () => [builder, cloud],
    request: async computer => { requested.push(computer.key); throw new Error('unreachable') },
  })
  for (const [computer, cpuCount] of [[builder, 8], [cloud, 4]] as const) {
    snapshot.observeStatus(computer, { operation: 'status', ready: true, reasons: [], cpuCount,
      memoryBytes: 64 * 2 ** 30, slotsUsed: 0, slotsTotal: 1, runs: [] })
  }
  const planned = await weighCiPartitions(pool, snapshot, queued, [builder, cloud],
    async id => queued.find(run => run.id === id)!)
  expect(planned.map(run => run.partition!.weights?.length)).toEqual([2, 2])
  expect(requested).toEqual([])
})

function speedHistoryPool(onLoad: () => void) {
  const builder = computers[0]!
  const files = ['apps/api/test/a.integration.test.ts', 'apps/api/test/b.integration.test.ts']
  const rows = [{
    record: gatePart(builder, builder.key, 100_000, 200_000, { files }),
    // Per-test detail is not needed to measure speed.
    test_results: { files: files.map(file => ({ file, durationMs: 20_000 })) },
  }]
  const pool = { query: async () => { onLoad(); return { rows } } } as unknown as pg.Pool
  const fleet: HostCiEndpoint = { computers: async () => [builder], request: async () => { throw new Error('unused') } }
  return { pool, fleet, builder }
}

it('measures speed from file durations without needing each test case of the historical reports', async () => {
  const { pool, fleet, builder } = speedHistoryPool(() => {})
  expect((await readExecutorSpeeds(pool, fleet)).get(builder.key)).toMatchObject({ throughput: 40_000 / 200_000 })
})

it('reuses one speed estimate between planning passes until a gate ticket finishes', async () => {
  let historyLoads = 0
  const { pool, fleet } = speedHistoryPool(() => { historyLoads += 1 })
  await Promise.all([readExecutorSpeeds(pool, fleet), readExecutorSpeeds(pool, fleet)])
  await readExecutorSpeeds(pool, fleet)
  expect(historyLoads).toBe(1)
  invalidateExecutorSpeeds(fleet)
  await readExecutorSpeeds(pool, fleet)
  expect(historyLoads).toBe(2)
})

it('does not reuse another planner\'s speed estimate from the same database pool', async () => {
  const builder = computers[0]!
  const files = ['apps/api/test/a.integration.test.ts']
  let rows: unknown[] = []
  const pool = { query: async () => ({ rows }) } as unknown as pg.Pool
  const planner = (): HostCiEndpoint => ({ computers: async () => [builder],
    request: async () => { throw new Error('unused') } })
  expect((await readExecutorSpeeds(pool, planner())).get(builder.key)).toBeUndefined()
  rows = [{ record: gatePart(builder, builder.key, 100_000, 200_000, { files }),
    test_results: { files: [{ file: files[0], durationMs: 40_000 }] } }]
  // A new service plans with its own endpoint and measures the history that exists when it starts.
  expect((await readExecutorSpeeds(pool, planner())).get(builder.key)).toMatchObject({ throughput: 40_000 / 200_000 })
})
