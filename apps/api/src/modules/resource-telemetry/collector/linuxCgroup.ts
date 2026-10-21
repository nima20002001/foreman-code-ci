import { open, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { normalize } from 'node:path'
import type { NativeCgroupBoundary } from '../../harnesses/recovery/cgroupBoundary.js'
import { counter, readBounded, safeBytes, sourceFailure } from './linuxProcfs.js'

export interface AccountingResult { cpu: bigint | null; memory: number | null; cpuFailure: string | null; memoryFailure: string | null }
export interface AccountingHandle {
  /** Existing local certificate only, never populated from incoming wire data. */
  boundary: NativeCgroupBoundary
  exclusive: boolean
  read(signal: AbortSignal): Promise<AccountingResult>
}
export function accountingHandle(boundary: NativeCgroupBoundary, exclusive: boolean): AccountingHandle {
  boundary = { ...boundary }
  return { boundary: { ...boundary }, exclusive, async read(signal) {
    signal.throwIfAborted()
    if (!boundary.path.startsWith('/sys/fs/cgroup/') || normalize(boundary.path) !== boundary.path) throw new Error('identity-changed')
    const fd = await open(boundary.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const verify = async () => {
        const identity = await fd.stat({ bigint: true })
        if (identity.dev.toString() !== boundary.device || identity.ino.toString() !== boundary.inode
          || (await statfs(`/proc/self/fd/${fd.fd}`)).type !== 0x63677270) throw new Error('identity-changed')
      }
      await verify()
      const root = `/proc/self/fd/${fd.fd}`
      const [cpu] = await Promise.allSettled([
        readBounded(`${root}/cpu.stat`, signal, 4096).then(text => {
          const match = /^usage_usec (\d+)$/m.exec(text)
          if (!match) throw new Error('invalid-counter')
          return counter(match[1]!)
        }),
      ])
      const [memory] = await Promise.allSettled([readBounded(`${root}/memory.current`, signal, 128).then(text => safeBytes(counter(text.trim())))])
      await verify()
      signal.throwIfAborted()
      return { cpu: cpu!.status === 'fulfilled' ? cpu!.value : null, memory: memory!.status === 'fulfilled' ? memory!.value : null,
        cpuFailure: cpu!.status === 'rejected' ? sourceFailure(cpu!.reason) : null,
        memoryFailure: memory!.status === 'rejected' ? sourceFailure(memory!.reason) : null }
    } finally { await fd.close() }
  } }
}
/** Subtree counters already include descendants. Shared/overlapping ownership must be disclosed. */
export function disjointAccounting(handles: readonly AccountingHandle[]): { handles: AccountingHandle[]; shared: boolean } {
  const ordered = [...handles].sort((a, b) => a.boundary.path.length - b.boundary.path.length)
  const chosen: AccountingHandle[] = []
  let shared = false
  for (const handle of ordered) {
    shared ||= !handle.exclusive
    if (chosen.some(parent => parent.boundary.device === handle.boundary.device &&
      (parent.boundary.inode === handle.boundary.inode || handle.boundary.path.startsWith(parent.boundary.path + '/')))) continue
    chosen.push(handle)
  }
  return { handles: chosen, shared }
}
