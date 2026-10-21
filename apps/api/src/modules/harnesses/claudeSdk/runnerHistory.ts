import { readClaudeCompactionResult } from './compactionResults.js'
import { readClaudeCompactionHistory } from './compactionHistory.js'
import type { ClaudePersistedSession, ClaudeSdkClient, ClaudeSdkRunner, ClaudeSessionScope } from './port.js'

export function assertClaudeSessionScope(session: ClaudePersistedSession, scope: ClaudeSessionScope): void {
  for (const key of ['deviceId', 'profilePath', 'configRevision', 'cwd'] as const) {
    if (session[key] !== scope[key]) throw new Error(`Claude session ${key} mismatch`)
  }
}

export function claudeSessionHistory(input: {
  loadClient(): Promise<ClaudeSdkClient>
  isDisposed(): boolean
}): Pick<ClaudeSdkRunner, 'fork' | 'compactionOutcome' | 'compactionHistory' | 'history' | 'subagentHistory'> {
  return {
    async fork(source, target, signal) {
      signal?.throwIfAborted()
      if (input.isDisposed()) throw new Error('Claude runner disposed')
      assertClaudeSessionScope(source, target)
      const client = await input.loadClient()
      signal?.throwIfAborted()
      const info = await client.getSessionInfo(source.nativeSessionId, { dir: source.cwd })
      if (!info || info.sessionId !== source.nativeSessionId) throw new Error('Exact Claude source session is unavailable')
      signal?.throwIfAborted()
      const fork = await client.forkSession(source.nativeSessionId, { dir: source.cwd })
      if (!fork.sessionId || fork.sessionId === source.nativeSessionId) throw new Error('Claude fork did not return a new native session')
      return { ...target, nativeSessionId: fork.sessionId }
    },
    async compactionOutcome(session, scope, promptUuid) {
      assertClaudeSessionScope(session, scope)
      return readClaudeCompactionResult(session, promptUuid)
    },
    async compactionHistory(session, scope, cursor, signal) {
      assertClaudeSessionScope(session, scope)
      return readClaudeCompactionHistory(session, cursor, signal)
    },
    async history(session, scope, signal, page) {
      signal?.throwIfAborted()
      assertClaudeSessionScope(session, scope)
      const client = await input.loadClient()
      signal?.throwIfAborted()
      return client.getSessionMessages(session.nativeSessionId, { dir: session.cwd, limit: page?.limit ?? 256, offset: page?.offset ?? 0 })
    },
    async subagentHistory(session, scope, agentId, offset = 0, signal) {
      signal?.throwIfAborted()
      assertClaudeSessionScope(session, scope)
      if (input.isDisposed()) throw new Error('Claude runner disposed')
      const client = await input.loadClient()
      if (!client.listSubagents || !client.getSubagentMessages) throw new Error('The pinned SDK child read helper is unavailable')
      const info = await client.getSessionInfo(session.nativeSessionId, { dir: scope.cwd })
      if (info?.sessionId !== session.nativeSessionId) throw new Error('Exact parent history is unavailable')
      const agentIds = [...new Set(await client.listSubagents(session.nativeSessionId, { dir: scope.cwd }))].sort()
      signal?.throwIfAborted()
      if (agentIds.length > 32 || agentIds.some(id => !id || id.length > 512)) throw new Error('Native child roster exceeds its bound')
      const target = agentId ?? agentIds[0]
      if (!target) return { agentIds, messages: [], hasMore: false }
      if (!agentIds.includes(target)) throw new Error('Child transcript does not belong to this exact parent')
      const messages = await client.getSubagentMessages(session.nativeSessionId, target, { dir: scope.cwd, limit: 51, offset })
      signal?.throwIfAborted()
      if (messages.length > 51) throw new Error('Native child transcript page exceeds its bound')
      return { agentIds, agentId: target, messages: messages.slice(0, 50), hasMore: messages.length > 50 }
    },
  }
}

export async function readClaudeResponseOwner(input: {
  frame: Record<string, unknown>; client: ClaudeSdkClient; scope: ClaudeSessionScope;
  offered: ReadonlySet<string>; signal: AbortSignal;
}): Promise<readonly string[] | undefined> {
  const { frame } = input
  const messageId = (frame.message as { id?: unknown } | undefined)?.id
    ?? ((frame.event as { message?: { id?: unknown } } | undefined)?.message?.id)
  if (typeof messageId !== 'string' && typeof frame.uuid !== 'string') return undefined
  let owner: string | undefined
  const ancestry = new Map<string, string | undefined>()
  // Tool results continue the SDK's root ancestry chain; a prompt creates a new input boundary.
  for (let offset = 0; ; offset += 256) {
    input.signal.throwIfAborted()
    const page = await input.client.getSessionMessages(String(frame.session_id), { dir: input.scope.cwd, offset, limit: 256 })
    for (const raw of page) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as Record<string, unknown>
      if (entry.session_id !== frame.session_id || entry.parent_tool_use_id != null) continue
      const message = entry.message as { id?: unknown; content?: unknown } | undefined
      const parentOwner = typeof entry.parentUuid === 'string' ? ancestry.get(entry.parentUuid) : owner
      if (entry.type === 'user') {
        const content = message?.content
        const toolResult = Array.isArray(content) && content.some(block => block && typeof block === 'object'
          && (block as { type?: unknown }).type === 'tool_result')
        if (entry.isCompactSummary === true) {
          // The SDK omits parentUuid after selecting its native ancestry chain.
          owner = parentOwner
        } else if (!toolResult) {
          owner = typeof entry.uuid === 'string' ? entry.uuid : undefined
        } else {
          owner = parentOwner
        }
      } else {
        owner = parentOwner
      }
      if (typeof entry.uuid === 'string') ancestry.set(entry.uuid, owner)
      if (entry.type === 'assistant' && (entry.uuid === frame.uuid || messageId && message?.id === messageId)) {
        return owner && input.offered.has(owner) ? [owner] : undefined
      }
    }
    if (page.length < 256) return undefined
  }
}
