import { expect, it } from 'vitest'
import { userSystemdIntegrationFiles, type CiRunInput, type CiRunRecord } from '@foreman-code/contracts'
import { gatePartStealer, planCiGate } from './gate.js'
import type { HostCiComputer, HostCiEndpoint } from './service.js'

function fleet(clouds: number, unavailable?: string): HostCiEndpoint {
  const computers: HostCiComputer[] = [
    { key: 'builder-main', label: 'Main builder', priority: 60, hostRef: { kind: 'main', mainId: 'main' } },
    { key: 'builder-paired', label: 'Paired builder', priority: 50,
      hostRef: { kind: 'device', mainId: 'main', deviceId: 'paired' } },
    ...Array.from({ length: clouds }, (_, slot) => ({ key: `cloud-${slot}`, label: `Cloud ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'main', provider: 'github' as const, slot },
      userSystemd: { supported: true, reason: null } })),
  ]
  return {
    computers: async () => computers,
    request: async computer => {
      if (computer.key === 'builder-paired' && unavailable) {
        if (unavailable !== 'not-ready') throw new Error(unavailable)
        return { operation: 'status', ready: false, reasons: ['Builds unavailable'],
          cpuCount: 16, memoryBytes: 32 * 2 ** 30, runs: [] }
      }
      return { operation: 'status', ready: true, reasons: [],
        cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 16, memoryBytes: 32 * 2 ** 30,
        slotsUsed: 0, slotsTotal: computer.hostRef.kind === 'cloud' ? 1 : 2, runs: [] }
    },
  }
}

it.each(['not-ready', 'offline', 'extension-rejected'])('excludes a %s build computer from a requested gate',
  async unavailable => {
    const files = Array.from({ length: 48 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
    const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true, commandId: 'gate' },
      { files, durations: Object.fromEntries(files.map(file => [file, 120_000])) },
      { files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] }, {}, fleet(2, unavailable))
    expect(parts.some(part => part.plannedHostKey === 'builder-paired')).toBe(false)
    expect(parts.some(part => part.plannedHostKey === 'builder-main')).toBe(true)
    expect(parts.filter(part => part.suite === 'integration').flatMap(part => part.files).sort())
      .toEqual([...files].sort())
  })

it.each([1, 2])('excludes a builder with %i occupied slots from gate planning', async slotsUsed => {
  const base = fleet(24)
  const endpoint: HostCiEndpoint = {
    computers: base.computers,
    request: async (computer, request) => {
      const response = await base.request(computer, request)
      return response.operation === 'status' && computer.key === 'builder-main'
        ? { ...response, slotsUsed } : response
    },
  }
  const files = Array.from({ length: 48 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 120_000])) },
    { files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] }, {}, endpoint)
  expect(parts.some(part => part.plannedHostKey === 'builder-main')).toBe(false)
  expect(parts.some(part => part.plannedHostKey === 'builder-paired')).toBe(true)
  expect(parts.filter(part => part.suite === 'integration').flatMap(part => part.files).sort()).toEqual([...files].sort())
})

it.each([
  { source: 'runner', clouds: 2 },
  { source: 'persisted', clouds: 2 },
  { source: 'runner', clouds: 24 },
  { source: 'persisted', clouds: 24 },
])('falls back to an occupied builder for files without a free executor ($source, $clouds clouds)',
  async ({ source, clouds }) => {
    const base = fleet(clouds, 'not-ready')
    const computers = await base.computers()
    for (const computer of computers.filter(item => item.hostRef.kind === 'cloud')) {
      computer.userSystemd = { supported: false, reason: 'User systemd unavailable' }
    }
    const endpoint: HostCiEndpoint = {
      computers: async () => computers,
      request: async (computer, request) => {
        const response = await base.request(computer, request)
        return response.operation === 'status' && computer.key === 'builder-main' && source === 'runner'
          ? { ...response, slotsUsed: 1 } : response
      },
    }
    const hostFile = [...userSystemdIntegrationFiles][0]!
    const ordinaryFile = 'apps/api/test/feature.integration.test.ts'
    const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true },
      { files: [hostFile, ordinaryFile], durations: {} },
      { files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] }, {}, endpoint,
      new Map(), 0, undefined, new Map(source === 'persisted' ? [['builder-main', 1]] : []))
    const integration = parts.filter(part => part.suite === 'integration')
    expect(integration.find(part => part.files.includes(hostFile)))
      .toMatchObject({ plannedHostKey: 'builder-main', requiresBuildComputer: true })
    expect(integration.find(part => part.files.includes(ordinaryFile))?.plannedHostKey)
      .toMatch(clouds === 2 ? /^builder-main$/ : /^cloud-/)
    expect(integration.flatMap(part => part.files).sort()).toEqual([hostFile, ordinaryFile].sort())
  })

it('plans a production-sized gate within a second', async () => {
  const files = Array.from({ length: 800 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const input: CiRunInput = { suite: 'integration', scope: 'full', gate: true, commandId: 'gate' }
  const started = Date.now()
  const parts = await planCiGate(input,
    { files, durations: Object.fromEntries(files.map((file, index) => [file, 5_000 + (index % 40) * 3_000])) },
    { files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] }, {}, fleet(44))
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(parts.filter(part => part.suite === 'integration').flatMap(part => part.files).sort()).toEqual([...files].sort())
})

it('splits heavy measured unit inventories and retains their estimates in the gate', async () => {
  const files = ['apps/api/src', 'apps/web/src'].flatMap(directory =>
    Array.from({ length: 9 }, (_, index) => `${directory}/feature-${index}.test.ts`))
  const durations = Object.fromEntries(files.map(file => [file, 90_000]))
  const integrationFiles = Array.from({ length: 48 }, (_, index) =>
    `apps/api/test/feature-${index}.integration.test.ts`)
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true },
    { files: integrationFiles, durations: Object.fromEntries(integrationFiles.map(file => [file, 120_000])) },
    { files, durations, heavy: [] }, durations, fleet(44))
  const integrationTarget = Math.max(...parts.filter(part => part.suite === 'integration')
    .map(part => part.expectedDurationMs))
  for (const name of ['unit-api', 'unit-web']) {
    const unit = parts.filter(part => part.part === name)
    expect(unit).toHaveLength(9)
    expect(unit.every(part => part.expectedDurationMs === 180_000)).toBe(true)
    expect(unit.every(part => part.expectedDurationMs <= integrationTarget)).toBe(true)
  }
})

it.each([80_000, 120_000])('balances %i ms integration files against cloud checks', async durationMs => {
  const computers: HostCiComputer[] = [
    { key: 'builder-main', label: 'Main builder', priority: 60, hostRef: { kind: 'main', mainId: 'main' } },
    { key: 'builder-paired', label: 'Paired builder', priority: 50,
      hostRef: { kind: 'device', mainId: 'main', deviceId: 'paired' } },
    ...Array.from({ length: 24 }, (_, slot) => ({ key: `cloud-${slot}`, label: `Cloud ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'main', provider: 'github' as const, slot },
      userSystemd: { supported: true, reason: null } })),
  ]
  const endpoint: HostCiEndpoint = {
    computers: async () => computers,
    request: async computer => ({ operation: 'status', ready: true, reasons: [],
      cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 16, memoryBytes: 32 * 2 ** 30,
      slotsUsed: 0, slotsTotal: computer.hostRef.kind === 'cloud' ? 1 : 2, runs: [] }),
  }
  const files = Array.from({ length: 48 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const input: CiRunInput = { suite: 'integration', scope: 'full', gate: true, commandId: 'gate' }
  const parts = await planCiGate(input, { files, durations: Object.fromEntries(files.map(file => [file, durationMs])) },
    { files: ['apps/api/src/site.test.ts', 'apps/web/src/site.test.tsx'], durations: {}, heavy: [] }, {}, endpoint)
  const integration = parts.filter(part => part.suite === 'integration')
  expect(integration.flatMap(part => part.files).sort()).toEqual([...files].sort())
  expect(integration.filter(part => part.plannedHostKey.startsWith('builder-'))).toHaveLength(2)
  const checks = parts.filter(part => part.suite !== 'integration')
  expect(checks).toHaveLength(9)
  expect(integration).toHaveLength(17)
  for (const part of integration) {
    const cpuSlots = part.plannedHostKey.startsWith('builder-') ? 16 : 4
    expect(part.integrationShards).toBe(cpuSlots)
    const concurrentFiles = cpuSlots / 2
    expect(part.expectedDurationMs).toBe(90_000 + Math.ceil(part.files.length / concurrentFiles) * durationMs)
  }
  const integrationTimes = integration.map(part => part.expectedDurationMs)
  expect(Math.max(...integrationTimes) - Math.min(...integrationTimes)).toBeLessThanOrEqual(durationMs)
  const times = new Map<string, number>()
  for (const part of parts) {
    times.set(part.plannedHostKey, (times.get(part.plannedHostKey) ?? 0) + part.expectedDurationMs)
  }
  expect(times.size).toBe(parts.length)
  // Heavy files reserve two CPU slots; check executors cannot also run integration in this wave.
  const concurrentFiles = 2 * (16 / 2) + (24 - checks.length) * (4 / 2)
  const integrationWaves = Math.ceil(files.length / concurrentFiles)
  const maxGateDurationMs = Math.max(210_000, 90_000 + integrationWaves * durationMs)
  expect(Math.max(...times.values())).toBeLessThanOrEqual(maxGateDurationMs)
})

