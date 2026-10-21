import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { Icon, IconButton } from '../../../shared/ui/nocturne'
import { useFloatingZ } from '../../../shared/ui/floatingStack'
import {
  WindowCloseContext, chatWindowKey, clampFrame, defaultFrame, resizeFrame, useChatWindowsStore,
  type ChatWindowAnchor, type ChatWindowBounds, type ChatWindowFrame, type ResizeEdge,
} from './agentChatWindows'
import './agentChatWindows.css'

export type AgentChatWindowContent = {
  name: string; harness?: string; chat: ReactNode
  /** False when the chat has no header of its own (for example the Save-first notice). */
  chatHasHeader?: boolean
}

const EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const INTERACTIVE = 'button, a, input, select, textarea, summary, label, [role=button], [role=combobox], [role=menu], [role=tab]'

function useBounds(layer: RefObject<HTMLElement | null>) {
  const [bounds, setBounds] = useState<ChatWindowBounds>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = layer.current
    if (!element) return
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      setBounds((current) => current.width === width && current.height === height ? current : { width, height })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [layer])
  return bounds
}

/**
 * Floating chat windows over one Board view. Windows are NOT modal Dialogs: they are non-modal
 * regions the person keeps open while working, so the backdrop-dismiss rule for modal dialogs
 * does not apply. Only a window's own X (or Escape while focus is inside it) closes it.
 */
export function AgentChatWindowLayer({ scope, content }: { scope: string; content: (nodeId: string) => AgentChatWindowContent | undefined }) {
  const ids = useChatWindowsStore((state) => state.open[scope])
  const layer = useRef<HTMLDivElement>(null)
  const bounds = useBounds(layer)
  // Where the Agent node sits inside the layer, so a new window can open beside it instead of on top of it.
  const locate = (nodeId: string): ChatWindowAnchor | undefined => {
    const area = layer.current, node = area?.parentElement?.querySelector(`.react-flow__node[data-id="${nodeId.replace(/["\\]/g, '\\$&')}"]`)
    if (!area || !node) return undefined
    const box = area.getBoundingClientRect(), rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 ? { x: rect.left - box.left, y: rect.top - box.top, width: rect.width, height: rect.height } : undefined
  }
  return <div ref={layer} className="agent-chat-window-layer">
    {(ids ?? []).map((id, index) => {
      const item = content(id)
      return item ? <AgentChatWindow key={id} scope={scope} nodeId={id} index={index} bounds={bounds} locate={locate} content={item} /> : null
    })}
  </div>
}

