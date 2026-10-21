import { ExecutionActivityFold, type ExecutionEventRow } from '../src/modules/conversations/executionActivity.js'

/** In-memory query port for HTTP/MCP unit fixtures. Persisted projection is covered by integration tests. */
export function executionProjectionRows(events: readonly ExecutionEventRow[], values: readonly unknown[]) {
  const fold = new ExecutionActivityFold()
  fold.apply(events)
  const limits = { message: Number(values[9]), input: Number(values[10]), output: Number(values[11]) }
  let rows = fold.items(String(values[0]), false, limits).map((item) => {
    const source = [...events].reverse().find((row) => row.item_key === item.id
      && row.record.type !== 'native.notification')
    const payload = source?.record.payload as Record<string, unknown> | undefined
    const record = item.entry.kind === 'message'
      ? { type: 'claude.text', occurredAt: item.occurredAt, payload: {
        itemId: item.id, role: item.entry.message.role, text: item.entry.message.content,
        final: item.entry.message.nativeMessageComplete, operation: 'replace',
        truncation: item.entry.message.truncation,
      } }
      : { ...source?.record, payload: { ...payload, itemId: item.id,
        ...(item.id.startsWith('plan:') ? { nativeMethod: 'turn/plan/updated' } : {}),
        publicInput: item.entry.activity.input, publicOutput: item.entry.activity.output,
        publicTitle: item.entry.activity.title, publicTruncated: item.entry.activity.truncated,
      } }
    return { item_key: item.id, first_sequence: item.sequence, revision: item.revision, record }
  })
  const mode = values[2]
  if (mode === 'item') rows = rows.filter((row) => row.item_key === values[5])
  if (mode === 'earlier' && values[4] !== null) {
    rows = rows.filter((row) => Number(row.first_sequence) < Number(values[4]))
  }
  if (mode === 'changes') {
    rows = rows.filter((row) => values[13] === true || Number(row.revision) > Number(values[3]))
    if (values[6] !== null) rows = rows.filter((row) => Number(row.revision) > Number(values[6])
      || row.revision === String(values[6]) && row.item_key > String(values[7]))
    rows.sort((a, b) => Number(a.revision) - Number(b.revision) || a.item_key.localeCompare(b.item_key))
  } else rows.sort((a, b) => Number(b.first_sequence) - Number(a.first_sequence))
  return rows.slice(0, Number(values[8]))
}
