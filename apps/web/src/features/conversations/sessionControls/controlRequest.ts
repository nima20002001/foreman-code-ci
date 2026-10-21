import { z } from 'zod'
import { SessionControlRequestSchema, compactionBlocksSend, type SessionControlState, type SessionControlRequest } from '@foreman-code/contracts'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { assertSession, sessionGeneration, sessionSignal } from '../../../shared/api/sessionBoundary'
import { useConversationDraftStore } from '../conversationDraftStore'

const PendingControlSchema = z.object({
  request: SessionControlRequestSchema,
  draft: z.object({ key: z.string(), content: z.string() }).optional(),
}).strict()
export type PendingControl = z.infer<typeof PendingControlSchema>

function storageKey(scope: string) { return protectedKey('outbox', `session-control:${scope}`) }
export function pendingControl(scope: string): PendingControl | null {
  const raw = localStorage.getItem(storageKey(scope))
  return raw === null ? null : PendingControlSchema.parse(JSON.parse(raw))
}
type ControlChange = SessionControlRequest extends infer Request ? Request extends SessionControlRequest
  ? Omit<Request, 'requestId' | 'expectedRevision'> : never : never

async function exclusive<T>(scope: string, work: () => T): Promise<T> {
  const generation = sessionGeneration()
  const key = storageKey(scope)
  return navigator.locks.request(key, { mode: 'exclusive', signal: sessionSignal() }, () => {
    assertSession(generation)
    return work()
  })
}

export function reservePendingControl(scope: string, input: ControlChange, expectedRevision: number,
  draft?: PendingControl['draft']): Promise<PendingControl> {
  return exclusive(scope, () => {
    const pending = pendingControl(scope)
    if (pending) {
      const original = Object.fromEntries(Object.entries(pending.request)
        .filter(([field]) => field !== 'requestId' && field !== 'expectedRevision'))
      if (JSON.stringify(original) !== JSON.stringify(input)) {
        throw new Error('Recover the previous session control before changing settings.')
      }
      if (draft && !pending.draft) pending.draft = draft
    }
    const control = pending ?? { request: { ...input, requestId: crypto.randomUUID(), expectedRevision },
      ...(draft ? { draft } : {}) }
    localStorage.setItem(storageKey(scope), JSON.stringify(PendingControlSchema.parse(control)))
    return control
  })
}

export function clearPendingControl(scope: string, requestId: string): Promise<void> {
  return exclusive(scope, () => {
    if (pendingControl(scope)?.request.requestId === requestId) localStorage.removeItem(storageKey(scope))
  })
}

export function recoverPendingControl(scope: string, state: SessionControlState): Promise<void> {
  return exclusive(scope, () => {
    const pending = pendingControl(scope)
    if (!pending) return
    const { request, draft } = pending
    const compact = state.compaction?.requestId === request.requestId ? state.compaction
      : state.compactions.find(entry => entry.requestId === request.requestId)
    if (request.kind === 'compact') {
      if (!compact || compactionBlocksSend(compact)) return
      if (compact.status !== 'failed' && draft) {
        useConversationDraftStore.getState().clearDraft(draft.key, draft.content)
      }
    } else {
      if (state.lastRequestId !== request.requestId && state.completedRequestId !== request.requestId) return
      if (draft) useConversationDraftStore.getState().clearDraft(draft.key, draft.content)
    }
    localStorage.removeItem(storageKey(scope))
  })
}
