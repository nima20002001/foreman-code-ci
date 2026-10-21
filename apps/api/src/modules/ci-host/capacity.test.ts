import { expect, it } from 'vitest'
import { gateIntegrationShards, hostCiCapacity } from './capacity.js'

const machine = { cpuCount: 16, memoryBytes: 32 * 2 ** 30, availableMemoryBytes: 24 * 2 ** 30 }

it('budgets two slots on a sixteen-core computer and accounts for existing reservations', () => {
  const first = hostCiCapacity(machine)
  expect(first).toMatchObject({ slotsUsed: 0, slotsTotal: 2, cpuCount: 8, memoryBytes: 12 * 2 ** 30 })
  const second = hostCiCapacity(machine, [first])
  expect(second).toMatchObject({ slotsUsed: 1, slotsTotal: 2, cpuCount: 8 })
  expect(hostCiCapacity(machine, [first, second])).toMatchObject({ slotsUsed: 2, slotsTotal: 2 })
})

it('bounds slots by available memory and keeps one slot for a small computer', () => {
  for (const cpuCount of [16, 24]) {
    expect(hostCiCapacity({ ...machine, cpuCount, availableMemoryBytes: 7 * 2 ** 30 }))
      .toMatchObject({ slotsTotal: 1, memoryBytes: 7 * 2 ** 30 })
  }
  expect(hostCiCapacity({ cpuCount: 2, memoryBytes: 4 * 2 ** 30, availableMemoryBytes: 2 * 2 ** 30 }))
    .toMatchObject({ slotsTotal: 1, slotsUsed: 0, cpuCount: 2, memoryBytes: 2 * 2 ** 30 })
})

it('advertises no slot when not even one gibibyte of memory is free', () => {
  expect(hostCiCapacity({ ...machine, availableMemoryBytes: 0 }))
    .toMatchObject({ slotsTotal: 0, slotsUsed: 0, memoryBytes: 0 })
  expect(hostCiCapacity({ cpuCount: 4, memoryBytes: 2 ** 30, availableMemoryBytes: 2 ** 30 }))
    .toMatchObject({ slotsTotal: 0, slotsUsed: 0, memoryBytes: 0 })
})

it('waits for memory pressure to clear and does not overbook a whole-machine reservation', () => {
  const first = hostCiCapacity(machine)
  expect(hostCiCapacity({ ...machine, availableMemoryBytes: 2 * 2 ** 30 }, [first]))
    .toMatchObject({ slotsTotal: 1, slotsUsed: 1 })
  expect(hostCiCapacity(machine, [{ cpuCount: machine.cpuCount, memoryBytes: machine.memoryBytes }]))
    .toMatchObject({ slotsTotal: 1, slotsUsed: 1 })
})

it('does not reserve memory twice when a running job has not consumed its full allowance', () => {
  const measured = { ...machine, availableMemoryBytes: 12 * 2 ** 30 }
  const first = hostCiCapacity(measured)
  const second = hostCiCapacity(measured, [first])
  expect(first.memoryBytes + second.memoryBytes).toBeLessThanOrEqual(measured.availableMemoryBytes)
  expect(second).toMatchObject({ slotsUsed: 1, slotsTotal: 2, memoryBytes: 6 * 2 ** 30 })
})

it.each([
  [16, 14, 8],
  [4, 8, 4],
  [32, 3, 1],
  [128, 128, 64],
])('limits %i logical CPUs and %i GiB to %i integration shards', (cpuCount, memoryGiB, shards) => {
  expect(gateIntegrationShards(cpuCount, memoryGiB * 2 ** 30)).toBe(shards)
})

it('limits a sixteen-CPU host with 4.4 GiB of slot memory to two integration shards', () => {
  expect(gateIntegrationShards(16, Math.floor(4.4 * 2 ** 30))).toBe(2)
})
