import { errorMessage } from '../../shared/errorMessage'
import { parseSessionCommand, type SessionMode } from '@foreman-code/contracts'
import { useSlashCommandMenu } from './sessionControls/useSlashCommandMenu'
import type { ComposerSessionControls } from './sessionControls/useSessionControls'
import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { MessageComposer } from '../../shared/ui/nocturne'
import { useConversationDraftStore } from './conversationDraftStore'

export interface ConversationComposerProps {
  conversationId: string
  /** Disable both editing and submission. */
  disabled?: boolean
  /** Block submission without locking the draft. */
  sendDisabled?: boolean
  /** Existing callers keep their original in-flight editing behavior. */
  allowEditingWhileSending?: boolean
  isSending?: boolean
  attachmentControl?: ReactNode
  hasAttachments?: boolean
  error?: string
  sendLabel?: string
  maxLength?: number
  inputRef?: RefObject<HTMLTextAreaElement | null>
  sessionControls?: ComposerSessionControls
  onSubmit: (content: string, mode?: SessionMode) => void
}

/** A local draft composer; it never sends anything without its parent callback. */
export function ConversationComposer({
  conversationId,
  disabled = false,
  sendDisabled = false,
  allowEditingWhileSending = false,
  isSending = false,
  attachmentControl,
  hasAttachments = false,
  error,
  sendLabel = 'Send message',
  maxLength,
  inputRef,
  onSubmit,
  sessionControls,
}: ConversationComposerProps) {
  const localRef = useRef<HTMLTextAreaElement>(null)
  const field = inputRef ?? localRef
  const draft = useConversationDraftStore((state) => state.drafts[conversationId] ?? '')
  const setDraft = useConversationDraftStore((state) => state.setDraft)

  const [commandError, setCommandError] = useState<{ conversationId: string; content: string; message: string }>()
  const parsed = parseSessionCommand(draft)
  const commandOnly = parsed.kind === 'compact' || parsed.kind === 'mode'
  const submit = async (content: string) => {
    const command = parseSessionCommand(content)
    const controlOnly = command.kind === 'compact' || command.kind === 'mode'
    const pending = controlOnly ? sessionControls?.mutation.isPending : isSending
    if (disabled || pending || (!controlOnly && sendDisabled) || content.length > (maxLength ?? 16000)) return
    setCommandError(undefined)
    try {
      if (command.kind === 'invalid') throw new Error(command.message)
      if (command.kind === 'compact' || command.kind === 'mode') {
        if (!sessionControls) throw new Error('Native controls are unavailable for this conversation.')
        await sessionControls.command(content, conversationId)
      } else if (command.kind === 'new') throw new Error('/new is available in Operator chat.')
      else if (command.kind === 'plan-task') onSubmit(content.trim(), 'plan')
      else onSubmit(content.trim())
    } catch (failure) {
      setCommandError({ conversationId, content,
        message: errorMessage(failure, 'The native command could not be confirmed.') })
    }
    field.current?.focus({ preventScroll: true })
  }
  const feedback = sessionControls?.commandFeedback
  const compaction = feedback?.draft.key === conversationId && feedback.draft.content === commandError?.content
    ? feedback.compaction : undefined
  const recovered = !!compaction && compaction.status !== 'failed'
  const menu = useSlashCommandMenu(draft, value => { setDraft(conversationId, value); setCommandError(undefined) },
    content => { void submit(content) })
  return (
    <MessageComposer
      footerControl={attachmentControl}
      commandMenu={menu.menu}
      commandInputProps={menu.inputProps}
      onInputKeyDown={menu.onKeyDown}
      hasAttachments={hasAttachments}
      formLabel="Conversation composer"
      label="Message"
      placeholder="Write a message for this agent"
      sendLabel={sendLabel}
      maxLength={maxLength}
      inputRef={field}
      value={draft}
      onValueChange={(value) => { setDraft(conversationId, value); menu.reset(); setCommandError(undefined) }}
      onSend={(content) => { void submit(content) }}
      pending={commandOnly ? sessionControls?.mutation.isPending : isSending}
      disabled={disabled || (isSending && !allowEditingWhileSending)}
      sendDisabled={commandOnly ? sessionControls?.mutation.isPending : sendDisabled}
      error={(commandError?.conversationId === conversationId && !recovered
        ? compaction?.message ?? commandError.message : undefined)
        ?? (error ? `Message could not be sent: ${error}` : undefined)}
    />
  )
}
