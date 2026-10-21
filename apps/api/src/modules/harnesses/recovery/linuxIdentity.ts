import { readFileSync, readdirSync } from 'node:fs'

export interface LinuxProcessIdentity { pid: number; startTicks: string; group: number; session: number; state: string }
export function bootIdentity(): string {
  if (process.platform !== 'linux') throw new Error('Native process recovery requires Linux /proc.')
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  if (!/^[0-9a-f-]{36}$/.test(boot)) throw new Error('Linux boot identity is unavailable.')
  return boot
}
export function processIdentity(pid: number): LinuxProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid native process identity.')
  let value: string
  try { value = readFileSync(`/proc/${pid}/stat`, 'utf8') } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
    throw error
  }
  // comm may contain spaces and parentheses. Everything after the LAST ')' is fixed-position.
  const end = value.lastIndexOf(')')
  const parts = value.slice(end + 2).trim().split(/\s+/)
  if (end < 0 || parts.length < 20 || !/^\d+$/.test(parts[19]!)) throw new Error('Malformed Linux process identity.')
  return { pid, startTicks: parts[19]!, group: Number(parts[2]), session: Number(parts[3]), state: parts[0]! }
}
export function identityAlive(identity: Pick<LinuxProcessIdentity, 'pid' | 'startTicks'>): boolean {
  const current = processIdentity(identity.pid)
  return !!current && current.startTicks === identity.startTicks && !['Z', 'X'].includes(current.state)
}
/** Observation only. No recovery path ever sends a signal to a stored PID. */
export function sessionAlive(session: number): boolean {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) <= 1) continue
    const found = processIdentity(Number(entry))
    if (found?.session === session && !['Z', 'X'].includes(found.state)) return true
  }
  return false
}
