import { readFile, statfs } from 'node:fs/promises'
import { availableParallelism, freemem } from 'node:os'
import { join } from 'node:path'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import { SourceStorageCapacitySchema, type SourceStorageCapacity } from '@foreman-code/contracts/source-operations'
import { DomainError } from '../errors.js'
import { anchored, identity, openPrivateRoot } from './privateFilesystem.js'

const GIB = 2 ** 30
export const SOURCE_AGGREGATE_LIMITS = Object.freeze({ bytes: 64 * GIB, preparing: 32, materializations: 64 })

export function sourceStorageLimits(capacity: SourceStorageCapacity) {
  const diskMargin = Math.max(GIB, Math.ceil(capacity.availableBytes * 0.1))
  const memoryMargin = Math.max(GIB, Math.ceil(capacity.availableMemoryBytes * 0.25))
  const memorySlots = Math.floor(Math.max(0, capacity.availableMemoryBytes - memoryMargin) / (512 * 2 ** 20))
  // Available memory already excludes resident executions; it bounds new preparations, not active worktrees.
  const materializations = Math.min(SOURCE_AGGREGATE_LIMITS.materializations, capacity.cpuCount * 2)
  return {
    bytes: Math.min(SOURCE_AGGREGATE_LIMITS.bytes, Math.floor(capacity.totalBytes * 0.25)),
    availableBytes: Math.max(0, capacity.availableBytes - diskMargin),
    preparing: Math.min(SOURCE_AGGREGATE_LIMITS.preparing, materializations, memorySlots),
    materializations,
  }
}

async function reclaimableCgroupMemory(): Promise<number> {
  try {
    const membership = await readFile('/proc/self/cgroup', 'utf8')
    const unified = /^0::(.+)$/m.exec(membership)?.[1]
    const legacy = /^\d+:[^:\n]*\bmemory\b[^:\n]*:(.+)$/m.exec(membership)?.[1]
    if (!unified && !legacy) return 0
    const path = unified
      ? join('/sys/fs/cgroup', unified, 'memory.stat')
      : join('/sys/fs/cgroup/memory', legacy!, 'memory.stat')
    const statistics = await readFile(path, 'utf8')
    const counter = unified ? /^inactive_file (\d+)$/m : /^total_inactive_file (\d+)$/m
    const bytes = Number(counter.exec(statistics)?.[1] ?? 0)
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Missing or inaccessible cache accounting keeps the conservative process budget.
    if (code === 'ENOENT' || code === 'EACCES') return 0
    throw error
  }
}

export async function readSourceStorageCapacity(path: string,
  expectedFilesystem?: RootBinding['filesystem'], now: () => number = () => Date.now()): Promise<SourceStorageCapacity> {
  const root = await openPrivateRoot(path)
  try {
    const filesystem = await identity(root)
    if (expectedFilesystem && (filesystem.device !== expectedFilesystem.device
      || filesystem.mountId !== expectedFilesystem.mountId || filesystem.inode !== expectedFilesystem.inode)) {
      throw new DomainError('SOURCE_ROOT_CONFLICT', 'Source capacity belongs to another filesystem.', 409)
    }
    const disk = await statfs(anchored(root), { bigint: true })
    const memory = await readFile('/proc/meminfo', 'utf8')
    const availableMemory = /^MemAvailable:\s*(\d+)\s+kB$/m.exec(memory)?.[1]
    const hostMemory = availableMemory ? Number(availableMemory) * 1024 : freemem()
    const constrainedMemory = process.constrainedMemory()
    let availableMemoryBytes = hostMemory
    if (constrainedMemory > 0) {
      // Node's cgroup availability includes reclaimable file cache in used memory.
      const processMemory = process.availableMemory() + await reclaimableCgroupMemory()
      availableMemoryBytes = Math.min(hostMemory, constrainedMemory, processMemory)
    }
    return SourceStorageCapacitySchema.parse({
      filesystem,
      totalBytes: Number(disk.blocks * disk.bsize),
      availableBytes: Number(disk.bavail * disk.bsize),
      cpuCount: availableParallelism(),
      availableMemoryBytes,
      observedAt: new Date(now()).toISOString(),
    })
  } finally { await root.close() }
}
