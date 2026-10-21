import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Icon, IconButton } from '../../shared/ui/nocturne'
import { useRunsSelectorUi } from './uiStore'
import { clampRunsWindow, resizeRunsWindow, RUNS_RESIZE_EDGES, type RunsResizeEdge, type RunsWindowRect } from './windowGeometry'

function viewportBounds() {
  const viewport = window.visualViewport
  return { left: (viewport?.offsetLeft ?? 0) + 12, top: (viewport?.offsetTop ?? 0) + 12,
    width: Math.max(1, (viewport?.width ?? window.innerWidth) - 24),
    height: Math.max(1, (viewport?.height ?? window.innerHeight) - 24) }
}

/** Nonmodal: leave the Board usable while the person moves or inspects history. */
export function RunsWindow({ id, scope, anchor, close, children }: {
  id: string; scope: string; anchor: RefObject<HTMLButtonElement | null>; close(): void; children: ReactNode
}) {
  const saved = useRunsSelectorUi((state) => state.geometry)
  const rect = saved?.scope === scope ? saved.rect : undefined
  const gesture = useRef<{ pointerId: number; x: number; y: number; rect: RunsWindowRect; edge?: RunsResizeEdge } | null>(null)
  const surface = useRef<HTMLElement>(null)
  const current = () => {
    const geometry = useRunsSelectorUi.getState().geometry
    return geometry?.scope === scope ? geometry.rect : undefined
  }
  const update = (next: RunsWindowRect) => useRunsSelectorUi.getState().setGeometry(scope, clampRunsWindow(next, viewportBounds()))

  useLayoutEffect(() => {
    const place = () => {
      const saved = useRunsSelectorUi.getState().geometry
      const anchorRect = anchor.current?.getBoundingClientRect()
      const initial = saved?.scope === scope ? saved.rect : {
        left: (anchorRect?.right ?? 572) - 560, top: (anchorRect?.bottom ?? 12) + 8, width: 560, height: 420,
      }
      useRunsSelectorUi.getState().setGeometry(scope, clampRunsWindow(initial, viewportBounds()))
      gesture.current = null
    }
    place()
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [anchor, scope])

  function start(event: PointerEvent<HTMLButtonElement>, edge?: RunsResizeEdge) {
    const rect = current()
    if (event.button !== 0 || !rect) return
    event.preventDefault(); event.stopPropagation()
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect, edge }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const start = gesture.current
    if (!start || start.pointerId !== event.pointerId) return
    const dx = event.clientX - start.x, dy = event.clientY - start.y
    update(start.edge ? resizeRunsWindow(start.rect, start.edge, dx, dy, viewportBounds())
      : { ...start.rect, left: start.rect.left + dx, top: start.rect.top + dy })
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, edge?: RunsResizeEdge) {
    const rect = current()
    if (!rect || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const step = event.shiftKey ? 40 : 20
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    update(edge ? resizeRunsWindow(rect, edge, dx, dy, viewportBounds()) : { ...rect, left: rect.left + dx, top: rect.top + dy })
  }
  const stop = () => { gesture.current = null }
  return createPortal(<section id={id} ref={surface} role="dialog" aria-modal="false" aria-label="Runs"
    className="n-theme runs-window nodrag nopan nowheel" style={rect} onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close() }
    }}>
    <header className="runs-window-header">
      <h2 aria-label="Runs"><button type="button" aria-label="Move Runs window"
        title="Drag to move; use arrow keys to move with the keyboard" onPointerDown={start} onPointerMove={move}
        onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onKeyDown={(event) => keyboard(event)}>
        <Icon name="history" size={16} />Runs
      </button></h2>
      <IconButton label="Close Runs" variant="ghost" size="sm" onClick={close}><Icon name="close" size={16} /></IconButton>
    </header>
    {children}
    {RUNS_RESIZE_EDGES.map((edge) => <button key={edge} type="button" tabIndex={edge === 'se' ? 0 : -1}
      aria-label={edge === 'se' ? 'Resize Runs window' : `Resize Runs window ${edge}`}
      title="Drag to resize; use arrow keys to resize with the keyboard" className={`runs-window-resize runs-window-resize--${edge}`}
      onPointerDown={(event) => start(event, edge)} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop}
      onLostPointerCapture={stop} onKeyDown={(event) => keyboard(event, edge)} />)}
  </section>, document.body)
}
