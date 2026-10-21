import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'

const U64 = (1n << 64n) - 1n
export function counter(value: string): bigint {
  if (!/^\d{1,20}$/.test(value)) throw new Error('invalid-counter')
  const n = BigInt(value)
  if (n > U64) throw new Error('invalid-counter')
  return n
}
export function safeBytes(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid-counter')
  return Number(value)
}
export interface ProcStat { pid: number; parentPid: number; startTicks: string; cpuTicks: bigint | null; rssPages: bigint | null; state: string }
export function parseProcStat(text: string): ProcStat {
  const end = text.lastIndexOf(')')
  const pid = Number(text.slice(0, text.indexOf(' ')))
  const fields = text.slice(end + 2).trim().split(/\s+/)
  if (!text.startsWith(`${pid} (`) || end < 0 || !Number.isSafeInteger(pid) || pid < 1 || fields.length < 20) throw new Error('invalid-counter')
  const parentPid = Number(fields[1])
  if (!Number.isSafeInteger(parentPid) || parentPid < 0) throw new Error('invalid-counter')
  let cpuTicks: bigint | null = null; let rssPages: bigint | null = null
  try { cpuTicks = counter((counter(fields[11]!) + counter(fields[12]!)).toString()) } catch { /* ignore: independent CPU failure. */ }
  try { rssPages = counter(fields[21] ?? '') } catch { /* ignore: independent RSS failure. */ }
  return { pid, parentPid, state: fields[0]!, startTicks: counter(fields[19]!).toString(), cpuTicks, rssPages }
}
export function parseHostCpu(text: string): { active: bigint; total: bigint } {
  const values = /^cpu\s+([^\n]+)$/m.exec(text)?.[1]?.trim().split(/\s+/)
  if (!values || values.length < 8) throw new Error('invalid-counter')
  const ticks = values.slice(0, 8).map(counter)
  return { active: counter((ticks[0]! + ticks[1]! + ticks[2]! + ticks[5]! + ticks[6]!).toString()), total: counter(ticks.reduce((a, b) => a + b, 0n).toString()) }
}
export function parseHostMemory(text: string): { bytes: number; totalBytes: number; availableBytes: number } {
  const read = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(text)
    if (!match) throw new Error('invalid-counter')
    return safeBytes(counter(match[1]!) * 1024n)
  }
  const totalBytes = read('MemTotal'); const availableBytes = read('MemAvailable')
  if (availableBytes > totalBytes) throw new Error('invalid-counter')
  return { bytes: totalBytes - availableBytes, totalBytes, availableBytes }
}
export function parseOnlineCpus(text: string): string {
  const ids = new Set<number>()
  for (const part of text.trim().split(',')) {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part)
    if (!match) throw new Error('invalid-counter')
    const start = Number(match[1]); const end = Number(match[2] ?? match[1])
    if (end < start || end > 65535) throw new Error('invalid-counter')
    for (let i = start; i <= end; i++) ids.add(i)
  }
  if (!ids.size) throw new Error('invalid-counter')
  return [...ids].sort((a, b) => a - b).join(',')
}
/** Each read pins its file, bounds bytes, and always joins close. Never reads command/environment. */
export async function readBounded(path: string, signal: AbortSignal, maxBytes = 65536): Promise<string> {
  signal.throwIfAborted()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length <= maxBytes) {
      signal.throwIfAborted()
      const read = await file.read(buffer, length, buffer.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
      if (length > maxBytes) throw new Error('limit-exceeded')
    }
    signal.throwIfAborted()
    return buffer.subarray(0, length).toString('utf8')
  } finally { await file.close() }
}
export interface HostConstants { clockTicksPerSecond: bigint; pageSize: bigint }
/** Fixed arguments, once at initialization; no shell and no sampling-time subprocess. */
export async function qualifyHostConstants(signal: AbortSignal): Promise<HostConstants> {
  const read = (name: 'CLK_TCK' | 'PAGESIZE') => new Promise<bigint>((resolve, reject) => {
    execFile('/usr/bin/getconf', [name], { signal, timeout: 2000, maxBuffer: 128, encoding: 'utf8', cwd: '/', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }, (error, stdout) => {
      if (error) { reject(error); return }
      try { const n = counter(stdout.trim()); if (!n) throw new Error('invalid-counter'); resolve(n) } catch (failure) { reject(failure) }
    })
  })
  const results = await Promise.allSettled([read('CLK_TCK'), read('PAGESIZE')])
  const failure = results.find(r => r.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  return { clockTicksPerSecond: (results[0] as PromiseFulfilledResult<bigint>).value, pageSize: (results[1] as PromiseFulfilledResult<bigint>).value }
}
export function sourceFailure(error: unknown): 'permission-denied' | 'identity-changed' | 'limit-exceeded' | 'source-missing' | 'invalid-counter' | 'source-failure' {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'permission-denied'
  if (code === 'ENOENT' || code === 'ESRCH') return 'source-missing'
  if (error instanceof Error && ['identity-changed', 'limit-exceeded', 'invalid-counter', 'source-missing', 'source-failure', 'permission-denied'].includes(error.message)) return error.message as 'identity-changed' | 'limit-exceeded' | 'invalid-counter' | 'source-missing' | 'source-failure' | 'permission-denied'
  return 'source-failure'
}
