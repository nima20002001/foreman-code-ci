import { expect, it } from 'vitest'
import { buildComputerIntegrationShards, gateIntegrationShards } from '../src/modules/ci-host/capacity.js'

it.each([
  { cpuCount: 16, memoryGiB: 14, allowance: 100, shards: 7 },
  { cpuCount: 16, memoryGiB: 16, allowance: 100, shards: 8 },
  { cpuCount: 16, memoryGiB: 16, allowance: 50, shards: 4 },
  { cpuCount: 8, memoryGiB: 8, allowance: 100, shards: 4 },
])('sizes $cpuCount CPUs and $memoryGiB GiB at $allowance percent to $shards shards',
  ({ cpuCount, memoryGiB, allowance, shards }) => {
    expect(buildComputerIntegrationShards({ cpuCount, memoryBytes: memoryGiB * 2 ** 30 }, allowance))
      .toBe(shards)
  })

it.each([
  [3.9, 1],
  [4, 2],
  [4.5, 2],
  [5.49, 2],
  [5.5, 3],
])('reserves shared memory and rounds a %s GiB shard budget down to %i shards', (memoryGiB, shards) => {
  expect(gateIntegrationShards(16, memoryGiB * 2 ** 30)).toBe(shards)
})
