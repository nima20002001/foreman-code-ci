import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefCallback,
} from 'react'

import {
  applyAgentOrder,
  moveAgentRelative,
  moveAgentToIndex,
  useAgentDirectoryStore,
} from './agentDirectoryStore'

export const AGENT_REORDER_KEY_SHORTCUTS = 'Alt+ArrowUp Alt+ArrowDown'

const MOUSE_DRAG_DISTANCE_PX = 6
const TOUCH_HOLD_MS = 350
const TOUCH_SCROLL_DISTANCE_PX = 10
const SETTLE_DURATION_MS = 190
const ORDER_SEPARATOR = '\u0000'

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.join(ORDER_SEPARATOR) === b.join(ORDER_SEPARATOR)
}

function motionAllowed(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true
}

export interface ReorderableAgent {
  id: string
  label: string
}

export interface AgentReorderContainerProps {
  ref: RefCallback<HTMLDivElement>
  'data-reorder-group': string
  onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void
  onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void
}

export interface AgentReorderCardProps {
  ref: RefCallback<HTMLDivElement>
  'data-agent-id': string
  'aria-keyshortcuts': string
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
}

export interface ReorderableAgentsResult {
  orderedIds: readonly string[]
  containerProps: AgentReorderContainerProps
  getCardProps: (id: string) => AgentReorderCardProps
}

interface DragSession {
  id: string
  pointerId: number
  pointerType: string
  startX: number
  startY: number
  active: boolean
  moved: boolean
  cancelled: boolean
  holdTimer: number | null
  originIds: readonly string[]
  previewIds: readonly string[] | null
}

/**
 * Pointer and keyboard sibling ordering for the agents directory. A short
 * click remains inert; touch waits for a hold before it claims the gesture,
 * leaving ordinary scrolling and taps alone.
 */
