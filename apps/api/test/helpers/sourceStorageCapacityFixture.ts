import type { SourceStorageCapacity } from '@foreman-code/contracts/source-operations'

export function sourceStorageCapacityFixture(overrides: Partial<SourceStorageCapacity> = {}): SourceStorageCapacity {
  return {
    filesystem: { device: '1', inode: '2', mountId: '3' },
    totalBytes: 4 * 2 ** 30,
    availableBytes: 4 * 2 ** 30,
    cpuCount: 1,
    availableMemoryBytes: 4 * 2 ** 30,
    observedAt: new Date().toISOString(),
    ...overrides,
  }
}
