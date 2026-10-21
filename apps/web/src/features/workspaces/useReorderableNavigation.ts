import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefCallback,
} from 'react'

import {
  applyStoredOrder,
  moveItemRelative,
  moveItemToIndex,
  useNavigationOrderStore,
} from './navigationOrder'

/** Non-visual keyboard alternative to pointer dragging. */
export const REORDER_KEY_SHORTCUTS = 'Alt+ArrowUp Alt+ArrowDown'

const MOUSE_DRAG_DISTANCE_PX = 6
const TOUCH_HOLD_MS = 350
const TOUCH_SCROLL_DISTANCE_PX = 10

const SAME_ORDER_SEPARATOR = '\u0000'

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.join(SAME_ORDER_SEPARATOR) === b.join(SAME_ORDER_SEPARATOR)
}

export interface ReorderableNavigationItem {
  id: string
  label: string
}

export interface ReorderContainerProps {
  ref: RefCallback<HTMLUListElement>
  'data-reorder-group': string
  onClickCapture: (event: ReactMouseEvent<HTMLUListElement>) => void
  onDragStart: (event: ReactDragEvent<HTMLUListElement>) => void
}

export interface ReorderItemProps {
  'data-reorder-id': string
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
}

export interface ReorderKeyboardProps {
  'aria-keyshortcuts': string
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
}

export interface ReorderableNavigation {
  /** Rendered order; a live preview while a pointer drag is in progress. */
  orderedIds: readonly string[]
  containerProps: ReorderContainerProps
  getItemProps: (id: string) => ReorderItemProps
  getKeyboardProps: (id: string) => ReorderKeyboardProps
  move: (id: string, direction: -1 | 1) => void
}

interface ReorderOptions {
  onReorder?: (ids: readonly string[]) => void
  disabled?: boolean
  revision?: number
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
  revision: number | undefined
  previewIds: readonly string[] | null
}

/**
 * Sibling reordering for one sidebar list. Pointer dragging only reorders the
 * ids that belong to this list: the drop target is read from the list's own
 * items and moves outside the list bounds are ignored, so an item can never
 * change parent or workspace. A plain click/tap is left to the underlying link
 * and button; Alt+Arrow Up/Down reorders the focused item for keyboard users
 * and the change is announced through the shared live region.
 */
