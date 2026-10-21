import type { NativeHarnessEvent, PendingNativeInteraction } from '@foreman-code/contracts'

const MAX_TARGETS = 5
const MAX_COUNTED_CHANGES = 100
const MAX_COUNTED_DIFF_CHARS = 65_536

/** Only structural facts from the exact Codex file-change item enter decision UI. */
export function nativeApprovalContext(pending: PendingNativeInteraction, events: readonly NativeHarnessEvent[]) {
  if (pending.session.harness !== 'codex' || pending.nativeRequestType !== 'item/fileChange/requestApproval') return undefined
  const request = pending.request
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.itemId !== 'string' || !request.itemId) return undefined
  const matches = events.filter((event) => {
    if (event.type !== 'item.started') return false
    const payload = event.payload
    const item = payload.item
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
    const nativeItem = item as Record<string, unknown>
    return payload.threadId === pending.session.nativeSessionId && payload.turnId === pending.turn.nativeTurnId
      && nativeItem.id === request.itemId && nativeItem.type === 'fileChange'
  })
  if (matches.length !== 1) return undefined
  const item = matches[0]!.payload.item as Record<string, unknown>
  if (!Array.isArray(item.changes) || !item.changes.length) return undefined
  const changes = item.changes
  const validPath = (change: unknown): change is { path: string; diff?: unknown } => !!change
    && typeof change === 'object' && !Array.isArray(change)
    && 'path' in change && typeof change.path === 'string'
    && change.path.length > 0 && change.path.length <= 1024 && !/[\r\n\0]/.test(change.path)
  const shown = changes.slice(0, MAX_TARGETS)
  if (!shown.every(validPath)) return undefined
  const largeList = changes.length > MAX_COUNTED_CHANGES
  if (!largeList && !changes.every(validPath)) return undefined
  const target = `${shown.map((change) => change.path).join(', ')}${changes.length > shown.length
    ? `, and ${changes.length - shown.length} more ${largeList ? 'change entries' : 'files'}` : ''}`
  const diffChars = largeList ? Infinity : changes.reduce((total, change) => {
    const diff = (change as { diff?: unknown }).diff
    return total > MAX_COUNTED_DIFF_CHARS || typeof diff !== 'string' ? Infinity : total + diff.length
  }, 0)
  if (diffChars > MAX_COUNTED_DIFF_CHARS) return { target,
    changeSummary: `${changes.length} ${largeList ? 'change entries' : changes.length === 1 ? 'file' : 'files'}; line counts unavailable (summary limit). Patch contents are not shown here.` }
  let added = 0, removed = 0
  let countable = true
  for (const change of changes) {
    let inHunk = false
    for (const line of (change as { diff: string }).diff.split('\n')) {
      if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) { inHunk = true; continue }
      if (!inHunk || !line) continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
      else if (!line.startsWith(' ') && !line.startsWith('\\')) countable = false
    }
    if (!inHunk) countable = false
  }
  if (!countable || added + removed === 0) return { target,
    changeSummary: `${changes.length} ${changes.length === 1 ? 'file' : 'files'}; line counts unavailable (native diff format). Patch contents are not shown here.` }
  return { target, changeSummary: `${changes.length} ${changes.length === 1 ? 'file' : 'files'}; ${added} added, ${removed} removed lines. Patch contents are not shown here.` }
}
