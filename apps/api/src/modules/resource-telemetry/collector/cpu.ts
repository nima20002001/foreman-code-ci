export interface CpuBaseline { generation: string; monoNs: bigint; counter: bigint; total: bigint | null }
export interface CpuWindow { previous: string; current: string; elapsedNs: string; previousTotal: string | null; currentTotal: string | null }
/** Memory does not depend on this CPU baseline or its warmup. */
export function cpuWindow(previous: CpuBaseline | undefined, current: CpuBaseline): CpuWindow | null {
  const elapsed = previous ? current.monoNs - previous.monoNs : 0n
  if (!previous || previous.generation !== current.generation || elapsed <= 0n || elapsed > 6_000_000_000n
    || current.counter < previous.counter || (current.total !== null && (previous.total === null || current.total <= previous.total))) return null
  return { previous: previous.counter.toString(), current: current.counter.toString(), elapsedNs: elapsed.toString(),
    previousTotal: previous.total?.toString() ?? null, currentTotal: current.total?.toString() ?? null }
}
