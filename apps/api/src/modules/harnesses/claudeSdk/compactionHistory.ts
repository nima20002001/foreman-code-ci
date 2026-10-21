import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { ClaudePersistedSession } from './port.js'
import { compactionBlocksSend, type CompactionState } from '@foreman-code/contracts'

export class ClaudeCompactionHistoryUnavailableError extends Error {}

export interface ClaudeCompactionCursor {
  identity: string
  offset: number
  scope: string
}
export function claudeSessionScopeHash(session: ClaudePersistedSession) {
  return createHash('sha256').update(JSON.stringify([session.deviceId, session.profilePath,
    session.configRevision, session.cwd, session.nativeSessionId])).digest('hex')
}

/** Read only the admitted session's native log; no ambient profile or latest-session lookup. */
export async function readClaudeCompactionHistory(session: ClaudePersistedSession,
  cursor?: ClaudeCompactionCursor, signal?: AbortSignal) {
  if (!/^[a-f0-9-]{36}$/i.test(session.nativeSessionId)) throw new Error('Invalid native Claude session identity')
  const projects = await realpath(join(session.profilePath, 'projects'))
  const candidates = await readdir(projects, { withFileTypes: true })
  for (const project of candidates) {
    signal?.throwIfAborted()
    if (!project.isDirectory()) continue
    const path = join(projects, project.name, `${session.nativeSessionId}.jsonl`)
    let file
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    try {
      const canonical = await realpath(path)
      if (relative(projects, canonical).startsWith('..')) throw new Error('Native transcript escaped its profile')
      const info = await file.stat()
      if (!info.isFile()) throw new Error('Native transcript is not a regular file')
      const identity = createHash('sha256').update(JSON.stringify([canonical,info.dev,info.ino,info.birthtimeMs])).digest('hex')
      const scope = claudeSessionScopeHash(session)
      if (cursor && (cursor.identity !== identity || cursor.scope !== scope || cursor.offset > info.size)) {
        throw new Error('The native transcript identity changed during compaction')
      }
      const boundaries: Record<string, unknown>[] = []
      const start = cursor?.offset ?? 0
      let completeSize = start
      let position = info.size
      while (position > start) {
        signal?.throwIfAborted()
        const chunkStart = Math.max(start, position - 65536)
        const chunk = Buffer.alloc(position - chunkStart)
        const { bytesRead } = await file.read(chunk, 0, chunk.length, chunkStart)
        if (bytesRead !== chunk.length) throw new Error('The native transcript changed while reading compaction')
        const newline = chunk.lastIndexOf(10)
        if (newline >= 0) {
          completeSize = chunkStart + newline + 1
          break
        }
        position = chunkStart
      }
      if (completeSize > start) {
        const stream = file.createReadStream({ autoClose: false, start, end: completeSize - 1,
          ...(signal ? { signal } : {}) })
        const lines = createInterface({ input: stream, crlfDelay: Infinity })
        try {
          for await (const line of lines) {
            if (!line.trim()) continue
            const frame = JSON.parse(line) as Record<string, unknown>
            if (frame.sessionId !== session.nativeSessionId) continue
            if (typeof frame.cwd === 'string' && resolve(frame.cwd) !== resolve(session.cwd)) {
              throw new Error('The native transcript belongs to another working directory')
            }
            if (frame.isSidechain === true) continue
            if (frame.type === 'system' && frame.subtype === 'compact_boundary') boundaries.push(frame)
          }
        } finally { lines.close(); stream.destroy() }
      }
      return { cursor: { identity, offset: completeSize, scope }, boundaries }
    } finally { await file.close() }
  }
  throw new ClaudeCompactionHistoryUnavailableError('The exact native Claude transcript is unavailable')
}

export function recoveredClaudeCompaction(state: CompactionState, boundaries: readonly Record<string, unknown>[]): CompactionState {
  if (!compactionBlocksSend(state)) return state
  const manual = boundaries.filter(frame => {
    const metadata = frame.compactMetadata as { trigger?: string } | undefined
    return frame.sessionId === state.nativeSessionId && metadata?.trigger === 'manual' && typeof frame.uuid === 'string'
  })
  if (manual.length !== 1) return state
  const boundary = manual[0]!
  const metadata = boundary.compactMetadata as { preTokens?: number }
  return { ...state, nativeOperationId: String(boundary.uuid),
    message: 'Compaction boundary observed. Waiting for the command result.',
    beforeTokens: metadata.preTokens ?? null,
    observedAt: typeof boundary.timestamp === 'string' ? boundary.timestamp : new Date().toISOString() }
}
