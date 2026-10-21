import { errorMessage } from '../../shared/errorMessage'
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { parseSessionCommand, type SessionMode } from '@foreman-code/contracts'
import { Icon, IconButton } from '../../shared/ui/nocturne'
import { useConversationDraftStore } from '../conversations'
import type { useFileDrop } from '../../shared/ui/useFileDrop'
import { useSlashCommandMenu } from '../conversations/sessionControls/useSlashCommandMenu'
import type { ComposerSessionControls } from '../conversations/sessionControls/useSessionControls'
import { ChatPrimaryActions } from '../conversations/ChatPrimaryActions'
import '../conversations/chatAttachments.css'

export function OperatorComposer({ conversationId, context, attachmentControl, fileDropProps, hasAttachments = false,
  sendDisabled = false, isSending = false, onSubmit, onNewChat, onCancel, sessionControls }: {
  conversationId: string; context?: ReactNode; attachmentControl?: ReactNode; hasAttachments?: boolean;
  sendDisabled?: boolean; isSending?: boolean; sessionControls?: ComposerSessionControls;
  fileDropProps?: ReturnType<typeof useFileDrop>['dropTargetProps'];
  onSubmit(content: string, mode?: SessionMode): void; onNewChat(): void; onCancel?: () => void;
}) {
  const value = useConversationDraftStore((state) => state.drafts[conversationId] ?? '')
  const setDraft = useConversationDraftStore((state) => state.setDraft)
  const input = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const [commandError, setCommandError] = useState<{ conversationId: string; content: string; message: string }>()
  const command = parseSessionCommand(value)
  const commandOnly = command.kind === 'compact' || command.kind === 'mode'
  const isNew = command.kind === 'new'
  const pending = commandOnly ? sessionControls?.mutation.isPending : isSending
  const cannotSend = (!isNew && (pending || (!commandOnly && sendDisabled))) || (!value.trim() && !hasAttachments)
  useLayoutEffect(() => {
    if (!input.current) return
    input.current.style.height = '0px'
    input.current.style.height = `${Math.min(144, Math.max(36, input.current.scrollHeight))}px`
  }, [value])
  useLayoutEffect(() => { input.current?.focus() }, [conversationId])
  async function send(content = value.trim()) {
    const parsed = parseSessionCommand(content)
    const controlOnly = parsed.kind === 'compact' || parsed.kind === 'mode'
    const blocked = controlOnly ? sessionControls?.mutation.isPending : isSending || sendDisabled
    if (parsed.kind !== 'new' && (blocked || (!content.trim() && !hasAttachments))) return
    setCommandError(undefined)
    try {
      if (parsed.kind === 'invalid') throw new Error(parsed.message)
      if (parsed.kind === 'new') onNewChat()
      else if (parsed.kind === 'compact' || parsed.kind === 'mode') {
        if (!sessionControls) throw new Error('Native controls are unavailable for this conversation.')
        await sessionControls.command(content, conversationId)
      } else if (parsed.kind === 'plan-task') onSubmit(content, 'plan')
      else onSubmit(content)
    } catch (failure) {
      setCommandError({ conversationId, content,
        message: errorMessage(failure, 'The native command could not be confirmed.') })
    }
  }
  const feedback = sessionControls?.commandFeedback
  const compaction = feedback?.draft.key === conversationId && feedback.draft.content === commandError?.content
    ? feedback.compaction : undefined
  const recovered = !!compaction && compaction.status !== 'failed'
  const menu = useSlashCommandMenu(value, content => setDraft(conversationId, content), content => { void send(content) }, true)
  return <form className="operator-composer" aria-label="Conversation composer" {...fileDropProps}
    onSubmit={event => { event.preventDefault(); void send() }}>
    {menu.menu}
    <label htmlFor={id} className="n-sr-only">Message</label>
    {/* One compact block: attach, message and send share a row; agent settings sit in a quiet row below.
        Attachment chips wrap above the input row. */}
    <div className="operator-composer-input">
      {attachmentControl}
      {/* eslint-disable-next-line no-restricted-syntax -- combobox textarea uses the shared slash menu. */}
      <textarea ref={input} id={id} rows={1} value={value} maxLength={16000} placeholder="Message the operator…" {...menu.inputProps}
        onChange={event => { setDraft(conversationId, event.target.value); menu.reset(); setCommandError(undefined) }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || menu.onKeyDown(event)) return
          if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault(); void send()
          }
        }} />
      <div className="operator-composer-actions">
        <ChatPrimaryActions appearance="icon" stopLabel="Stop response" {...(onCancel ? { onStop: onCancel } : {})}>
          <IconButton label="Send message" type="submit" disabled={cannotSend} className="operator-composer-send" loading={pending}><Icon name="arrow" className="operator-send-arrow" size={17} /></IconButton>
        </ChatPrimaryActions>
      </div>
    </div>
    <div className="operator-composer-options">
      <div className="operator-composer-model">{context}</div>
    </div>
    {commandError?.conversationId === conversationId && !recovered
      ? <p role="alert">{compaction?.message ?? commandError.message}</p> : null}
  </form>
}
