import { useCallback, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { OperatorConversationState } from '@foreman-code/contracts'
import { newerOperatorConversationState as newer } from './operatorConversationReadback'
import { ApiError, getOperatorConversation } from '../../shared/api/client'
import { listOperatorConversationSummaries } from '../../shared/api/operatorChatSummaries'
import { useAccessFailureLatch } from '../../shared/api/useAccessFailureLatch'
import { SessionChangedError } from '../../shared/api/sessionBoundary'
import { newerOperatorSummaries, summarizeOperatorConversation } from './operatorChatStatus'
import { useOperatorChatStore } from './operatorChatStore'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { mergeOperatorActivity } from '../../shared/api/operatorActivity'
import { readObservedOperatorActivity, updateObservedOperatorActivity, type OperatorActivityHistory } from './operatorActivityReadback'
import { detailKey, listKey, type Summaries } from './operatorChatShared'

/** Query-owned conversation list and selected-conversation readback. */
export function useOperatorChatReadback(enabled: boolean, open: boolean, selectedId: string | undefined, externalDenial = false) {
  const queryClient = useQueryClient()
  const historyLimit = useRef(10)
  const deletedRevisions = useRef(new Map<string, number>())
  const readGeneration = useRef(0)
  useEffect(() => {
    if (!externalDenial || !selectedId) return
    readGeneration.current++
    const matches = (query: { queryKey: readonly unknown[] }) => query.queryKey[0] === 'operator-chat'
      && (query.queryKey.includes(selectedId) || JSON.stringify(query.queryKey) === JSON.stringify(listKey))
    void queryClient.cancelQueries({ predicate: matches })
    queryClient.removeQueries({ predicate: matches })
  }, [externalDenial, queryClient, selectedId])
  const list = useQuery({ queryKey: listKey, enabled: enabled && open && !externalDenial,
    queryFn: async ({ signal }) => {
      const next = await listOperatorConversationSummaries({ signal }, historyLimit.current)
      const current = queryClient.getQueryData<Summaries>(listKey)
      const visible = next.conversations.flatMap(item => {
        const deletedRevision = deletedRevisions.current.get(item.conversationId)
        if (deletedRevision === undefined || item.revision > deletedRevision) return [item]
        const restored = current?.conversations.find(entry => entry.conversationId === item.conversationId
          && entry.revision > deletedRevision)
        return restored ? [restored] : []
      })
      const conversations = newerOperatorSummaries(current?.conversations, visible).map((item) => {
        const detail = queryClient.getQueryData<OperatorConversationState>(detailKey(item.conversationId))
        return detail && detail.revision > item.revision ? summarizeOperatorConversation(detail) : item
      })
      return { ...next, conversations }
    } })
  const listDenied = useAccessFailureLatch(list)
  const selected = useQuery({ queryKey: detailKey(selectedId ?? ''), enabled: enabled && open && !listDenied && !externalDenial && Boolean(selectedId),
    queryFn: async ({ signal }) => {
      const read = ++readGeneration.current
      const id = selectedId ?? ''
      const state = await getOperatorConversation(id, { signal })
      if (state.conversation.id !== selectedId) throw new SessionChangedError()
      const current = queryClient.getQueryData<OperatorConversationState>(detailKey(id))
      const activityKey = ['operator-chat', 'activity', id, identityEpoch()]
      const history = queryClient.getQueryData<OperatorActivityHistory>(activityKey)
      const updates = await readObservedOperatorActivity(current, state, history, signal)
      signal.throwIfAborted()
      if (read !== readGeneration.current) throw new DOMException('Newer readback required', 'AbortError')
      queryClient.setQueryData<OperatorActivityHistory>(activityKey, previous =>
        updateObservedOperatorActivity(previous, updates))
      return newer(queryClient.getQueryData<OperatorConversationState>(detailKey(id)),
        { ...state, activities: mergeOperatorActivity(state.activities ?? [], updates) }, 'read')
    }, retry: false })
  const selectedDenied = useAccessFailureLatch(selected)
  const accessDenied = listDenied || selectedDenied || externalDenial
  const acceptState = useCallback((id: string, state: OperatorConversationState) => {
    if (state.revision <= (deletedRevisions.current.get(id) ?? -1) || state.conversation.id !== id) return
    const denial = queryClient.getQueryState(detailKey(id))?.error
    if (ApiError.is(denial) && [401, 403].includes(denial.status)) return
    if (useOperatorChatStore.getState().selectedConversationId === id) readGeneration.current++
    const accepted = newer(queryClient.getQueryData<OperatorConversationState>(detailKey(id)), state)
    queryClient.setQueryData(detailKey(id), accepted)
    const summary = summarizeOperatorConversation(accepted)
    queryClient.setQueryData<Summaries>(listKey, (current) => {
      if (!current) return current
      if (!accepted.messages.length && !accepted.hasEarlierMessages) {
        return { ...current, conversations: current.conversations.filter(item => item.conversationId !== id) }
      }
      return {
        ...current, conversations: current.conversations.some((item) => item.conversationId === id)
          ? current.conversations.map((item) => item.conversationId === id && summary.revision >= item.revision ? summary : item)
          : [summary, ...current.conversations],
      }
    })
  }, [queryClient])
  const invalidate = async (id: string) => { await Promise.all([
    queryClient.invalidateQueries({ queryKey: detailKey(id) }), queryClient.invalidateQueries({ queryKey: listKey }),
  ]) }
  function loadOlderChats() {
    if (!list.data?.hasMore || list.isFetching || accessDenied) return
    historyLimit.current += 10
    void list.refetch()
  }
  return { list, selected, accessDenied, acceptState, invalidate, loadOlderChats, deletedRevisions, readGeneration }
}
