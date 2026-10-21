import { expect, it } from 'vitest'
import { sourceStorageCapacityFixture } from '../../../test/helpers/sourceStorageCapacityFixture.js'
import { sourceStorageLimits, SOURCE_AGGREGATE_LIMITS } from './storageCapacity.js'

it('bounds active worktrees by CPU and new preparations by available memory', () => {
  const limits = sourceStorageLimits(sourceStorageCapacityFixture({ totalBytes: 64 * 2 ** 30,
    availableBytes: 32 * 2 ** 30, cpuCount: 8, availableMemoryBytes: 16 * 2 ** 30 }))
  expect(limits.bytes).toBe(16 * 2 ** 30)
  expect(limits.availableBytes).toBe(32 * 2 ** 30 - Math.ceil(32 * 2 ** 30 * 0.1))
  expect(limits.materializations).toBe(16)
  expect(limits.preparing).toBe(16)
})

it('leaves disk and memory headroom and admits no work when either resource is exhausted', () => {
  const memory = sourceStorageLimits(sourceStorageCapacityFixture({ availableMemoryBytes: 2 ** 30 }))
  expect(memory.materializations).toBe(2)
  expect(memory.preparing).toBe(0)
  const disk = sourceStorageLimits(sourceStorageCapacityFixture({ availableBytes: 512 * 2 ** 20 }))
  expect(disk.availableBytes).toBe(0)
})

it('caps large machines and preserves memory headroom for new preparations', () => {
  const maximum = sourceStorageLimits(sourceStorageCapacityFixture({ totalBytes: 1024 * 2 ** 30,
    availableBytes: 512 * 2 ** 30, cpuCount: 256, availableMemoryBytes: 256 * 2 ** 30 }))
  expect(maximum.bytes).toBe(SOURCE_AGGREGATE_LIMITS.bytes)
  expect(maximum.materializations).toBe(SOURCE_AGGREGATE_LIMITS.materializations)
  expect(maximum.preparing).toBe(SOURCE_AGGREGATE_LIMITS.preparing)
  expect(sourceStorageLimits(sourceStorageCapacityFixture({ cpuCount: 2 })).materializations).toBe(4)
  const memory = sourceStorageLimits(sourceStorageCapacityFixture({ cpuCount: 16,
    availableMemoryBytes: 2 * 2 ** 30 }))
  expect(memory.materializations).toBe(32)
  expect(memory.preparing).toBe(2)
})

it('admits one new preparation with memory headroom even while other worktrees are active', () => {
  const limits = sourceStorageLimits(sourceStorageCapacityFixture({ cpuCount: 6,
    availableMemoryBytes: 1536 * 2 ** 20 }))
  expect(limits.materializations).toBe(12)
  expect(limits.preparing).toBe(1)
})