export function useReorderableNavigation(
  parentKey: string,
  items: readonly ReorderableNavigationItem[],
  options: ReorderOptions = {},
): ReorderableNavigation {
  const storedOrder = useNavigationOrderStore((state) => state.orders[parentKey])
  const setOrder = useNavigationOrderStore((state) => state.setOrder)
  const announce = useNavigationOrderStore((state) => state.announce)
  const { onReorder, disabled = false, revision } = options
  const commitOrder = useCallback((ids: readonly string[]) => {
    if (onReorder) onReorder(ids)
    else setOrder(parentKey, ids)
  }, [onReorder, parentKey, setOrder])

  const orderedIds = useMemo(
    () => applyStoredOrder(items.map((item) => item.id), onReorder ? undefined : storedOrder),
    [items, onReorder, storedOrder],
  )

  const listRef = useRef<HTMLUListElement | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const cancelDragRef = useRef<(() => void) | null>(null)
  const suppressClickRef = useRef(false)
  const suppressClickTimerRef = useRef<number | null>(null)
  const [previewIds, setPreviewIds] = useState<readonly string[] | null>(null)

  const orderKey = orderedIds.join(SAME_ORDER_SEPARATOR)
  useEffect(() => {
    cancelDragRef.current?.()
    setPreviewIds(null)
  }, [disabled, orderKey, revision])

  useEffect(() => () => {
    cancelDragRef.current?.()
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current)
    }
  }, [])

  const containerRef = useCallback<RefCallback<HTMLUListElement>>((element) => {
    listRef.current = element
  }, [])

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLUListElement>) => {
    // Pointer drags end on pointerup; the click that follows must not navigate.
    if (!suppressClickRef.current || event.detail === 0) return
    suppressClickRef.current = false
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current)
      suppressClickTimerRef.current = null
    }
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const onDragStart = useCallback((event: ReactDragEvent<HTMLUListElement>) => {
    // Native link dragging would fight the pointer-based reorder.
    event.preventDefault()
  }, [])

  const containerProps = useMemo<ReorderContainerProps>(
    () => ({
      ref: containerRef,
      'data-reorder-group': parentKey,
      onClickCapture,
      onDragStart,
    }),
    [containerRef, onClickCapture, onDragStart, parentKey],
  )

  const beginDrag = useNavigationPointerDrag({ items, orderedIds, listRef, dragRef, suppressClickRef, suppressClickTimerRef,
    cancelDragRef, setPreviewIds, commitOrder, announce, disabled, revision })

  const getItemProps = useCallback(
    (id: string): ReorderItemProps => ({
      'data-reorder-id': id,
      onPointerDown: (event) => beginDrag(event, id),
    }),
    [beginDrag],
  )

  const moveByKeyboard = useCallback(
    (id: string, direction: -1 | 1) => {
      if (disabled) return
      const index = orderedIds.indexOf(id)
      if (index === -1) return
      const targetIndex = index + direction
      if (targetIndex < 0 || targetIndex >= orderedIds.length) return
      const next = moveItemToIndex(orderedIds, id, targetIndex)
      if (sameOrder(next, orderedIds)) return
      commitOrder(next)
      const label = items.find((item) => item.id === id)?.label ?? id
      announce(`Moved ${label} to position ${targetIndex + 1} of ${next.length}`)
    },
    [announce, commitOrder, disabled, items, orderedIds],
  )

  const getKeyboardProps = useCallback(
    (id: string): ReorderKeyboardProps => ({
      'aria-keyshortcuts': REORDER_KEY_SHORTCUTS,
      onKeyDown: (event) => {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        moveByKeyboard(id, event.key === 'ArrowUp' ? -1 : 1)
      },
    }),
    [moveByKeyboard],
  )

  const previewIsCurrent = !disabled && dragRef.current?.revision === revision
    && dragRef.current !== null && sameOrder(dragRef.current.originIds, orderedIds)
  return {
    orderedIds: previewIsCurrent ? previewIds ?? orderedIds : orderedIds,
    containerProps,
    getItemProps,
    getKeyboardProps,
    move: moveByKeyboard,
  }
}

type NavigationPointerDrag = {
  items: readonly ReorderableNavigationItem[]
  orderedIds: readonly string[]
  listRef: RefObject<HTMLUListElement | null>
  dragRef: RefObject<DragSession | null>
  suppressClickRef: RefObject<boolean>
  suppressClickTimerRef: RefObject<number | null>
  cancelDragRef: RefObject<(() => void) | null>
  setPreviewIds: Dispatch<SetStateAction<readonly string[] | null>>
  commitOrder: (ids: readonly string[]) => void
  announce: ReturnType<typeof useNavigationOrderStore.getState>['announce']
  disabled: boolean
  revision: number | undefined
}