function AgentChatWindow({ scope, nodeId, index, bounds, locate, content }: {
  scope: string; nodeId: string; index: number; bounds: ChatWindowBounds; locate: (nodeId: string) => ChatWindowAnchor | undefined
  content: AgentChatWindowContent
}) {
  const key = chatWindowKey(scope, nodeId)
  const stored = useChatWindowsStore((state) => state.frames[key])
  const zIndex = useFloatingZ(key)
  const focusTick = useChatWindowsStore((state) => state.focus[key])
  const { setFrame, raise, closeWindow } = useChatWindowsStore.getState()
  const root = useRef<HTMLElement>(null)
  const [opener] = useState<Element | null>(() => document.activeElement)
  const heldFocus = useRef(false)
  const frame = clampFrame(stored ?? defaultFrame(bounds, index), bounds)
  const frameRef = useRef(frame)
  frameRef.current = frame
  // First placement only: later positions belong to the person.
  useLayoutEffect(() => { if (!stored) setFrame(scope, nodeId, clampFrame(defaultFrame(bounds, index, locate(nodeId)), bounds)) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // Narrow screens show the window as a sheet sized to the visible viewport (the keyboard shrinks it).
  useEffect(() => {
    const viewport = window.visualViewport
    const size = () => {
      root.current?.style.setProperty('--agent-chat-viewport-width', `${viewport?.width ?? window.innerWidth}px`)
      root.current?.style.setProperty('--agent-chat-viewport-height', `${viewport?.height ?? window.innerHeight}px`)
      // The sheet sits on the bottom edge of the visible viewport, above an on-screen keyboard.
      const layerBottom = root.current?.parentElement?.getBoundingClientRect().bottom ?? 0
      const hidden = viewport ? Math.max(0, layerBottom - (viewport.offsetTop + viewport.height)) : 0
      root.current?.style.setProperty('--agent-chat-keyboard-inset', `${hidden}px`)
    }
    size()
    viewport?.addEventListener('resize', size); viewport?.addEventListener('scroll', size)
    return () => { viewport?.removeEventListener('resize', size); viewport?.removeEventListener('scroll', size) }
  }, [])
  // The person asked for this Agent: take focus now (so keyboard works at once), then move it to the
  // message box once that exists and can take text.
  useLayoutEffect(() => {
    const element = root.current
    if (element && !element.contains(document.activeElement)) { element.focus({ preventScroll: true }); heldFocus.current = true }
    const handle = requestAnimationFrame(() => {
      const field = element?.querySelector<HTMLElement>('textarea:not(:disabled)')
      if (field && element?.contains(document.activeElement) && document.activeElement === element) field.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(handle)
  }, [focusTick])
  const close = () => {
    // Focus goes back to what opened the window before it unmounts, so it never falls to the page body.
    if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('.agent-chat-window')) opener.focus({ preventScroll: true })
    closeWindow(scope, nodeId)
  }
  const closeRef = useRef(close)
  closeRef.current = close
  // Escape closes the window that holds focus (or just lost it because a focused control went away).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const element = root.current, active = document.activeElement
      if (event.key !== 'Escape' || event.defaultPrevented || !element) return
      const inside = element.contains(active), orphaned = heldFocus.current && (!active || active === document.body)
      // An inner surface (menu, confirmation) closes first.
      if (!(inside || orphaned) || document.querySelector('dialog[open]') || active?.closest('[role=listbox], .n-menu')) return
      event.preventDefault(); closeRef.current()
    }
    const onFocus = (event: FocusEvent) => { heldFocus.current = !!root.current?.contains(event.target as Node | null) }
    document.addEventListener('keydown', onKey); document.addEventListener('focusin', onFocus)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('focusin', onFocus) }
  }, [])

  const track = (event: ReactPointerEvent, next: (dx: number, dy: number, start: ChatWindowFrame) => ChatWindowFrame) => {
    event.preventDefault()
    const start = frameRef.current, originX = event.clientX, originY = event.clientY
    const capture = event.currentTarget as HTMLElement
    try { capture.setPointerCapture?.(event.pointerId) } catch { /* ignore: capture is a nicety, window listeners still track the pointer */ }
    const move = (moved: PointerEvent) => setFrame(scope, nodeId, next(moved.clientX - originX, moved.clientY - originY, start))
    const stop = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop)
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    raise(scope, nodeId)
    if (event.button !== 0 || !(event.target instanceof Element)) return
    const bar = event.target.closest('.agent-chat-header, .agent-chat-window-bar')
    if (!bar || !event.currentTarget.contains(bar) || event.target.closest(INTERACTIVE)) return
    track(event, (dx, dy, start) => clampFrame({ ...start, x: start.x + dx, y: start.y + dy }, bounds))
  }
  const style: CSSProperties = { left: frame.x, top: frame.y, width: frame.width, height: frame.height, zIndex }
  return <WindowCloseContext.Provider value={close}>
    <section ref={root} tabIndex={-1} className="agent-chat-window" role="dialog" aria-modal="false" aria-label={`${content.name} chat`}
      data-panel="chat" data-harness={content.harness === 'codex' || content.harness === 'claude' ? content.harness : 'neutral'}
      style={style} onPointerDown={onPointerDown} onFocus={() => raise(scope, nodeId)}>
      {content.chatHasHeader === false ? <header className="agent-chat-window-bar">
        <h2>{content.name}</h2>
        <IconButton label={`Close ${content.name}`} variant="ghost" onClick={close}><Icon name="close" size={16} /></IconButton>
      </header> : null}
      <div className="agent-chat-window-body">{content.chat}</div>
      {EDGES.map((edge) => <div key={edge} className="agent-chat-resize" data-edge={edge} data-testid={`agent-chat-resize-${edge}`} aria-hidden="true"
        onPointerDown={(event) => { event.stopPropagation(); raise(scope, nodeId)
          if (event.button === 0) track(event, (dx, dy, start) => resizeFrame(start, edge, dx, dy, bounds)) }} />)}
    </section>
  </WindowCloseContext.Provider>
}
