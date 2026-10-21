import { useLayoutEffect, useId, type ReactNode, type RefObject } from 'react'
import { ArrowUp, CornerDownLeft, Square } from 'lucide-react'
import { parseSessionCommand, type SessionMode } from '@foreman-code/contracts'
import { IconButton, Textarea, Tooltip } from '../../../shared/ui/nocturne'
import { useConversationDraftStore } from '../conversationDraftStore'
import { useSlashCommandMenu } from '../sessionControls/useSlashCommandMenu'

export function AgentChatComposer({ name, draftKey, inputRef, disabled, reason, controlReason, pending, controlPending,
  hasAttachments, attachmentControl, actions, canStop, stopReason, onStop, onSubmit, deliveryActions, sessionCommands = true }: {
  name: string; draftKey: string; inputRef: RefObject<HTMLTextAreaElement | null>
  disabled: boolean; reason?: string; controlReason?: string
  pending: boolean; controlPending: boolean
  hasAttachments: boolean; attachmentControl?: ReactNode; actions?: ReactNode
  canStop: boolean; stopReason?: string; onStop(): void; onSubmit(content: string, mode?: SessionMode): void
  deliveryActions?: ReactNode; sessionCommands?: boolean
}) {
  const id = useId()
  const draft = useConversationDraftStore(store => store.drafts[draftKey] ?? '')
  const setDraft = useConversationDraftStore(store => store.setDraft)
  const command = parseSessionCommand(draft)
  const controlOnly = command.kind === 'compact' || command.kind === 'mode'
  const blocked = disabled || (controlOnly ? controlPending : pending) || !!reason || (!draft.trim() && !hasAttachments) || draft.length > 32_000
  const submit = (content = draft) => {
    const submitted = parseSessionCommand(content)
    const sessionCommand = submitted.kind === 'compact' || submitted.kind === 'mode' || submitted.kind === 'new'
    const unavailable = sessionCommand ? controlReason : reason
    const inFlight = sessionCommand ? controlPending : pending
    if (disabled || inFlight || unavailable || (!content.trim() && !hasAttachments) || content.length > 32_000) return
    onSubmit(content, submitted.kind === 'plan-task' ? 'plan' : undefined)
  }
  const menu = useSlashCommandMenu(draft, value => setDraft(draftKey, value), content => submit(content), true, sessionCommands)
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    const resize = () => {
      input.style.height = 'auto'
      const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20
      input.style.height = `${Math.min(input.scrollHeight, lineHeight * 8)}px`
    }
    resize()
    let width = input.clientWidth
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (input.clientWidth === width) return
      width = input.clientWidth
      resize()
    })
    observer?.observe(input)
    return () => observer?.disconnect()
  }, [draft, inputRef])
  return <form className="agent-chat-composer" aria-label="Conversation composer" aria-busy={pending || undefined}
    onSubmit={event => { event.preventDefault(); submit() }}>
    {menu.menu}
    <div className="agent-chat-input-box">
      {attachmentControl}
      <Textarea label="Message" className="agent-chat-field" id={id} ref={inputRef} rows={1} value={draft} maxLength={32_000} disabled={disabled}
        placeholder={reason && reason.length > 64 ? 'Messaging unavailable' : reason ?? `Message ${name}…`} aria-describedby={`${id}-hint`} {...menu.inputProps}
        onChange={event => { setDraft(draftKey, event.currentTarget.value); menu.reset() }}
        onKeyDown={event => {
          menu.onKeyDown(event)
          if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey
            || event.metaKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          event.preventDefault()
          submit()
        }} />
      {deliveryActions ? null : canStop ? <Tooltip content={stopReason ?? 'Stop this chat’s active turn and queued messages'}>
        <IconButton label="Stop chat" className="agent-chat-send" variant="ghost" disabled={pending || !!stopReason}
          onClick={onStop}><Square size={14} fill="currentColor" aria-hidden="true" /></IconButton>
      </Tooltip> : <Tooltip content={reason ?? 'Send message'}>
        <IconButton type="submit" label="Send message" className="agent-chat-send" variant="primary" disabled={blocked}>
          <ArrowUp size={18} aria-hidden="true" />
        </IconButton>
      </Tooltip>}
    </div>
    {/* A reason too long for the placeholder gets its own visible line, so a dead box always says why. */}
    {reason && reason.length > 64 ? <p id={`${id}-hint`} className="agent-chat-reason" title={reason}>{reason}</p>
      : <span id={`${id}-hint`} className="n-sr-only">{reason ?? 'Enter to send. Shift+Enter for a new line.'}</span>}
    <div className="agent-chat-composer-tools">
      {!deliveryActions && canStop ? <Tooltip content={reason ?? 'Queue a message for the next turn'}>
        <IconButton label="Queue message" variant="ghost" disabled={blocked} onClick={() => submit()}>
          <CornerDownLeft size={15} aria-hidden="true" />
        </IconButton>
      </Tooltip> : null}
      {actions}
    </div>
    {deliveryActions}
  </form>
}