function useNavigationPointerDrag(options: NavigationPointerDrag) {
  const { items, orderedIds, listRef, dragRef, suppressClickRef, suppressClickTimerRef,
    cancelDragRef, setPreviewIds, commitOrder, announce, disabled, revision } = options
  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: string) => {
      if (disabled || event.button !== 0 || dragRef.current) return
      const listElement = listRef.current
      if (!listElement) return

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
        revision,
        previewIds: null,
      }
      dragRef.current = session
      suppressClickRef.current = false

      const label = items.find((item) => item.id === id)?.label ?? id

      function detach() {
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

      function activate() {
        if (session.active) return
        session.active = true
        if (session.holdTimer !== null) {
          window.clearTimeout(session.holdTimer)
          session.holdTimer = null
        }
        session.previewIds = session.originIds
        setPreviewIds(session.originIds)
        window.addEventListener('selectstart', onSelectStart)
        window.addEventListener('contextmenu', onContextMenu)
        if (session.pointerType === 'touch') {
          window.addEventListener('touchmove', onTouchMove, { passive: false })
        }
      }

      function finish(commit: boolean) {
        if (dragRef.current !== session) return
        detach()
        dragRef.current = null
        cancelDragRef.current = null
        const moved = session.active && session.moved
        const finalIds = session.previewIds
        setPreviewIds(null)
        if (!moved) return
        suppressClickRef.current = true
        suppressClickTimerRef.current = window.setTimeout(() => {
          suppressClickRef.current = false
          suppressClickTimerRef.current = null
        }, 0)
        if (!commit || !finalIds) return
        commitOrder(finalIds)
        announce(`Moved ${label} to position ${finalIds.indexOf(id) + 1} of ${finalIds.length}`)
      }

      function updatePreview(clientX: number, clientY: number) {
        const list = listRef.current
        if (!list || session.cancelled) return
        const listRect = list.getBoundingClientRect()
        if (
          clientX < listRect.left ||
          clientX > listRect.right ||
          clientY < listRect.top ||
          clientY > listRect.bottom
        ) {
          return
        }

        const hovered =
          typeof document.elementFromPoint === 'function'
            ? document.elementFromPoint(clientX, clientY)
            : null
        if (hovered && !list.contains(hovered)) return
        const hoveredGroup = hovered?.closest('[data-reorder-group]')
        if (hoveredGroup && hoveredGroup !== list) return

        const ownItems = [
          ...list.querySelectorAll<HTMLElement>('[data-reorder-id]'),
        ].filter((element) => element.closest('[data-reorder-group]') === list)

        let targetElement = hovered?.closest<HTMLElement>('[data-reorder-id]') ?? null
        if (targetElement && targetElement.closest('[data-reorder-group]') !== list) {
          targetElement = null
        }
        if (!targetElement) {
          let nearestDistance = Number.POSITIVE_INFINITY
          for (const element of ownItems) {
            const rect = element.getBoundingClientRect()
            const distance = Math.abs(clientY - (rect.top + rect.height / 2))
            if (distance < nearestDistance) {
              nearestDistance = distance
              targetElement = element
            }
          }
        }

        const targetId = targetElement?.dataset.reorderId
        if (!targetElement || !targetId || targetId === session.id) return

        const current = session.previewIds ?? session.originIds
        const targetRect = targetElement.getBoundingClientRect()
        const position = clientY > targetRect.top + targetRect.height / 2 ? 'after' : 'before'
        const next = moveItemRelative(current, session.id, targetId, position)
        if (sameOrder(next, current)) return
        session.previewIds = next
        session.moved = true
        setPreviewIds(next)
      }

      function onPointerMove(moveEvent: PointerEvent) {
        if (moveEvent.pointerId !== session.pointerId || session.cancelled) return
        if (!session.active) {
          const distance = Math.hypot(
            moveEvent.clientX - session.startX,
            moveEvent.clientY - session.startY,
          )
          if (session.pointerType === 'touch') {
            // Moving before the hold elapses means the touch is a scroll or tap.
            if (distance > TOUCH_SCROLL_DISTANCE_PX) finish(false)
          } else if (distance > MOUSE_DRAG_DISTANCE_PX) {
            activate()
          }
          return
        }
        updatePreview(moveEvent.clientX, moveEvent.clientY)
      }

      function onPointerUp(upEvent: PointerEvent) {
        if (upEvent.pointerId !== session.pointerId) return
        finish(!session.cancelled)
      }

      function onPointerCancel(cancelEvent: PointerEvent) {
        if (cancelEvent.pointerId !== session.pointerId) return
        session.cancelled = true
        finish(false)
      }

      function onKeyDown(keyEvent: KeyboardEvent) {
        if (keyEvent.key !== 'Escape' || !session.active || session.cancelled) return
        keyEvent.preventDefault()
        session.cancelled = true
        session.previewIds = null
        setPreviewIds(null)
      }

      function onTouchMove(touchEvent: TouchEvent) {
        if (session.active && session.moved) touchEvent.preventDefault()
      }

      function onSelectStart(selectEvent: Event) {
        if (session.active) selectEvent.preventDefault()
      }

      function onContextMenu(contextEvent: MouseEvent) {
        if (session.active && session.moved) contextEvent.preventDefault()
      }

      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerCancel)
      window.addEventListener('keydown', onKeyDown)
      cancelDragRef.current = () => {
        session.cancelled = true
        detach()
        if (dragRef.current === session) dragRef.current = null
        cancelDragRef.current = null
      }
      if (session.pointerType === 'touch') {
        session.holdTimer = window.setTimeout(activate, TOUCH_HOLD_MS)
      }
    },
    [announce, commitOrder, disabled, items, orderedIds, revision, dragRef, listRef, setPreviewIds,
      cancelDragRef, suppressClickRef, suppressClickTimerRef],
  )
  return beginDrag
}