it('lets a build computer without a queued gate part take cloud parts and another build computer integration part', () => {
  const host: HostCiComputer = { key: 'builder-main', label: 'Main builder', priority: 60, hostRef: { kind: 'main', mainId: 'main' } }
  const paired: HostCiComputer = { key: 'builder-paired', label: 'Paired builder', priority: 50,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'paired' } }
  const cloud: HostCiComputer = { key: 'cloud-0', label: 'Cloud 0', priority: 30,
    hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 0 } }
  const part = (plannedHostKey: string, suite: 'integration' | 'unit' = 'integration') =>
    ({ gate: true, suite, plannedHostKey }) as unknown as CiRunRecord
  const queued = [part('cloud-0'), part('builder-paired'), part('cloud-0', 'unit')]
  const steals = gatePartStealer([host, paired, cloud], queued)
  expect(steals(queued[0]!, host)).toBe(true)
  expect(steals(queued[0]!, paired)).toBe(false)
  expect(steals(queued[0]!, cloud)).toBe(false)
  expect(steals(queued[2]!, host)).toBe(true)
  expect(steals(queued[1]!, host)).toBe(true)
  expect(steals(queued[1]!, paired)).toBe(false)
  expect(steals(queued[1]!, cloud)).toBe(false)
  expect(steals(part('builder-paired', 'unit'), host)).toBe(false)
})

