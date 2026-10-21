import type pg from 'pg'
import { SessionControlStateSchema, type SessionControlState } from '@foreman-code/contracts'
import { SessionControlStore } from '../../src/modules/conversations/sessionControls/store.js'

export function memorySessionControlPool(options: {
  records?: Map<string, SessionControlState>
  defaults?: Map<string, unknown>
} = {}) {
  const records = options.records ?? new Map<string, SessionControlState>()
  const defaults = options.defaults ?? new Map<string, unknown>()
  const pool = {
    async query(text: string, values: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim()
      const id = String(values[0])
      const previous = records.get(id)
      const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows: structuredClone(rows), rowCount })
      if (sql.startsWith('select record from conversation_session_defaults')) {
        const record = defaults.get(JSON.stringify(values))
        return result(record ? [{ record }] : [])
      }
      if (sql.startsWith("select result#>'{state,compaction}' as compaction")) return result()
      if (sql.startsWith('with saved as')) {
        if (!previous || previous.revision !== Number(values[2])) return result()
        const next = SessionControlStateSchema.parse(JSON.parse(String(values[1])))
        if (previous.profileKey === next.profileKey) next.context = previous.context
        records.set(id, next)
        defaults.set(JSON.stringify(values.slice(3, 7)), JSON.parse(String(values[7])))
        return result([], 1)
      }
      if (sql.startsWith('select record from conversation_session_controls')) return result(previous ? [{ record: previous }] : [])
      if (sql.startsWith('insert into conversation_session_controls')) {
        if (previous) return result()
        records.set(id, SessionControlStateSchema.parse(JSON.parse(String(values[1]))))
        return result([], 1)
      }
      if (sql.startsWith('update conversation_session_controls set record=jsonb_set')) {
        if (!previous || previous.revision !== Number(values[2])) return result()
        const next = SessionControlStateSchema.parse(JSON.parse(String(values[1])))
        if (previous.profileKey === next.profileKey) next.context = previous.context
        records.set(id, next)
        return result([], 1)
      }
      if (sql.startsWith('update conversation_session_controls set record=record ||')) {
        if (!previous || previous.profileKey !== String(values[2])) return result()
        const patch = JSON.parse(String(values[1])) as Partial<SessionControlState>
        const next = SessionControlStateSchema.parse({ ...previous, ...patch })
        records.set(id, next)
        return result([{ record: next }])
      }
      throw new Error(`Unhandled session controls fixture query: ${sql}`)
    },
  } as unknown as Pick<pg.Pool, 'query'>
  return pool
}

export function memorySessionControls(role: 'operator' | 'agent' = 'operator') {
  return new SessionControlStore(memorySessionControlPool(), role)
}
