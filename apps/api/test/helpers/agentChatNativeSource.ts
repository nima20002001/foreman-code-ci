import type { NativeSessionReference } from '@foreman-code/contracts'

import { harnessBinaries } from '../../src/modules/harnesses/binaries.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { qualifyCodex } from '../../src/modules/harnesses/codexProtocol.js'
import { CodexStdioTransport, object, type JsonObject } from '../../src/modules/harnesses/codexStdioTransport.js'

/** Full persisted records, not notification counts or a resident manager's event cache.
 * Canonicalize object keys and top-level record order ONLY: keep all message/part
 * contents, identities, statuses and nested ordering. Reject incomplete/vacuous reads.
 */
export function nativeSourceContent(session: NativeSessionReference, records: JsonObject[]): string {
  if (!records.length) throw new Error('Source history is empty; immutability would be a vacuous assertion.')
  const id = (record: JsonObject): string => {
    const value = session.harness === 'codex' ? record.id : object(record.info).id
    if (typeof value !== 'string' || !value) throw new Error('Source history has no stable record identity.')
    if (session.harness === 'codex') {
      if (record.itemsView !== 'full' || !Array.isArray(record.items)) throw new Error('Source turn is not a full storage read.')
    } else if (object(record.info).sessionID !== session.nativeSessionId || !Array.isArray(record.parts)) {
      throw new Error('Source message is incomplete or belongs to another session.')
    }
    return value
  }
  const entries = records.map((record) => ({ id: id(record), record }))
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error('Source history repeated a record identity.')
  return canonicalJson({ harness: session.harness, sessionId: session.nativeSessionId,
    records: entries.sort((a, b) => a.id.localeCompare(b.id)).map((entry) => entry.record) })
}

/** A NEW, read-only native observer on every call. No attach/resume/start/fork,
 * turn submission or App MCP credentials. Requires the actual pinned natives.
 */
export async function readNativeSource(session: NativeSessionReference, directory: string): Promise<string> {
  const binaries = harnessBinaries(process.env)
  const signal = AbortSignal.timeout(90_000)
  const records: JsonObject[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  {
    // Retain native storage locations, not worker/App MCP or database credentials.
    const environment: NodeJS.ProcessEnv = { NO_COLOR: '1' }
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'SystemRoot']) {
      if (process.env[key] !== undefined) environment[key] = process.env[key]
    }
    const qualified = await qualifyCodex(binaries.codexBinary, directory, environment, false, signal)
    const observer: CodexStdioTransport = new CodexStdioTransport(qualified.binary, directory, environment, qualified.protocol,
      async (request) => { await observer.reject(request.id, -32601, 'Read-only history observer does not answer native requests.') },
      () => {}, () => {})
    try {
      await observer.start(signal)
      const thread = object(object(await observer.request('thread/read', { threadId: session.nativeSessionId, includeTurns: false }, signal)).thread)
      if (thread.id !== session.nativeSessionId) throw new Error('Source observer read another native thread.')
      do {
        const page = object(await observer.request('thread/turns/list', { threadId: session.nativeSessionId,
          limit: 50, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) }, signal))
        if (!Array.isArray(page.data)) throw new Error('Source turn page is invalid.')
        records.push(...page.data.map((value: unknown) => object(value)))
        if (page.nextCursor != null && typeof page.nextCursor !== 'string') throw new Error('Source turn cursor is invalid.')
        cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
        if (cursor && cursors.has(cursor)) throw new Error('Source observer repeated a cursor.')
        if (cursor) cursors.add(cursor)
      } while (cursor)
    } finally { await observer.close() }
  }
  return nativeSourceContent(session, records)
}
