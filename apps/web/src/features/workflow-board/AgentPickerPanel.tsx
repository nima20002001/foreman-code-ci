import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, IconButton } from '../../shared/ui/nocturne'
import { raiseFloating, useFloatingZ } from '../../shared/ui/floatingStack'

const STACK_ID = 'board-add-agent'

export function AgentPickerPanel({ children, close }: { children: ReactNode; close(): void }) {
  const panel = useRef<HTMLElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number }>()
  const zIndex = useFloatingZ(STACK_ID)
  // Like an Agent chat window, the panel takes focus when it opens so Escape closes it at once.
  useLayoutEffect(() => { panel.current?.focus({ preventScroll: true }) }, [])
  const move = (left: number, top: number) => {
    const element = panel.current, parent = element?.parentElement
    if (!element || !parent) return
    setPosition({ left: Math.max(0, Math.min(left, parent.clientWidth - element.offsetWidth)),
      top: Math.max(0, Math.min(top, parent.clientHeight - element.offsetHeight)) })
  }
  return <aside ref={panel} tabIndex={-1} className="board-agent-picker" aria-label="Add node"
    style={position ? { ...position, right: 'auto', zIndex } : { zIndex }}
    onPointerDownCapture={() => raiseFloating(STACK_ID)} onFocusCapture={() => raiseFloating(STACK_ID)}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
    <header>
      <h2><button type="button" title="Drag to move; use arrow keys to move with the keyboard"
        onPointerDown={(event) => {
          if (event.button !== 0 || !panel.current) return
          event.preventDefault()
          drag.current = { x: event.clientX, y: event.clientY, left: panel.current.offsetLeft, top: panel.current.offsetTop }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => { const start = drag.current; if (start) move(start.left + event.clientX - start.x, start.top + event.clientY - start.y) }}
        onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !panel.current) return
          event.preventDefault(); event.stopPropagation()
          move(panel.current.offsetLeft + (event.key === 'ArrowLeft' ? -20 : event.key === 'ArrowRight' ? 20 : 0),
            panel.current.offsetTop + (event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0))
        }}>Add node</button></h2>
      <IconButton label="Close node picker" variant="ghost" onClick={close}><Icon name="close" size={16} /></IconButton>
    </header>
    <div className="board-agent-picker-content">{children}</div>
  </aside>
}
