import { useId, type ReactNode, type Ref, type KeyboardEventHandler, type TextareaHTMLAttributes } from 'react'
import { Button } from './Button'
import { InfoHint } from '../InfoHint'
import { Avatar } from './Layout'
import { Icon, type IconName } from './Icon'
import { Badge } from './Feedback'
import { cx, type Tone } from './utils'

export function MessageBubble({ author, role = 'assistant', children, time, dateTime, status, actions }:
  { author: string; role?: 'user' | 'assistant' | 'system'; children: ReactNode; time?: string; dateTime?: string; status?: ReactNode; actions?: ReactNode }) {
  return <article className={cx('n-message', `n-message--${role}`)} aria-label={`Message from ${author}`}>
    <Avatar name={author} size="sm" tone={role === 'user' ? 'neutral' : 'accent'} />
    <div className="n-message-main"><header><strong>{author}</strong>{time && <time dateTime={dateTime}>{time}</time>}{status}</header>
      <div className="n-message-content">{children}</div>{actions && <div className="n-actions n-message-actions">{actions}</div>}
  </div></article>
}

/** The caller owns the draft and mutation. Rejected sends never erase the draft here. */
export function MessageComposer({ value, onValueChange, onSend, pending = false, disabled = false, sendDisabled = false, hasAttachments = false, error, onStop, maxLength = 16000,
  label = 'Message the operator', placeholder = 'Describe what you want to do…', sendLabel = 'Send', pendingLabel = 'Sending…', formLabel, context, footerControl, inputRef, commandMenu, onInputKeyDown, commandInputProps }:
  { value: string; onValueChange: (value: string) => void; onSend: (value: string) => void; pending?: boolean; disabled?: boolean; sendDisabled?: boolean; hasAttachments?: boolean; error?: string;
    onStop?: () => void; maxLength?: number; label?: string; placeholder?: string; sendLabel?: string; pendingLabel?: string; formLabel?: string; context?: ReactNode; footerControl?: ReactNode; inputRef?: Ref<HTMLTextAreaElement>; commandMenu?: ReactNode; onInputKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>; commandInputProps?: Pick<TextareaHTMLAttributes<HTMLTextAreaElement>, 'aria-controls' | 'aria-expanded' | 'aria-autocomplete' | 'aria-activedescendant'> }) {
  const id = useId()
  const limit = Number.isFinite(maxLength) ? Math.max(1, Math.floor(maxLength)) : 16000
  const cannotSend = disabled || sendDisabled || pending || (!value.trim() && !hasAttachments) || value.length > limit
  function send() { if (!cannotSend) onSend(value) }
  return <form className="n-composer" onSubmit={(event) => { event.preventDefault(); send() }} aria-label={formLabel} aria-busy={pending || undefined}>
    {context && <div className="n-composer-context">{context}</div>}
    {commandMenu}
    <label className="n-sr-only" htmlFor={id}>{label}</label>
    <textarea {...commandInputProps} ref={inputRef} id={id} className="n-input" value={value} maxLength={limit} placeholder={placeholder} disabled={disabled}
      aria-invalid={Boolean(error) || value.length > limit || undefined}
      aria-describedby={`${id}-hint ${id}-count${error ? ` ${id}-error` : ''}`}
      onChange={(event) => onValueChange(event.currentTarget.value)} onKeyDown={(event) => {
        onInputKeyDown?.(event)
        if (event.defaultPrevented) return
        if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        event.preventDefault(); send()
      }} />
    <footer><span><span id={`${id}-hint`} hidden>Enter to send · Shift + Enter for a new line</span>
      <InfoHint label={label}>Enter to send · Shift + Enter for a new line</InfoHint>
      <span id={`${id}-count`} className="n-composer-count">{value.length.toLocaleString()} / {limit.toLocaleString()}</span></span>
      <div className="n-actions">{footerControl}{pending && onStop && <Button variant="secondary" disabled={disabled} leading={<Icon name="stop" size={14} />} onClick={onStop}>Stop</Button>}
        <Button type="submit" variant="primary" disabled={cannotSend} loading={pending} loadingLabel={pendingLabel} trailing={<Icon name="arrow" size={15} />}>{sendLabel}</Button></div>
    </footer>{error && <p className="n-field-error" id={`${id}-error`} role="alert">{error}</p>}
  </form>
}

export function ToolCallCard({ title, status, tone = 'neutral', summary, children }:
  { title: string; status: string; tone?: Tone; summary?: string; children?: ReactNode }) {
  return <details className="n-tool-call"><summary><Icon name="terminal" size={16} /><strong>{title}</strong><Badge tone={tone}>{status}</Badge><Icon name="down" size={14} /></summary>
    <div>{summary && <p>{summary}</p>}{children}</div></details>
}

/** Only pass metadata the current caller may read. No inferred paths or download endpoints. */
export function ArtifactCard({ title, description, metadata, icon = 'code', onOpen, disabled = false }:
  { title: string; description?: string; metadata?: string; icon?: IconName; onOpen?: () => void; disabled?: boolean }) {
  return <div className="n-artifact"><span className="n-artifact-icon"><Icon name={icon} size={22} /></span><div><strong>{title}</strong>{description && <p>{description}</p>}{metadata && <small>{metadata}</small>}</div>
    {onOpen && <Button size="sm" disabled={disabled} onClick={onOpen} aria-label={`Open ${title}`}>Open<Icon name="external" size={13} /></Button>}</div>
}
