import { parseProcStat, safeBytes, sourceFailure, type HostConstants, type ProcStat } from './linuxProcfs.js'
export interface ProcessIdentity { bootId: string; pid: number; startTicks: string }
export interface ProcessReader {
  stat(pid: number, signal: AbortSignal): Promise<string>
  /** Bounded direct children of this validated process only; no whole /proc scan. */
  children(pid: number, signal: AbortSignal): Promise<readonly number[]>
}
export interface ProcessSetResult { cpuNs: bigint | null; rssBytes: number | null; identities: ProcessIdentity[]; counters: Map<string, bigint>; limitations: string[] }
export function processKey(identity: ProcessIdentity): string { return `${identity.bootId}:${identity.pid}:${identity.startTicks}` }
export async function collectProcessSet(input: {
  roots: readonly ProcessIdentity[]; retained: readonly ProcessIdentity[]; bootId: string; reader: ProcessReader;
  constants: HostConstants; signal: AbortSignal; budget: { remaining: number }; now: () => bigint; deadlineNs?: bigint;
}): Promise<ProcessSetResult> {
  const { signal, reader } = input
  const started = input.now()
  const supplied = [...input.roots.slice(0, 4096), ...input.retained.slice(0, 4096)]
  const queue = supplied.slice(0, Math.min(4096, input.budget.remaining)).map(identity => ({ identity, depth: 0 }))
  const visited = new Set<string>(); const identities: ProcessIdentity[] = []; const counters = new Map<string, bigint>(); const scheduled = new Set(queue.map(row => processKey(row.identity)))
  const limitations = new Set<string>(['process-tree-partial', 'short-lived-unobserved'])
  if (input.roots.length > 4096 || input.retained.length > 4096 || supplied.length > Math.min(4096, input.budget.remaining)) limitations.add('limit-exceeded')
  let cpu = 0n; let rss = 0n; let cpuValid = 0; let rssValid = 0
  while (queue.length) {
    signal.throwIfAborted()
    if (input.budget.remaining <= 0 || input.now() > (input.deadlineNs ?? started + 250_000_000n)) { limitations.add('limit-exceeded'); break }
    const { identity, depth } = queue.shift()!
    if (identity.bootId !== input.bootId) { limitations.add('identity-changed'); continue }
    const key = processKey(identity)
    if (visited.has(key)) continue
    visited.add(key); input.budget.remaining--
    try {
      const before = parseProcStat(await reader.stat(identity.pid, signal))
      if (!matches(before, identity)) throw new Error('identity-changed')
      let children: readonly number[] = []
      if (depth < 64) { try { children = await reader.children(identity.pid, signal) } catch (error) { limitations.add(sourceFailure(error)) } }
      else limitations.add('limit-exceeded')
      // Hold children's exact birth identity while their validated parent still exists.
      const captured: ProcessIdentity[] = []
      for (const pid of children.slice(0, Math.max(0, input.budget.remaining))) {
        signal.throwIfAborted()
        if (input.now() > (input.deadlineNs ?? started + 250_000_000n)) { limitations.add('limit-exceeded'); break }
        try { const child = parseProcStat(await reader.stat(pid, signal)); if (child.pid === pid && child.parentPid === identity.pid) { const identity = { bootId: input.bootId, pid, startTicks: child.startTicks }; const key = processKey(identity); if (!scheduled.has(key) && scheduled.size < 4096) { scheduled.add(key); captured.push(identity) } else if (scheduled.size >= 4096) limitations.add('limit-exceeded') } }
        catch (error) { limitations.add(sourceFailure(error)) }
      }
      if (children.length > input.budget.remaining) limitations.add('limit-exceeded')
      const after = parseProcStat(await reader.stat(identity.pid, signal))
      if (!matches(after, identity)) throw new Error('identity-changed')
      identities.push(identity)
      if (!['Z', 'X'].includes(after.state)) {
        if (after.cpuTicks !== null) { const ns = after.cpuTicks * 1_000_000_000n / input.constants.clockTicksPerSecond; counters.set(key, ns); cpu += ns; cpuValid++ } else limitations.add('invalid-counter')
        if (after.rssPages !== null) { rss += after.rssPages * input.constants.pageSize; rssValid++ } else limitations.add('invalid-counter')
      }
      else limitations.add('source-missing')
      queue.push(...captured.map(child => ({ identity: child, depth: depth + 1 })))
    } catch (error) { limitations.add(sourceFailure(error)); identities.push(identity) }
  }
  let rssBytes: number | null = null
  if (rssValid) { try { rssBytes = safeBytes(rss) } catch { limitations.add('invalid-counter') } }
  return { cpuNs: cpuValid ? cpu : null, rssBytes, identities, counters, limitations: [...limitations] }
}
function matches(stat: ProcStat, identity: ProcessIdentity): boolean { return stat.pid === identity.pid && stat.startTicks === identity.startTicks }
