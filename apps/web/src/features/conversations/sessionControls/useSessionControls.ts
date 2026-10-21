import { useEffect } from 'react'
import { ApiError } from '../../../shared/api/client'
import { pendingControl, reservePendingControl, recoverPendingControl, clearPendingControl, type PendingControl } from './controlRequest'
import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { parseSessionCommand, type SessionControlRequest, type SessionControlState } from '@foreman-code/contracts'
import { sessionControlsApi } from '../../../shared/api/sessionControls'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import { useConversationDraftStore } from '../conversationDraftStore'

type Change = SessionControlRequest extends infer Request ? Request extends SessionControlRequest
  ? Omit<Request, 'requestId' | 'expectedRevision'> : never : never
type ControlAttempt = { input: Change; draft?: PendingControl['draft']; scope: string; requestId?: string }

function mergeSnapshot(previous: SessionControlState | undefined, incoming: SessionControlState) {
  if (!previous) return incoming
  if (previous.conversationId !== null && previous.conversationId !== incoming.conversationId
    || incoming.revision < previous.revision
    || previous.profileKey !== incoming.profileKey && incoming.revision === previous.revision) return previous
  return incoming
}

export function useSessionControls(conversationId: string | undefined, {
  workspaceId, context, executionId, enabled = true,
}: { workspaceId?: string; context?: AgentChatContext; executionId?: string | undefined; enabled?: boolean } = {}) {
  const client = useQueryClient()
  const generation = sessionGeneration()
  const target = context ? [context.workspaceId, context.workflowId, context.workflowNodeId,
    context.agentId, context.runId ?? null] : conversationId
  const scope = JSON.stringify([workspaceId ?? 'operator', target, executionId ?? null])
  const key = ['session-controls', generation, workspaceId ?? 'operator', conversationId, context, executionId]
  const query = useQuery({ queryKey: key, enabled: enabled && (!!conversationId || !!context),
    queryFn: async ({ signal }) => {
      const incoming = conversationId ? await sessionControlsApi.read(conversationId, workspaceId, { signal })
        : await sessionControlsApi.readContext(context!, executionId, { signal })
      assertSession(generation)
      if (conversationId && incoming.conversationId !== conversationId) {
        throw new Error('Session controls belong to another conversation. Refresh their status.')
      }
      return incoming
    },
    structuralSharing: (previous, incoming) => mergeSnapshot(previous as SessionControlState | undefined,
      incoming as SessionControlState),
    retry: false, refetchInterval: 3000 })
  useEffect(() => {
    if (query.data) void recoverPendingControl(scope, query.data).catch(error => console.error('Control recovery failed', error))
  }, [scope, query.data])
  const mutation = useMutation({ mutationKey: key, retry: false, networkMode: 'always',
    mutationFn: async (attempt: ControlAttempt) => {
      const { input, draft } = attempt
      assertSession(generation)
      const snapshot = query.data
      if (!snapshot) throw new Error('Session controls are loading. Refresh their status before trying again.')
      if (!conversationId && !context) throw new Error('Select a conversation or workflow node first.')
      const send = async (request: SessionControlRequest) => {
        try {
          const result = conversationId
            ? await sessionControlsApi.change(conversationId, request, workspaceId)
            : await sessionControlsApi.changeContext(context!, request, executionId)
          assertSession(generation)
          if (result.profileKey !== snapshot.profileKey
            || conversationId && result.conversationId !== conversationId) {
            throw new Error('Session controls belong to another conversation or native profile. Refresh their status.')
          }
          await recoverPendingControl(scope, result)
          // Keep cache writes bound to the target that started this request.
          client.setQueryData<SessionControlState>(key, previous => mergeSnapshot(previous, result))
          return result
        } catch (error) {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500
            && !error.code.endsWith('_UNCONFIRMED')) await clearPendingControl(scope, request.requestId)
          throw error
        }
      }
      let revision = snapshot.revision
      const previous = pendingControl(scope)
      try {
        if (previous) {
          const original = Object.fromEntries(Object.entries(previous.request)
            .filter(([field]) => field !== 'requestId' && field !== 'expectedRevision'))
          if (JSON.stringify(original) !== JSON.stringify(input)) {
            const recovered = await send(previous.request)
            revision = Math.max(revision, recovered.revision, client.getQueryData<SessionControlState>(key)?.revision ?? 0)
          }
        }
        const control = await reservePendingControl(scope, input, revision, draft)
        const request = control.request
        // Mutation variables retain the request ID if the response is lost.
        attempt.requestId = request.requestId
        if (!navigator.onLine) throw new Error('You are offline. Your draft is kept.')
        return await send(request)
      } finally {
        void client.invalidateQueries({ queryKey: key })
        void client.invalidateQueries({ queryKey: ['agent-chat'] })
      }
    },
  })
  const change = async (input: Change, draft?: { key: string; content: string }) => {
    if (client.getMutationCache().findAll({ mutationKey: key, exact: true }).some(entry => entry.state.status === 'pending')) throw new Error('A session control is still pending.')
    if (!query.data) throw new Error('Session controls are loading. Refresh their status before trying again.')
    return mutation.mutateAsync({ input, scope, ...(draft ? { draft } : {}) })
  }
  const command = async (content: string, draftKey: string) => {
    const parsed = parseSessionCommand(content)
    if (parsed.kind === 'invalid') throw new Error(parsed.message)
    if (parsed.kind !== 'compact' && parsed.kind !== 'mode') return false
    const state = await change(parsed, { key: draftKey, content })
    const compact = state.completedRequestId
      ? [state.compaction, ...state.compactions].find(entry => entry?.requestId === state.completedRequestId)
      : state.compaction
    if (parsed.kind === 'compact' && compact?.status === 'failed') throw new Error(compact.message)
    if (parsed.kind !== 'compact' || compact?.status === 'completed' || compact?.status === 'no-op') {
      useConversationDraftStore.getState().clearDraft(draftKey, content)
    }
    return true
  }
  const activeAttempt = mutation.variables?.scope === scope
  const requestId = activeAttempt ? mutation.variables?.requestId : undefined
  const compaction = requestId && query.data?.compaction?.requestId === requestId ? query.data.compaction
    : query.data?.compactions.find(entry => entry.requestId === requestId)
  let error = activeAttempt ? mutation.error : null
  if (compaction) error = compaction.status === 'failed' ? new Error(compaction.message) : null
  const scopedMutation = { ...mutation, isPending: activeAttempt && mutation.isPending, isError: error !== null, error }
  const commandFeedback = activeAttempt && mutation.variables?.draft
    ? { draft: mutation.variables.draft, compaction } : undefined
  return { state: query.data, conversationId, scope, query, mutation: scopedMutation, change, command, commandFeedback }
}
export type ComposerSessionControls = ReturnType<typeof useSessionControls>
