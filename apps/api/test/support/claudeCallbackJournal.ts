import { isDeepStrictEqual } from 'node:util'
import type { ClaudeCallbackJournal, ClaudeCallbackRecord } from '../../src/modules/harnesses/claudeSdk/callbackJournal.js'

/** Storage double for transport-only tests; integration tests use PostgreSQL. */
export function memoryClaudeCallbackJournal(): ClaudeCallbackJournal {
  const rows = new Map<string, ClaudeCallbackRecord>()
  return {
    read: async key => rows.has(key) ? structuredClone(rows.get(key)!) : undefined,
    async write(key, record) {
      const previous = rows.get(key)
      if (previous && (previous.inputHash !== record.inputHash || !isDeepStrictEqual(previous.identity, record.identity))) {
        throw new Error('Callback identity conflict')
      }
      rows.set(key, { ...structuredClone(record), acknowledged: previous?.acknowledged === true || record.acknowledged,
        retired: previous?.retired === true || record.retired === true })
    },
    async forTool(identity) {
      const matches = [...rows.values()].filter(record => record.identity.nativeSessionId === identity.nativeSessionId
        && record.identity.nativeMessageId === identity.nativeMessageId && record.identity.generation === identity.generation
        && record.identity.toolUseId === identity.toolUseId)
      return matches.length === 1 ? structuredClone(matches[0]!) : undefined
    },
    acknowledged: async nativeSessionId => [...rows.values()].filter(record => record.acknowledged && !record.retired
      && record.identity.nativeSessionId === nativeSessionId).map(record => structuredClone(record)),
  }
}
