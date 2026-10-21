import { useSessionControls } from '../sessionControls/useSessionControls'
import { compactionBlocksSend, parseSessionCommand, type SessionMode } from '@foreman-code/contracts'
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentChatIntent, SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { useConversationAttachments } from '../../attachments'

import { prepareChatAttachments } from '../chatAttachmentAttempt'

import { useAgentChat } from './useAgentChat'
import { selectedRunChatApi } from './selectedRunChatClient'
import { agentChatApi } from '../../../shared/api/agentChat'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import { useConversationDraftStore } from '../conversationDraftStore'
import { stateBelongsToContext } from './model'

export function useAgentConversationComposer({ chat, state, sessionControls, attachments, draft }: {
  chat: ReturnType<typeof useAgentChat>
  state: ReturnType<typeof useAgentChat>['state']
  sessionControls: ReturnType<typeof useSessionControls>
  attachments: ReturnType<typeof useConversationAttachments>
  draft: string
}) {
  const composer = useRef<HTMLTextAreaElement>(null), focused = useRef(false)
  const [sendAgainDraft, setSendAgain] = useState<Pick<SendAgentChatMessageRequest,
    'content' | 'attachments' | 'sessionMode'> & { draftKey: string }>()
  const sendAgain = sendAgainDraft?.draftKey === chat.draftKey ? sendAgainDraft : undefined
  const resendCommand = parseSessionCommand(sendAgain?.content ?? '')
  const resendControl = resendCommand.kind === 'compact' || resendCommand.kind === 'mode'
  const resendPending = chat.pending || resendControl && sessionControls.mutation.isPending
  const [commandError, setCommandError] = useState<{ draftKey: string; content: string; message: string }>()
  const client = useQueryClient()
  const generation = sessionGeneration()
  const newInFlight = useRef(false)
  const startNew = useMutation({
    mutationKey: ['agent-chat-new', generation, chat.draftKey], retry: false, networkMode: 'always',
    mutationFn: async (input: { requestId: string; expectedConversationId: string | null; draftContent: string }) => {
      assertSession(generation)
      if (!state) throw new Error('Refresh this conversation before starting a new one.')
      const { workspaceId, ...context } = state.context
      const result = chat.selection ? await selectedRunChatApi.send(chat.selection, { requestId: input.requestId,
        context, content: '/new', intent: 'next_turn', expectedConversationId: input.expectedConversationId, attachments: [] })
        : await agentChatApi.startNew({ workspaceId, ...context }, input.expectedConversationId, input.requestId)
      assertSession(generation)
      if (!('reset' in result) || result.reset.requestId !== input.requestId
        || result.reset.previousConversationId !== input.expectedConversationId
        || !stateBelongsToContext(result.state, state.context)) {
        throw new Error('The response did not confirm the new conversation.')
      }
      const key = chat.queryKey
      await client.cancelQueries({ queryKey: key, exact: true })
      assertSession(generation)
      client.setQueryData(key, result.state)
      useConversationDraftStore.getState().clearDraft(chat.draftKey, input.draftContent)
      chat.refresh()
      return result
    },
  })
  const commandCompaction = sessionControls.commandFeedback?.draft.content === commandError?.content
    ? sessionControls.commandFeedback?.compaction : undefined
  useEffect(() => {
    if (!state || focused.current || !composer.current) return
    const active = document.activeElement
    const surface = composer.current.closest('.agent-chat-window, .n-agent-popover, .workflow-side-panel')
    if (!active || active === document.body || active === surface
      || active.matches('.n-agent-action--chat[aria-expanded="true"]')
      || active.getAttribute('role') === 'tab' && surface?.contains(active)) {
      focused.current = true
      composer.current.focus({ preventScroll: true })
    }
  }, [state])
  const focus = () => composer.current?.focus({ preventScroll: true })
  const submit = async (intent: AgentChatIntent, content = draft, sessionMode?: SessionMode,
    resend?: Pick<SendAgentChatMessageRequest, 'attachments'>) => {
    const command = parseSessionCommand(content)
    setCommandError(undefined)
    try {
      if (command.kind === 'invalid') throw new Error(command.message)
      if (command.kind === 'compact' || command.kind === 'mode') {
        return await sessionControls.command(content, resend ? `${chat.draftKey}:resend` : chat.draftKey)
      }
      if (command.kind === 'new') {
        if (chat.pending || startNew.isPending || newInFlight.current) return false
        const denied = chat.blocked('agent_chat:write')
        if (denied) throw new Error(denied)
        const expectedConversationId = state?.conversation?.id ?? null
        const retry = startNew.isError && startNew.variables?.expectedConversationId === expectedConversationId
          ? startNew.variables : undefined
        newInFlight.current = true
        try {
          await startNew.mutateAsync(retry ?? { requestId: crypto.randomUUID(), expectedConversationId,
            draftContent: useConversationDraftStore.getState().drafts[chat.draftKey] ?? '' })
        } finally { newInFlight.current = false }
        return true
      }
      const mode = command.kind === 'plan-task' ? 'plan' : sessionMode ?? sessionControls.state?.desiredMode
      if (intent === 'steer' && mode === 'plan') return false
      if (compactionBlocksSend(sessionControls.state?.compaction ?? null)) return false
      const attempt = resend ? { attachments: resend.attachments ?? [] } : prepareChatAttachments(attachments)
      return !!attempt && chat.send(content, intent, !resend, !!resend, attempt, mode)
    } catch (failure) {
      setCommandError({ draftKey: chat.draftKey, content,
        message: failure instanceof Error ? failure.message : 'The native command could not be confirmed.' })
      return false
    } finally {
      focus()
    }
  }
  return { composer, sendAgain, setSendAgain, resendCommand, resendControl, resendPending,
    commandError, commandCompaction, newPending: startNew.isPending, focus, submit }
}
