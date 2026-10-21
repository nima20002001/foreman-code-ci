import { expect, it } from 'vitest'
import { planCiGate } from './gate.js'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'

function fleet(): HostCiEndpoint {
  const computers: HostCiComputer[] = [
    { key: 'builder', label: 'Build computer', priority: 10, hostRef: { kind: 'main', mainId: 'fixture' } },
    ...Array.from({ length: 14 }, (_, slot) => ({ key: `github:${slot}`, label: `GitHub ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'fixture', provider: 'github' as const, slot },
      userSystemd: { supported: true, reason: null } })),
  ]
  return { computers: async () => computers,
    request: async computer => ({ operation: 'status', ready: true, reasons: [], runs: [],
      cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 5, memoryBytes: 16 * 2 ** 30,
      slotsUsed: 0, slotsTotal: 1 }),
  }
}

const unitFiles = ['apps/api/src', 'apps/web/src'].flatMap((directory, index) =>
  Array.from({ length: index === 0 ? 24 : 8 }, (_, file) => `${directory}/feature-${file}.test.ts`))
const unit = { files: unitFiles, durations: Object.fromEntries(unitFiles.map(file => [file, 50_000])), heavy: [] }

it.each([0, 2])('balances a second integration wave after checks with %i reserved slots', async reserved => {
  const files = Array.from({ length: 901 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 30_000])) }, unit, {}, fleet(), new Map(), reserved)
  const integration = parts.filter(part => part.suite === 'integration')
  const checks = parts.filter(part => part.suite !== 'integration')
  const clouds = integration.filter(part => part.plannedHostKey.startsWith('github:'))
  expect(clouds.map(part => part.plannedHostKey).sort()).toEqual(
    Array.from({ length: 14 - reserved }, (_, slot) => `github:${slot}`).sort())
  expect(integration.some(part => part.plannedHostKey === 'builder')).toBe(true)
  expect(integration.flatMap(part => part.files).sort()).toEqual([...files].sort())
  const ends = integration.map(part => {
    const backlog = checks.filter(check => check.plannedHostKey === part.plannedHostKey)
      .reduce((sum, check) => sum + check.expectedDurationMs, 0)
    if (part.plannedHostKey.startsWith('github:')) expect(backlog).toBeGreaterThan(0)
    // Each integration ticket pays for its own boot; check time belongs only to the earlier tickets.
    expect(part.expectedDurationMs).toBe(90_000 + Math.ceil(part.files.length / part.integrationShards!) * 30_000)
    return backlog + part.expectedDurationMs
  })
  expect(Math.max(...ends) - Math.min(...ends)).toBeLessThanOrEqual(30_000)
  expect(Math.max(...ends)).toBeLessThan((90_000 + Math.ceil(files.length / 5) * 30_000) / 2)
})

it('keeps a small host-only plan that finishes before cloud checks can release an executor', async () => {
  const files = ['apps/api/test/first.integration.test.ts', 'apps/api/test/second.integration.test.ts']
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 10_000])) }, unit, {}, fleet())
  const integration = parts.filter(part => part.suite === 'integration')
  expect(integration).toHaveLength(1)
  expect(integration[0]).toMatchObject({ plannedHostKey: 'builder' })
  expect(integration[0]!.files.sort()).toEqual([...files].sort())
})

it('keeps two concurrent builder files when a second cloud boot would lengthen the gate from 270 to 420 seconds', async () => {
  const computers = (await fleet().computers()).slice(0, 10)
  const endpoint: HostCiEndpoint = { computers: async () => computers,
    request: async () => ({ operation: 'status', ready: true, reasons: [], runs: [],
      cpuCount: 4, memoryBytes: 16 * 2 ** 30, slotsUsed: 0, slotsTotal: 1 }),
  }
  const files = ['apps/api/test/first.integration.test.ts', 'apps/api/test/second.integration.test.ts']
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 180_000])) },
    { files: ['apps/api/src/feature.test.ts', 'apps/web/src/feature.test.ts'], durations: {}, heavy: [] }, {}, endpoint)
  const checks = parts.filter(part => part.suite !== 'integration')
  expect(checks).toHaveLength(9)
  expect(new Set(checks.map(part => part.plannedHostKey)).size).toBe(9)
  const ends = computers.map(computer => parts.filter(part => part.plannedHostKey === computer.key)
    .reduce((sum, part) => sum + part.expectedDurationMs, 0))
  expect(Math.max(...ends)).toBe(270_000)
  const integration = parts.filter(part => part.suite === 'integration')
  expect(integration).toHaveLength(1)
  expect(integration[0]).toMatchObject({ plannedHostKey: 'builder', expectedDurationMs: 270_000 })
  expect(integration[0]!.files.sort()).toEqual([...files].sort())
})

it('revisits an earlier builder after a later builder stops determining the critical path', async () => {
  const computers: HostCiComputer[] = [
    { key: 'builder-first', label: 'First builder', priority: 10,
      hostRef: { kind: 'main', mainId: 'fixture' } },
    { key: 'builder-second', label: 'Second builder', priority: 10,
      hostRef: { kind: 'device', mainId: 'fixture', deviceId: 'paired-fixture' } },
    ...(await fleet().computers()).slice(1, 10),
  ]
  const endpoint: HostCiEndpoint = { computers: async () => computers,
    request: async computer => ({ operation: 'status', ready: true, reasons: [], runs: [],
      cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 8, memoryBytes: 16 * 2 ** 30,
      slotsUsed: 0, slotsTotal: 1 }),
  }
  const files = Array.from({ length: 8 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  // Both builders initially take four files: typical time 150s, conservative times 600s and 660s.
  const speeds = new Map([
    ['builder-first', { factor: 1, throughput: 2, conservativeThroughput: 0.4 }],
    ['builder-second', { factor: 1, throughput: 2, conservativeThroughput: 4 / 11 }],
  ])
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 60_000])) },
    { files: ['apps/api/src/feature.test.ts', 'apps/web/src/feature.test.ts'], durations: {}, heavy: [] },
    {}, endpoint, speeds)
  const ends = computers.map(computer => parts.filter(part => part.plannedHostKey === computer.key)
    .reduce((sum, part) => sum + part.expectedDurationMs, 0))
  expect(Math.max(...ends)).toBe(300_000)
  const integration = parts.filter(part => part.suite === 'integration')
  expect(integration.flatMap(part => part.files).sort()).toEqual([...files].sort())
  expect(integration.find(part => part.plannedHostKey === 'builder-first'))
    .toMatchObject({ expectedDurationMs: 300_000 })
  expect(integration.find(part => part.plannedHostKey === 'builder-second'))
    .toMatchObject({ expectedDurationMs: 165_000 })
})
