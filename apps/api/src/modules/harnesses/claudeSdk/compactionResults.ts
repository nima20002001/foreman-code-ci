import { randomUUID } from 'node:crypto'
import { claudeSessionScopeHash } from './compactionHistory.js'
import { constants } from 'node:fs'
import { mkdir, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ClaudePersistedSession } from './port.js'

const ResultSchema = z.object({
  scope: z.string(), promptUuid: z.string().uuid(), nativeSessionId: z.string(),
  status: z.enum(['completed', 'no-op', 'failed']), observedAt: z.string().datetime(),
}).strict()
function resultLocation(session: ClaudePersistedSession, promptUuid: string) {
  z.string().uuid().parse(promptUuid)
  const scope = claudeSessionScopeHash(session)
  const directory = join(session.profilePath, 'foreman-session-controls', scope)
  return { scope, directory, path: join(directory, `${promptUuid}.json`) }
}

/** Record the SDK terminal before exposing it to application settlement. */
export async function saveClaudeCompactionResult(session: ClaudePersistedSession, promptUuid: string,
  status: 'completed' | 'no-op' | 'failed') {
  const location = resultLocation(session, promptUuid)
  const saved = await readClaudeCompactionResult(session, promptUuid)
  if (saved) {
    if (saved.status !== status) throw new Error('Claude native compaction outcome changed')
    return
  }
  await mkdir(location.directory, { recursive: true, mode: 0o700 })
  const temporary = join(location.directory, `${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify({ scope: location.scope, promptUuid,
      nativeSessionId: session.nativeSessionId, status, observedAt: new Date().toISOString() }))
    await file.sync()
  } finally { await file.close() }
  await rename(temporary, location.path)
  const directory = await open(location.directory, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

export async function readClaudeCompactionResult(session: ClaudePersistedSession, promptUuid: string) {
  const location = resultLocation(session, promptUuid)
  let file
  try { file = await open(location.path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  try {
    const result = ResultSchema.parse(JSON.parse(await file.readFile('utf8')))
    if (result.scope !== location.scope || result.promptUuid !== promptUuid
      || result.nativeSessionId !== session.nativeSessionId) throw new Error('Claude compaction result scope changed')
    return result
  } finally { await file.close() }
}


export function claudeCompactionResultMatches(frame: Record<string, unknown>, sessionId: string, promptUuid: string) {
  if (frame.type !== 'result' || frame.session_id !== sessionId || typeof frame.is_error !== 'boolean'
    || frame.parent_tool_use_id != null || frame.deferred_tool_use != null
    || ['tool_deferred', 'background_requested'].includes(String(frame.terminal_reason))) return false
  const uuids = Array.isArray(frame.user_message_uuids)
    ? frame.user_message_uuids.filter((value): value is string => typeof value === 'string') : []
  if (typeof frame.user_message_uuid === 'string') uuids.push(frame.user_message_uuid)
  // Native command-only results may omit UUIDs; the owned idle query admits one control at a time.
  return uuids.length === 0 || uuids.every(uuid => uuid === promptUuid)
}
