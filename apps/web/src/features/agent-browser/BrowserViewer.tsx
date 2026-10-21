import { useEffect, useRef, useState, type CompositionEvent, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
import { TextField } from '../../shared/ui/nocturne'
import type { BrowserController } from './controller'
import type { BrowserControllerSnapshot, PageFrame, PageGesture } from './types'

function useFrameUrl(frame: PageFrame | null): string | null {
  const [value, setValue] = useState<{ frame: PageFrame; url: string } | null>(null)
  useEffect(() => {
    if (!frame) return
    const url = URL.createObjectURL(frame.image)
    setValue({ frame, url })
    return () => { URL.revokeObjectURL(url) }
  }, [frame])
  return value?.frame === frame ? value.url : null
}

function pagePoint(event: PointerEvent<HTMLDivElement> | WheelEvent<HTMLDivElement>, frame: PageFrame) {
  const bounds = event.currentTarget.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return null
  const y = (event.clientY - bounds.top) * frame.height / bounds.height - (frame.viewportOffsetTop ?? 0)
  if (y < 0) return null
  return { x: Math.min(frame.width, Math.max(0, (event.clientX - bounds.left) * frame.width / bounds.width)),
    y: Math.min(frame.height - (frame.viewportOffsetTop ?? 0), y) }
}

export function BrowserViewer({ controller, snapshot, readOnly, onLeavePage }: {
  controller: BrowserController; snapshot: BrowserControllerSnapshot; readOnly: boolean; onLeavePage(): void
}) {
  const url = useFrameUrl(snapshot.frame)
  const keyboard = useRef<HTMLInputElement>(null)
  const writable = !readOnly && !snapshot.stale && snapshot.notice !== 'denied' && snapshot.notice !== 'closed'
  const send = (gesture: PageGesture) => { if (writable) void controller.send(gesture) }
  const pointer = (event: PointerEvent<HTMLDivElement>, phase: 'down' | 'up' | 'move') => {
    if (!snapshot.frame || !writable) return
    const point = pagePoint(event, snapshot.frame)
    if (!point) return
    if (phase === 'down') {
      event.preventDefault(); keyboard.current?.focus()
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    if (phase === 'move' && snapshot.notice !== 'user' && snapshot.notice !== 'taking') return
    send({ kind: 'pointer', phase, ...point, button: event.button, buttons: event.buttons })
  }
  const key = (event: KeyboardEvent<HTMLDivElement>, phase: 'down' | 'up') => {
    // Escape leaves page capture. Unmodified Tab navigates the remote page.
    if (event.key === 'Escape') { event.preventDefault(); keyboard.current?.blur(); onLeavePage(); return }
    if (!writable || event.nativeEvent.isComposing) return
    event.preventDefault()
    send({ kind: 'key', phase, key: event.key, code: event.code, alt: event.altKey,
      control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, repeat: event.repeat })
  }
  const composition = (event: CompositionEvent<HTMLDivElement>, phase: 'start' | 'update' | 'end') => {
    send({ kind: 'composition', phase, text: event.data })
  }
  return <div className="agent-browser-page" role="group" aria-label="Browser page" tabIndex={0}
    aria-describedby="browser-page-help" aria-disabled={!writable}
    style={{ aspectRatio: snapshot.frame ? `${snapshot.frame.width}/${snapshot.frame.height}` : '16/10' }}
    onFocus={event => { if (event.target === event.currentTarget && writable) keyboard.current?.focus() }}
    onPointerDown={event => pointer(event, 'down')} onPointerUp={event => pointer(event, 'up')}
    onPointerMove={event => pointer(event, 'move')} onKeyDown={event => key(event, 'down')}
    onKeyUp={event => key(event, 'up')} onCompositionStart={event => composition(event, 'start')}
    onCompositionUpdate={event => composition(event, 'update')} onCompositionEnd={event => composition(event, 'end')}
    onWheel={event => {
      if (!snapshot.frame || !writable) return
      const point = pagePoint(event, snapshot.frame)
      if (!point) return
      const bounds = event.currentTarget.getBoundingClientRect()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1
      event.preventDefault()
      send({ kind: 'wheel', ...point, deltaX: event.deltaX * unit * snapshot.frame.width / bounds.width,
        deltaY: event.deltaY * unit * snapshot.frame.height / bounds.height })
    }}>
    {url ? <img src={url} alt="Page in the selected agent browser" draggable={false}
      style={{ position: 'absolute', top: `${100 * (snapshot.frame!.viewportOffsetTop ?? 0) / snapshot.frame!.height}%`,
        height: `${100 * (1 - (snapshot.frame!.viewportOffsetTop ?? 0) / snapshot.frame!.height)}%` }} />
      : <p>{snapshot.notice === 'denied' ? 'Browser access is unavailable.' : 'Waiting for a browser image…'}</p>}
    <TextField label="Browser keyboard input" ref={keyboard} tabIndex={-1} className="agent-browser-keyboard"
      autoComplete="off" spellCheck={false} disabled={!writable}
      onPaste={event => { event.preventDefault(); send({ kind: 'composition', phase: 'end', text: event.clipboardData.getData('text/plain') }) }}
      onInput={event => { if (!(event.nativeEvent as InputEvent).isComposing) event.currentTarget.value = '' }} />
    {snapshot.stale && snapshot.frame ? <span className="agent-browser-stale">Last image · connection paused</span> : null}
  </div>
}
