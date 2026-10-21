import type { RunDropdownPage, RunDropdownStatus, RunDropdownSummary } from '@foreman-code/contracts/run-snapshots'

export const RUNS_PAGE_SIZE = 25
export const RUNS_MAX_PAGES = 10
export const RUNS_MAX_ITEMS = RUNS_PAGE_SIZE * RUNS_MAX_PAGES

/** Keep server admission order; startedAt can be null or disagree with admission order. */
export function flattenRunPages(pages: readonly RunDropdownPage[] = []): RunDropdownSummary[] {
  const seen = new Set<string>()
  const items: RunDropdownSummary[] = []
  for (const page of pages) for (const item of page.items) {
    if (seen.has(item.runId)) continue
    seen.add(item.runId)
    items.push(item)
    if (items.length === RUNS_MAX_ITEMS) return items
  }
  return items
}

export function nextRunsCursor(
  last: RunDropdownPage, pages: readonly RunDropdownPage[], _lastParam: string | undefined,
  params: readonly (string | undefined)[],
): string | undefined {
  const cursor = last.pageInfo.nextCursor
  if (pages.length >= RUNS_MAX_PAGES || cursor === null || params.includes(cursor)) return undefined
  return cursor
}

export const runStatusLabels: Record<RunDropdownStatus, string> = {
  queued: 'Queued', running: 'Running', waiting: 'Waiting', interrupted: 'Interrupted',
  succeeded: 'Succeeded', failed: 'Failed', canceled: 'Canceled',
}

/** Local calendar days, including year. Duplicate detection spans all loaded pages. */
export function labelRuns(items: readonly RunDropdownSummary[], locale?: string, timeZone?: string) {
  const day = new Intl.DateTimeFormat('en-US', { calendar: 'gregory', year: 'numeric', month: '2-digit', day: '2-digit', timeZone })
  const dateTime = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone })
  const counts = new Map<string, number>()
  for (const item of items) if (item.startedAt !== null) {
    const key = day.format(new Date(item.startedAt))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return items.map((run) => {
    const date = run.startedAt === null ? null : new Date(run.startedAt)
    const showShortId = date === null || (counts.get(day.format(date)) ?? 0) > 1
    const time = date ? dateTime.format(date) : 'Not started'
    const status = runStatusLabels[run.status]
    return { run, time, status, showShortId, label: `${time}${showShortId ? ` · ${run.shortId}` : ''} · ${status}` }
  })
}