export function useReorderableAgents(
  workspaceId: string,
  items: readonly ReorderableAgent[],
): ReorderableAgentsResult {
  const storedOrder = useAgentDirectoryStore((state) => state.orders[workspaceId])
  const setOrder = useAgentDirectoryStore((state) => state.setOrder)
  const announce = useAgentDirectoryStore((state) => state.announce)
  const orderedIds = useMemo(
    () => applyAgentOrder(items.map((item) => item.id), storedOrder),
    [items, storedOrder],
  )
  const listRef = useRef<HTMLDivElement | null>(null)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())
  const dragRef = useRef<DragSession | null>(null)
  const suppressClickRef = useRef(false)
  const [previewIds, setPreviewIds] = useState<readonly string[] | null>(null)
  const previousRectsRef = useRef(new Map<string, DOMRect>())
  const previousOrderRef = useRef<readonly string[]>(orderedIds)

  const setCardRef = useCallback((id: string, card: HTMLDivElement | null) => {
    if (card) cardRefs.current.set(id, card)
    else cardRefs.current.delete(id)
  }, [])

  useLayoutEffect(() => {
    const nextRects = new Map<string, DOMRect>()
    for (const id of orderedIds) {
      const card = cardRefs.current.get(id)
      if (card) nextRects.set(id, card.getBoundingClientRect())
    }

    const changed = !sameOrder(previousOrderRef.current, orderedIds)
    const cleanup: Array<() => void> = []
    if (changed && motionAllowed()) {
      for (const [id, nextRect] of nextRects) {
        const previousRect = previousRectsRef.current.get(id)
        if (!previousRect) continue
        const deltaX = previousRect.left - nextRect.left
        const deltaY = previousRect.top - nextRect.top
        if (deltaX === 0 && deltaY === 0) continue
        const card = cardRefs.current.get(id)
        if (!card) continue
        card.dataset.reorderSettling = 'true'
        card.style.transform = `translate(${deltaX}px, ${deltaY}px)`
        // Force the initial transform to be committed before clearing it so
        // the card takes the shortest visual path to its new grid position.
        void card.offsetWidth
        const clear = () => {
          card.style.transform = ''
          delete card.dataset.reorderSettling
        }
        const frame = window.requestAnimationFrame?.(clear)
        const timeout = window.setTimeout(clear, SETTLE_DURATION_MS)
        cleanup.push(() => {
          if (frame !== undefined) window.cancelAnimationFrame?.(frame)
          window.clearTimeout(timeout)
          clear()
        })
      }
    }

    previousRectsRef.current = nextRects
    previousOrderRef.current = orderedIds
    return () => cleanup.forEach((cancel) => cancel())
  }, [orderedIds])

  const containerRef = useCallback<RefCallback<HTMLDivElement>>((element) => {
    listRef.current = element
  }, [])

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current || event.detail === 0) return
    suppressClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const onDragStart = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
  }, [])

  const containerProps = useMemo<AgentReorderContainerProps>(
    () => ({
      ref: containerRef,
      'data-reorder-group': `workspace:${workspaceId}:agents`,
      onClickCapture,
      onDragStart,
    }),
    [containerRef, onClickCapture, onDragStart, workspaceId],
  )

  const beginDrag = useAgentPointerDrag({ workspaceId, items, orderedIds, listRef, dragRef, suppressClickRef,
    setPreviewIds, setOrder, announce })

  const moveByKeyboard = useCallback(
    (id: string, direction: -1 | 1) => {
      const index = orderedIds.indexOf(id)
      const targetIndex = index + direction
      if (index === -1 || targetIndex < 0 || targetIndex >= orderedIds.length) return
      const next = moveAgentToIndex(orderedIds, id, targetIndex)
      if (sameOrder(next, orderedIds)) return
      setOrder(workspaceId, next)
      const label = items.find((item) => item.id === id)?.label ?? id
      announce(`Moved ${label} to position ${targetIndex + 1} of ${next.length}`)
    },
    [announce, items, orderedIds, setOrder, workspaceId],
  )

  const getCardProps = useCallback(
    (id: string): AgentReorderCardProps => ({
      ref: (card) => setCardRef(id, card),
      'data-agent-id': id,
      'aria-keyshortcuts': AGENT_REORDER_KEY_SHORTCUTS,
      onPointerDown: (event) => beginDrag(event, id),
      onKeyDown: (event) => {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        moveByKeyboard(id, event.key === 'ArrowUp' ? -1 : 1)
      },
    }),
    [beginDrag, moveByKeyboard, setCardRef],
  )

  return {
    orderedIds: previewIds ?? orderedIds,
    containerProps,
    getCardProps,
  }
}

type AgentPointerDrag = {
  workspaceId: string
  items: readonly ReorderableAgent[]
  orderedIds: readonly string[]
  listRef: RefObject<HTMLDivElement | null>
  dragRef: RefObject<DragSession | null>
  suppressClickRef: RefObject<boolean>
  setPreviewIds: Dispatch<SetStateAction<readonly string[] | null>>
  setOrder: ReturnType<typeof useAgentDirectoryStore.getState>['setOrder']
  announce: ReturnType<typeof useAgentDirectoryStore.getState>['announce']
}

