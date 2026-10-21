import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { planCiGate } from './gate.js'
import { splitUnavailableGateParts } from './gateFallback.js'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'

const budgetMs = 45 * 60_000
const unit = { files: ['apps/api/src/feature.test.ts', 'apps/web/src/feature.test.ts'], durations: {}, heavy: [] }

function fleet(provider: 'github' | 'circleci'): HostCiEndpoint {
  const github: HostCiComputer = { key: 'github:checks', label: 'GitHub checks', priority: 30,
    hostRef: { kind: 'cloud', mainId: 'fixture', provider: 'github', slot: 20 } }
  const computers: HostCiComputer[] = [
    { key: 'builder', label: 'Builder', priority: 60, hostRef: { kind: 'main', mainId: 'fixture' } },
    ...(provider === 'circleci' ? [github] : []),
    ...Array.from({ length: 14 }, (_, slot) => ({ key: `${provider}:${slot}`, label: `Cloud ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'fixture', provider, slot },
      userSystemd: { supported: true, reason: null } })),
  ]
  return { computers: async () => computers,
    request: async computer => ({ operation: 'status', ready: true, reasons: [], runs: [],
      cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 5, memoryBytes: 16 * 2 ** 30,
      slotsUsed: 0, slotsTotal: 1 }),
  }
}

it.each(['github', 'circleci'] as const)('splits long %s allocations into jobs within 75 percent of the job limit', async provider => {
  const files = Array.from({ length: 901 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 120_000])) }, unit, {}, fleet(provider),
    new Map([[`cloud:${provider}`, 2]]))
  const integration = parts.filter(part => part.suite === 'integration')
  const cloud = integration.filter(part => part.plannedHostKey.startsWith(`${provider}:`))
  expect(cloud.length).toBeGreaterThan(0)
  for (const part of cloud) {
    expect(part.files.length).toBeGreaterThan(0)
    expect(part.expectedDurationMs).toBeLessThanOrEqual(budgetMs)
    // Two CPU lanes per long file, with a separate setup cost for each fresh job.
    expect(part.expectedDurationMs).toBe(2 * (90_000 + Math.ceil(part.files.length / 2) * 120_000))
  }
  expect(cloud.length).toBeGreaterThan(new Set(cloud.map(part => part.plannedHostKey)).size)
  expect(integration.flatMap(part => part.files).sort()).toEqual([...files].sort())
})

it.each(['github', 'circleci'] as const)('keeps a file exceeding the %s job budget on a builder', async provider => {
  const file = 'apps/api/test/long.integration.test.ts'
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true },
    { files: [file], durations: { [file]: 3_600_000 } }, unit, {}, fleet(provider), new Map([['builder', 3]]))
  expect(parts.filter(part => part.suite === 'integration'))
    .toEqual([expect.objectContaining({ plannedHostKey: 'builder', files: [file] })])
})

it('keeps an indivisible check exceeding the cloud job budget on a builder', async () => {
  const file = 'apps/api/test/feature.integration.test.ts'
  const unitFile = 'apps/api/src/long.test.ts'
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true },
    { files: [file], durations: { [file]: 10_000 } },
    { files: [unitFile], durations: { [unitFile]: 3_000_000 }, heavy: [] }, {}, fleet('github'))
  expect(parts.find(part => part.part === 'unit-api')).toMatchObject({ plannedHostKey: 'builder' })
  for (const part of parts.filter(part => part.plannedHostKey.startsWith('github:'))) {
    expect(part.expectedDurationMs).toBeLessThanOrEqual(budgetMs)
  }
})

it('preserves the ticket-count cap while splitting long cloud jobs', async () => {
  const files = Array.from({ length: 901 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 2_400_000])) }, unit, {}, fleet('github'),
    new Map([['builder', 3]]))
  for (const part of parts.filter(part => part.plannedHostKey.startsWith('github:'))) {
    expect(part.expectedDurationMs).toBeLessThanOrEqual(budgetMs)
  }
  expect(parts.length).toBeLessThanOrEqual(256)
  expect(parts.filter(part => part.suite === 'integration').flatMap(part => part.files).sort())
    .toEqual([...files].sort())
})

it.each(['github', 'circleci'] as const)('retains builder ownership when a fallback file exceeds the %s job budget', async provider => {
  const file = 'apps/api/test/long.integration.test.ts'
  const run = CiRunRecordSchema.parse({ id: randomUUID(), groupId: randomUUID(), workspaceId: 'fixture',
    repository: 'fixture/site', commit: 'a'.repeat(40), gate: true, suite: 'integration', scope: 'full',
    files: [file], plannedHostKey: 'builder', state: 'queued', computer: null, step: null, partition: null,
    queuedAt: '2026-01-01T00:00:00Z', startedAt: null, finishedAt: null, exitCode: null, message: null,
    initiator: { principalId: 'operator', executionId: null } })
  const query = async () => ({ rows: [], rowCount: 1 })
  const pool = { connect: async () => ({ query, release: () => undefined }) } as unknown as pg.Pool
  const cloud = (await fleet(provider).computers()).find(computer => computer.hostRef.provider === provider)!
  const parts = await splitUnavailableGateParts(pool, [run], { computers: [cloud],
    shards: new Map([[cloud.key, 4]]), durations: new Map([[run.id, { [file]: 3_600_000 }]]),
    reservedCloud: new Set(), gate: undefined, canTake: () => true, idle: () => true, freeSlots: () => 1 })
  expect(parts).toEqual([run])
})
