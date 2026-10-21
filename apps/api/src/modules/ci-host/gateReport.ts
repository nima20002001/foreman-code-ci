import type { CiRunRecord } from '@foreman-code/contracts'

function actualDuration(runs: CiRunRecord[]): number | null {
  if (runs.some(run => !run.finishedAt || !run.startedAt)) return null
  const start = Math.min(...runs.map(run => Date.parse(run.startedAt!)))
  const end = Math.max(...runs.map(run => Date.parse(run.finishedAt!)))
  return Math.max(0, end - start)
}

export function ciGateReport(runs: CiRunRecord[]) {
  const keys = [...new Set(runs.map(run => run.plannedHostKey).filter((key): key is string => !!key))]
  const computers = keys.map(key => {
    const assigned = runs.filter(run => run.plannedHostKey === key)
    return { key, ticketIds: assigned.map(run => run.id),
      expectedDurationMs: assigned.reduce((sum, run) => sum + (run.expectedDurationMs ?? 0), 0),
      actualDurationMs: actualDuration(assigned) }
  })
  const suites = (['typecheck', 'lint', 'unit', 'integration'] as const).map(suite => {
    const assigned = runs.filter(run => run.suite === suite)
    return { suite, expectedDurationMs: Math.max(0, ...assigned.map(run => run.expectedDurationMs ?? 0)),
      actualDurationMs: assigned.length ? actualDuration(assigned) : null }
  })
  const predicted = [...computers].sort((left, right) => right.expectedDurationMs - left.expectedDurationMs)[0]
  const complete = runs.every(run => run.finishedAt)
  const last = complete ? [...runs].sort((left, right) => Date.parse(right.finishedAt!) - Date.parse(left.finishedAt!))[0] : null
  const queuedAt = Math.min(...runs.map(run => Date.parse(run.queuedAt)))
  return { computers, suites, criticalPath: {
    computerKey: last?.plannedHostKey ?? predicted?.key ?? null,
    expectedDurationMs: predicted?.expectedDurationMs ?? 0,
    actualDurationMs: actualDuration(runs),
  }, wallTimeMs: last ? Math.max(0, Date.parse(last.finishedAt!) - queuedAt) : null }
}
