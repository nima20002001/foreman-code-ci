import { setImmediate as nextTurn } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { planCiGate } from './gate.js'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'

function fleet(): HostCiComputer[] {
  return [
    { key: 'builder', label: 'Builder', priority: 60, hostRef: { kind: 'main', mainId: 'fixture' } },
    ...(['github', 'circleci'] as const).flatMap(provider =>
      Array.from({ length: provider === 'github' ? 14 : 90 }, (_, slot) => ({
        key: `${provider}:${slot}`, label: `${provider} ${slot}`, priority: 30,
        hostRef: { kind: 'cloud' as const, mainId: 'fixture', provider, slot },
        userSystemd: { supported: true, reason: null },
      }))),
  ]
}

const files = Array.from({ length: 901 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
const inventory = { files, durations: Object.fromEntries(files.map(file => [file, 120_000])) }
const unit = { files: ['apps/api/src/site.test.ts', 'apps/web/src/site.test.ts'], durations: {}, heavy: [] }

it('bounds status requests and splits a large gate across cloud executors', async () => {
  let active = 0
  let peak = 0
  const endpoint: HostCiEndpoint = {
    computers: async () => fleet(),
    request: async computer => {
      active++
      peak = Math.max(peak, active)
      await nextTurn()
      active--
      return { operation: 'status', ready: true, reasons: [], runs: [], slotsUsed: 0, slotsTotal: 1,
        cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 16, memoryBytes: 16 * 2 ** 30 }
    },
  }
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true }, inventory, unit, {}, endpoint)
  expect(peak).toBeLessThanOrEqual(8)
  const integration = parts.filter(part => part.suite === 'integration')
  expect(integration.filter(part => part.plannedHostKey.startsWith('circleci:')).length).toBeGreaterThan(1)
  expect(integration.flatMap(part => part.files).sort()).toEqual([...files].sort())
  expect(new Set(parts.map(part => part.plannedHostKey)).size).toBe(parts.length)
})

it.each(['all', 'one'])('refuses to persist a degraded gate when %s CircleCI status reads fail', async failure => {
  const endpoint: HostCiEndpoint = {
    computers: async () => fleet(),
    request: async computer => {
      if (computer.hostRef.provider === 'circleci' && (failure === 'all' || computer.hostRef.slot === 0)) {
        throw new Error('timeout exceeded when trying to connect')
      }
      return { operation: 'status', ready: true, reasons: [], runs: [], slotsUsed: 0, slotsTotal: 1,
        cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 16, memoryBytes: 16 * 2 ** 30 }
    },
  }
  await expect(planCiGate({ suite: 'integration', scope: 'full', gate: true }, inventory, unit, {}, endpoint))
    .rejects.toMatchObject({ code: 'CI_GATE_CAPACITY_REQUIRED', details: { retryable: true } })
})