function useAgentPointerDrag(options: AgentPointerDrag) {
  const { workspaceId, items, orderedIds, listRef, dragRef, suppressClickRef,
    setPreviewIds, setOrder, announce } = options
  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
      if (event.button !== 0 || dragRef.current) return
      if (!listRef.current || !orderedIds.includes(id)) return

      const session: DragSession = {
        id,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        moved: false,
        cancelled: false,
        holdTimer: null,
        originIds: orderedIds,
        previewIds: null,
      }
      dragRef.current = session
      suppressClickRef.current = false
      const label = items.find((item) => item.id === id)?.label ?? id

      const detach = () => {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerUp)
        window.removeEventListener('pointercancel', onPointerCancel)
        window.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('touchmove', onTouchMove)
        window.removeEventListener('selectstart', onSelectStart)
        window.removeEventListener('contextmenu', onContextMenu)
        if (session.holdTimer !== null) window.clearTimeout(session.holdTimer)
        session.holdTimer = null
      }

      const activate = () => {
        if (session.active || session.cancelled) return
        session.active = true
        if (session.holdTimer !== null) window.clearTimeout(session.holdTimer)
        session.holdTimer = null
        session.previewIds = session.originIds
        setPreviewIds(session.originIds)
        window.addEventListener('selectstart', onSelectStart)
        window.addEventListener('contextmenu', onContextMenu)
        if (session.pointerType === 'touch') {
          window.addEventListener('touchmove', onTouchMove, { passive: false })
        }
      }

      const finish = (commit: boolean) => {
        if (dragRef.current !== session) return
        detach()
        dragRef.current = null
        const moved = session.active && session.moved
        const finalIds = session.previewIds
        setPreviewIds(null)
        if (!moved) return
        suppressClickRef.current = true
        if (!commit || !finalIds) return
        setOrder(workspaceId, finalIds)
        announce(`Moved ${label} to position ${finalIds.indexOf(id) + 1} of ${finalIds.length}`)
      }

      const updatePreview = (clientX: number, clientY: number) => {
        const list = listRef.current
        if (!list || session.cancelled) return
        const listRect = list.getBoundingClientRect()
        if (
          (listRect.width || listRect.height) &&
          (clientX < listRect.left || clientX > listRect.right || clientY < listRect.top || clientY > listRect.bottom)
        ) {
          return
        }

        const hovered = typeof document.elementFromPoint === 'function'
          ? document.elementFromPoint(clientX, clientY)
          : null
        if (hovered && !list.contains(hovered)) return

        const cards = [...list.querySelectorAll<HTMLElement>('[data-agent-id]')]
          .filter((card) => card.closest('[data-reorder-group]') === list)
        let target: HTMLElement | null = hovered?.closest<HTMLElement>('[data-agent-id]') ?? null
        if (target && target.closest('[data-reorder-group]') !== list) target = null
        if (!target) {
          let nearest = Number.POSITIVE_INFINITY
          for (const card of cards) {
            const rect = card.getBoundingClientRect()
            const distance = Math.hypot(
              clientX - (rect.left + rect.width / 2),
              clientY - (rect.top + rect.height / 2),
            )
            if (distance < nearest) {
              nearest = distance
              target = card
            }
          }
        }

        const targetId = target?.dataset.agentId
        if (!target || !targetId || targetId === session.id) return
        const current = session.previewIds ?? session.originIds
        const targetRect = target.getBoundingClientRect()
        const position = clientY > targetRect.top + targetRect.height / 2 ? 'after' : 'before'
        const next = moveAgentRelative(current, session.id, targetId, position)
        if (sameOrder(next, current)) return
        session.previewIds = next
        session.moved = true
        setPreviewIds(next)
      }

      const onPointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== session.pointerId || session.cancelled) return
        if (!session.active) {
          const distance = Math.hypot(
            moveEvent.clientX - session.startX,
            moveEvent.clientY - session.startY,
          )
          if (session.pointerType === 'touch') {
            if (distance > TOUCH_SCROLL_DISTANCE_PX) finish(false)
          } else if (distance > MOUSE_DRAG_DISTANCE_PX) {
            activate()
          }
          return
        }
        updatePreview(moveEvent.clientX, moveEvent.clientY)
      }

      const onPointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId === session.pointerId) finish(!session.cancelled)
      }

      const onPointerCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== session.pointerId) return
        session.cancelled = true
        finish(false)
      }

      const onKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== 'Escape' || !session.active) return
        keyEvent.preventDefault()
        session.cancelled = true
        session.previewIds = null
        setPreviewIds(null)
      }

      const onTouchMove = (touchEvent: TouchEvent) => {
        if (session.active && session.moved) touchEvent.preventDefault()
      }
      const onSelectStart = (selectEvent: Event) => {
        if (session.active) selectEvent.preventDefault()
      }
      const onContextMenu = (contextEvent: MouseEvent) => {
        if (session.active && session.moved) contextEvent.preventDefault()
      }

      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerCancel)
      window.addEventListener('keydown', onKeyDown)
      if (session.pointerType === 'touch') {
        session.holdTimer = window.setTimeout(activate, TOUCH_HOLD_MS)
      }
    },
    [announce, items, orderedIds, setOrder, workspaceId, dragRef, listRef, setPreviewIds, suppressClickRef],
  )
  return beginDrag
}
