import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { isNarrowOperatorChat } from './operatorChatStore'

export const operatorResizeEdges = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const
type Edge = typeof operatorResizeEdges[number]
type Box = { left: number; top: number; width: number; height: number }
const labels: Record<Edge, string> = { n: 'top', ne: 'top right', e: 'right', se: 'bottom right', s: 'bottom', sw: 'bottom left', w: 'left', nw: 'top left' }

export function useOperatorChatResize() {
  const panelRef = useRef<HTMLElement>(null)
  const [box, setBox] = useState<Box>()
  const drag = useRef<{ edge: Edge; x: number; y: number; box: Box } | undefined>(undefined)
  const moving = useRef<{ x: number; y: number; box: Box } | undefined>(undefined)
  const move = (start: Box, edge: Edge, dx: number, dy: number) => {
    const minimumWidth = Math.min(420, window.innerWidth - 16)
    const minimumHeight = Math.min(320, window.innerHeight - 16)
    let left = start.left, top = start.top, right = left + start.width, bottom = top + start.height
    if (edge.includes('w')) left = Math.max(8, Math.min(left + dx, right - minimumWidth))
    if (edge.includes('e')) right = Math.min(window.innerWidth - 8, Math.max(right + dx, left + minimumWidth))
    if (edge.includes('n')) top = Math.max(8, Math.min(top + dy, bottom - minimumHeight))
    if (edge.includes('s')) bottom = Math.min(window.innerHeight - 8, Math.max(bottom + dy, top + minimumHeight))
    setBox({ left, top, width: right - left, height: bottom - top })
  }
  useEffect(() => {
    const clamp = () => setBox((current) => {
      if (!current) return current
      const width = Math.min(current.width, window.innerWidth - 16), height = Math.min(current.height, window.innerHeight - 16)
      return { width, height, left: Math.max(8, Math.min(current.left, window.innerWidth - width - 8)), top: Math.max(8, Math.min(current.top, window.innerHeight - height - 8)) }
    })
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])
  const readBox = (): Box | undefined => {
    const rect = panelRef.current?.getBoundingClientRect()
    return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : undefined
  }
  return { panelRef, size: box ? { position: 'fixed', ...box } as CSSProperties : undefined,
    moveGrip: {
      'aria-label': 'Move Operator chat',
      'aria-description': 'Drag or use arrow keys to move the chat.',
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (isNarrowOperatorChat()) return
        const start = readBox()
        if (!start) return
        event.preventDefault()
        moving.current = { x: event.clientX, y: event.clientY, box: start }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const start = moving.current
        if (!start) return
        setBox({ ...start.box,
          left: Math.max(8, Math.min(start.box.left + event.clientX - start.x, window.innerWidth - start.box.width - 8)),
          top: Math.max(8, Math.min(start.box.top + event.clientY - start.y, window.innerHeight - start.box.height - 8)),
        })
      },
      onPointerUp() { moving.current = undefined },
      onPointerCancel() { moving.current = undefined },
      onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (isNarrowOperatorChat() || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        const start = readBox()
        if (!start) return
        setBox({ ...start,
          left: Math.max(8, Math.min(start.left + (event.key === 'ArrowLeft' ? -32 : event.key === 'ArrowRight' ? 32 : 0), window.innerWidth - start.width - 8)),
          top: Math.max(8, Math.min(start.top + (event.key === 'ArrowUp' ? -32 : event.key === 'ArrowDown' ? 32 : 0), window.innerHeight - start.height - 8)),
        })
      },
    },
    grip: (edge: Edge) => ({
      'aria-label': edge === 'nw' ? 'Resize Operator chat' : `Resize Operator chat from ${labels[edge]}`,
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        const start = readBox()
        if (!start) return
        event.preventDefault()
        drag.current = { edge, x: event.clientX, y: event.clientY, box: start }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const start = drag.current
        if (start) move(start.box, start.edge, event.clientX - start.x, event.clientY - start.y)
      },
      onPointerUp() { drag.current = undefined },
      onPointerCancel() { drag.current = undefined },
      onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        const start = readBox()
        if (start) move(start, edge, event.key === 'ArrowLeft' ? -32 : event.key === 'ArrowRight' ? 32 : 0,
          event.key === 'ArrowUp' ? -32 : event.key === 'ArrowDown' ? 32 : 0)
      },
    }),
  }
}