it.each([
  [16, 14, 50, 3, 4],
  [32, 4, 50, 1, 1],
])('plans gate shards within the saved CPU and memory allowance', async (cpuCount, memoryGiB, allowance, shards, cloudShards) => {
  const endpoint = fleet(24)
  const computers = await endpoint.computers()
  for (const computer of computers.filter(computer => computer.hostRef.kind !== 'cloud')) {
    Object.assign(computer, { buildAllowancePercent: allowance })
  }
  const files = Array.from({ length: 96 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true, commandId: 'gate' },
    { files, durations: Object.fromEntries(files.map(file => [file, 120_000])) },
    { files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] }, {}, {
      computers: async () => computers,
      request: async computer => ({ operation: 'status', ready: true, reasons: [],
        cpuCount: computer.hostRef.kind === 'cloud' ? 4 : cpuCount,
        memoryBytes: memoryGiB * 2 ** 30, runs: [] }),
    })
  const hosts = parts.filter(part => part.suite === 'integration' && part.plannedHostKey.startsWith('builder-'))
  expect(hosts).toHaveLength(2)
  for (const host of hosts) expect(host.integrationShards).toBe(shards)
  const clouds = parts.filter(part => part.suite === 'integration' && part.plannedHostKey.startsWith('cloud-'))
  expect(clouds.length).toBeGreaterThan(0)
  for (const cloud of clouds) expect(cloud.integrationShards).toBe(cloudShards)
  expect(parts.filter(part => part.suite === 'integration').flatMap(part => part.files).sort()).toEqual([...files].sort())
})

