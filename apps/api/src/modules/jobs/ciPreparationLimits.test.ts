import { describe, expect, it, vi } from 'vitest'
import { ciPreparationBuildArgs, ciPreparationLimits } from './ciPreparationLimits.js'

vi.mock('node:os', () => ({ availableParallelism: () => 7, totalmem: () => 8 * 2 ** 30 }))

describe('CI preparation resource limits', () => {
  it('uses half the available CPUs and memory with explicit build limits', () => {
    const limits = ciPreparationLimits()
    expect(limits).toEqual({ cpuCount: 3.5, memoryBytes: 4 * 2 ** 30 })
    expect(ciPreparationBuildArgs(limits)).toEqual(['--jobs=1', '--cpu-period=100000', '--cpu-quota=350000',
      '--memory=4294967296', '--memory-swap=4294967296'])
  })
  it('caps a single CPU at half a CPU rather than rounding up', () => {
    expect(ciPreparationBuildArgs({ cpuCount: 0.5, memoryBytes: 1024 * 1024 }))
      .toContain('--cpu-quota=50000')
  })
})
