import { useRef, type PointerEvent } from 'react'
import { useReactFlow, useStore, useViewport } from '@xyflow/react'
import type { GraphGeometryChange } from './geometry'
import { GRAPH_NODE_MIN_WIDTH, GRAPH_NODE_MAX_WIDTH, GRAPH_NODE_MIN_HEIGHT, GRAPH_NODE_MAX_HEIGHT } from './mapper'

const minimum = Math.max(GRAPH_NODE_MIN_WIDTH, GRAPH_NODE_MIN_HEIGHT)
const maximum = Math.min(GRAPH_NODE_MAX_WIDTH, GRAPH_NODE_MAX_HEIGHT)
const clamp = (diameter: number) => Math.max(minimum, Math.min(maximum, diameter))
type Gesture = {
  pointerId: number; center: { x: number; y: number }; startRadius: number
  diameter: number; original: GraphGeometryChange; last: GraphGeometryChange
}

export function CircularNodeResizer({ id, name, width: measuredWidth, height: measuredHeight, onStart, onResize, onFinish }: {
  id: string; name: string; width: number; height: number
  onStart?: (() => void) | undefined
  onResize?: ((change: GraphGeometryChange) => void) | undefined
  onFinish?: ((change: GraphGeometryChange) => void) | undefined
}) {
  const { zoom } = useViewport()
  const flow = useReactFlow()
  const gesture = useRef<Gesture | undefined>(undefined)
  // Authored bounds update before ResizeObserver reports the new measured size.
  const authoredWidth = useStore((state) => state.nodeLookup.get(id)?.style?.width)
  const authoredHeight = useStore((state) => state.nodeLookup.get(id)?.style?.height)
  const width = typeof authoredWidth === 'number' ? authoredWidth : measuredWidth
  const height = typeof authoredHeight === 'number' ? authoredHeight : measuredHeight
  const diameter = Math.min(width, height)
  const geometry = (size: number, center: { x: number; y: number }): GraphGeometryChange => ({
    id, width: size, height: size, position: { x: center.x - size / 2, y: center.y - size / 2 },
  })
  const center = () => {
    const position = flow.getNode(id)!.position
    return { x: position.x + width / 2, y: position.y + height / 2 }
  }
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const drag = gesture.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.stopPropagation()
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const radius = Math.hypot(point.x - drag.center.x, point.y - drag.center.y)
    if (Math.abs(radius - drag.startRadius) < 0.001) {
      drag.last = drag.original
    } else drag.last = geometry(clamp(drag.diameter + 2 * (radius - drag.startRadius)), drag.center)
    onResize?.(drag.last)
  }
  return <svg className="board-agent-resize nodrag nopan" role="slider" tabIndex={0}
    aria-label={`Resize ${name}`} aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={diameter}
    aria-valuetext={`${diameter} pixels diameter`}
    aria-description="Drag the circle border to resize. Arrow keys resize; Shift uses larger steps."
    onClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.focus()
      event.currentTarget.setPointerCapture(event.pointerId)
      const origin = center()
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      gesture.current = { pointerId: event.pointerId, center: origin,
        startRadius: Math.hypot(point.x - origin.x, point.y - origin.y), diameter,
        original: { id, width, height, position: flow.getNode(id)!.position },
        last: { id, width, height, position: flow.getNode(id)!.position } }
      onStart?.()
    }}
    onPointerMove={move}
    onPointerUp={(event) => {
      const drag = gesture.current
      if (!drag || drag.pointerId !== event.pointerId) return
      move(event)
      gesture.current = undefined
      event.currentTarget.releasePointerCapture(event.pointerId)
      onFinish?.(drag.last)
    }}
    onPointerCancel={(event) => {
      const drag = gesture.current
      if (!drag || drag.pointerId !== event.pointerId) return
      gesture.current = undefined
      onFinish?.(drag.original)
    }}
    onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      const step = event.shiftKey ? 24 : 8
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1
      onStart?.()
      onFinish?.(geometry(clamp(diameter + direction * step), center()))
    }}>
    <ellipse cx="50%" cy="50%" rx={width / 2} ry={height / 2} strokeWidth={Math.min(12 / zoom, diameter / 4)} />
  </svg>
}