it.each([2, 10])('bounds gate unit shards by %i free cloud slots', async slots => {
  const files = Array.from({ length: 30 }, (_, index) => `apps/api/src/feature-${index}.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 30_000]))
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true, commandId: 'unit-capacity' },
    { files: ['apps/api/test/feature.integration.test.ts'], durations: {} },
    { files, durations, heavy: [] }, durations, fleet(slots))
  expect(parts.filter(part => part.part === 'unit-api')).toHaveLength(Math.min(6, slots))
  expect(parts.filter(part => part.part === 'unit-web-heavy')).toHaveLength(2)
  expect(parts.filter(part => part.part === 'unit-other')).toHaveLength(1)
})

it.each([
  { reportedSlots: 8, expectedShards: 3 },
  { reportedSlots: 2, expectedShards: 2 },
])('keeps reserved slots out of gate unit sizing with $reportedSlots reported free slots',
  async ({ reportedSlots, expectedShards }) => {
    const files = Array.from({ length: 12 }, (_, index) => `apps/api/src/feature-${index}.test.ts`)
    const durations = Object.fromEntries(files.map(file => [file, 150_000]))
    const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true, commandId: 'reserved-unit-capacity' },
      { files: ['apps/api/test/feature.integration.test.ts'], durations: {} },
      { files, durations, heavy: [] }, durations, fleet(4), new Map(), 1, reportedSlots)
    expect(parts.filter(part => part.part === 'unit-api')).toHaveLength(expectedShards)
  })

it('plans one gate part per cloud executor so no part waits behind another on the same slot', async () => {
  const files = Array.from({ length: 400 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const unit = Array.from({ length: 30 }, (_, index) => `apps/api/src/feature-${index}.test.ts`)
  const unitDurations = Object.fromEntries(unit.map(file => [file, 30_000]))
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true, commandId: 'one-wave' },
    { files, durations: Object.fromEntries(files.map((file, index) => [file, 20_000 + (index % 10) * 20_000])) },
    { files: unit, durations: unitDurations, heavy: [] }, unitDurations, fleet(24), new Map(), 2)
  const clouds = parts.filter(part => part.plannedHostKey.startsWith('cloud-'))
  expect(clouds.some(part => part.suite !== 'integration')).toBe(true)
  const perCloud = new Map<string, number>()
  for (const part of clouds) perCloud.set(part.plannedHostKey, (perCloud.get(part.plannedHostKey) ?? 0) + 1)
  expect([...perCloud.values()].every(count => count === 1)).toBe(true)
  expect(parts.length).toBeLessThanOrEqual(2 + 24 - 2)
  expect(parts.filter(part => part.suite === 'integration').flatMap(part => part.files).sort()).toEqual([...files].sort())
  const ends = parts.filter(part => part.suite === 'integration').map(part => part.expectedDurationMs)
  expect(Math.max(...ends) - Math.min(...ends)).toBeLessThanOrEqual(200_000)
})

it.each([
  { durationMs: 30_000, heavyFiles: [
    'apps/api/test/harness-installation-update-rollback.integration.test.ts',
    'apps/api/test/remote-review-production-defaults.integration.test.ts',
  ] },
  { durationMs: 120_000, heavyFiles: [
    'apps/api/test/slow-first.integration.test.ts',
    'apps/api/test/slow-second.integration.test.ts',
  ] },
])('budgets two CPU slots per heavy file before an exclusive recovery at $durationMs ms',
  async ({ durationMs, heavyFiles }) => {
    const files = [...heavyFiles, 'apps/api/test/remote-review-production-worker-crash.integration.test.ts']
    const base = fleet(2, 'not-ready')
    const endpoint: HostCiEndpoint = {
      computers: base.computers,
      request: async (computer, request) => {
        const response = await base.request(computer, request)
        return response.operation === 'status' && computer.hostRef.kind !== 'cloud'
          ? { ...response, cpuCount: 2 } : response
      },
    }
    const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true, commandId: 'recovery-budget' },
      { files, durations: { [files[0]!]: durationMs, [files[1]!]: durationMs, [files[2]!]: 81_000 } },
      { files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] }, {}, endpoint)
    const integration = parts.filter(part => part.suite === 'integration')
    expect(integration).toHaveLength(1)
    expect(integration[0]!.files.slice().sort()).toEqual(files.slice().sort())
    expect(integration[0]).toMatchObject({ integrationShards: 2,
      expectedDurationMs: 90_000 + 2 * durationMs + 81_000 })
  })
