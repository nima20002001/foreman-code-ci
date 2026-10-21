import { isDeepStrictEqual } from 'node:util'
import type { ClaudeCallbackRecord } from '../../src/modules/harnesses/claudeSdk/callbackJournal.js'

/** SQL storage double for callback journals; integration tests use PostgreSQL. */
export function claudeCallbackDatabase() {
  const records = new Map<string, { owner: string; record: ClaudeCallbackRecord }>()
  return (sql: string, values: unknown[]): { rows: unknown[]; rowCount: number } | undefined => {
    if (!sql.includes('claude_callback_receipts')) return undefined
    const owner = String(values[0])
    const key = JSON.stringify([owner, values[1]])
    if (sql.includes('insert into')) {
      const record = JSON.parse(String(values[3])) as ClaudeCallbackRecord
      const previous = records.get(key)?.record
      if (previous && (previous.inputHash !== record.inputHash
        || !isDeepStrictEqual(previous.identity, record.identity)
        || previous.state !== record.state || previous.selectedOptionId !== record.selectedOptionId)) {
        return { rows: [], rowCount: 0 }
      }
      records.set(key, { owner, record: { ...record,
        acknowledged: previous?.acknowledged === true || record.acknowledged,
        retired: previous?.retired === true || record.retired === true } })
      return { rows: [{ callback_key: values[1] }], rowCount: 1 }
    }
    if (sql.includes('callback_key=$2')) {
      const record = records.get(key)?.record
      return { rows: record ? [{ record: structuredClone(record) }] : [], rowCount: record ? 1 : 0 }
    }
    const rows = [...records.values()].filter(entry => {
      const { identity } = entry.record
      if (entry.owner !== owner || identity.nativeSessionId !== values[1]) return false
      if (sql.includes('toolUseId')) {
        return identity.nativeMessageId === values[2] && identity.generation === values[3]
          && identity.toolUseId === values[4]
      }
      return entry.record.acknowledged && !entry.record.retired
    }).map(entry => ({ record: structuredClone(entry.record) }))
    return { rows, rowCount: rows.length }
  }
}
