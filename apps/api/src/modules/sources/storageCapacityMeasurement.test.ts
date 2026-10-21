import { afterEach, expect, it, vi } from 'vitest'
import { withPrivateFixtureDirectories, privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { readSourceStorageCapacity, sourceStorageLimits } from './storageCapacity.js'

const memory = vi.hoisted(() => ({ inactiveFileBytes: 2 ** 30, unavailable: false, legacy: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const [path] = args
      if (path === '/proc/meminfo') return 'MemAvailable: 8388608 kB\n'
      if (path === '/proc/self/cgroup') return memory.legacy ? '5:memory:/fixture\n' : '0::/fixture\n'
      if (path === '/sys/fs/cgroup/fixture/memory.stat' || path === '/sys/fs/cgroup/memory/fixture/memory.stat') {
        if (memory.unavailable) throw Object.assign(new Error('Unavailable accounting'), { code: 'ENOENT' })
        return `${memory.legacy ? 'total_inactive_file' : 'inactive_file'} ${memory.inactiveFileBytes}\n`
      }
      return actual.readFile(...args)
    },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  memory.inactiveFileBytes = 2 ** 30
  memory.unavailable = false
  memory.legacy = false
})

it.each([false, true])('admits source work using reclaimable file cache (legacy: %s)', async legacy => {
  memory.legacy = legacy
  vi.spyOn(process, 'constrainedMemory').mockReturnValue(3 * 2 ** 30)
  vi.spyOn(process, 'availableMemory').mockReturnValue(1500 * 2 ** 20)
  await withPrivateFixtureDirectories(async () => {
    const root = await privateFixtureDirectory('source-capacity-')
    const capacity = await readSourceStorageCapacity(root)
    expect(capacity.availableMemoryBytes).toBe(1500 * 2 ** 20 + 2 ** 30)
    expect(sourceStorageLimits(capacity).preparing).toBeGreaterThan(0)
    expect(sourceStorageLimits(capacity).materializations).toBeGreaterThanOrEqual(2)
  })
})

it.each([
  { name: 'cgroup limit', limit: 2 * 2 ** 30, expected: 2 * 2 ** 30 },
  { name: 'host availability', limit: 16 * 2 ** 30, expected: 8 * 2 ** 30 },
])('caps reclaimable memory at $name', async ({ limit, expected }) => {
  memory.inactiveFileBytes = 16 * 2 ** 30
  vi.spyOn(process, 'constrainedMemory').mockReturnValue(limit)
  vi.spyOn(process, 'availableMemory').mockReturnValue(2 ** 30)
  await withPrivateFixtureDirectories(async () => {
    const root = await privateFixtureDirectory('source-capacity-')
    expect((await readSourceStorageCapacity(root)).availableMemoryBytes).toBe(expected)
  })
})

it.each([false, true])('preserves low-memory rejection when cache is absent or unreadable (%s)', async unavailable => {
  memory.inactiveFileBytes = 0
  memory.unavailable = unavailable
  vi.spyOn(process, 'constrainedMemory').mockReturnValue(3 * 2 ** 30)
  vi.spyOn(process, 'availableMemory').mockReturnValue(2 ** 30)
  await withPrivateFixtureDirectories(async () => {
    const root = await privateFixtureDirectory('source-capacity-')
    const capacity = await readSourceStorageCapacity(root)
    expect(capacity.availableMemoryBytes).toBe(2 ** 30)
    expect(sourceStorageLimits(capacity).preparing).toBe(0)
    expect(sourceStorageLimits(capacity).materializations).toBe(Math.min(64, capacity.cpuCount * 2))
  })
})
