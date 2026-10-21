export interface Eng06SettlementProgress {
  state: string
  cleanupPending: boolean
  activeStarts?: number
  executions: Array<{ id: string; state: string; accepted: boolean }>
}

/** A three-occurrence PG run does more work than a single failed slot. Allow
 * moving work up to 120s under concurrent integration load, but retain a 20s
 * no-progress bound. Neither repeated reconcile calls nor fresh copies of the
 * same rows reset that stall deadline.
 * These are test wait limits, not native timeout, retry or repeat policies. */
export async function waitForEng06Settlement(probe: () => Promise<Eng06SettlementProgress>,
  options: { pollIntervalMs?: number } = {}): Promise<void> {
  const started = performance.now()
  let changed = started, previous = ''
  for (;;) {
    const current = await probe(), now = performance.now()
    const progress = JSON.stringify({ state: current.state, cleanupPending: current.cleanupPending,
      activeStarts: current.activeStarts,
      executions: [...current.executions].sort((a, b) => a.id.localeCompare(b.id)) })
    if (now - started >= 120000) throw new Error(`ENG06_SETTLEMENT_DEADLINE: ${progress}`)
    if (progress !== previous) { previous = progress; changed = now }
    if (current.state === 'completed' && current.cleanupPending === false && !current.activeStarts) return
    if (now - changed >= 20000) throw new Error(`ENG06_SETTLEMENT_STALLED: ${progress}`)
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(options.pollIntervalMs ?? 500,
      120000 - (now - started), 20000 - (now - changed))))
  }
}
