import { useEffect } from 'react'
import { create } from 'zustand'

/** One stacking order for every floating Board container (Agent chat windows, the approval inbox, the
 * add-Agent panel, Activities, side panels). The container opened or focused last is always on top. */
const BASE = 30
const MAX_RANK = 55

type FloatingStack = { next: number; order: Record<string, number> }
export const useFloatingStack = create<FloatingStack>(() => ({ next: 1, order: {} }))

export function raiseFloating(id: string) {
  useFloatingStack.setState((state) => state.order[id] === state.next - 1 ? state
    : { next: state.next + 1, order: { ...state.order, [id]: state.next } })
}

export function releaseFloating(id: string) {
  useFloatingStack.setState((state) => {
    if (!(id in state.order)) return state
    const order = { ...state.order }
    delete order[id]
    return { order }
  })
}

/** The z-index of a container: its rank among the open containers, so the numbers stay small. */
export function useFloatingZ(id: string, active = true): number {
  useEffect(() => {
    if (!active) return undefined
    raiseFloating(id)
    return () => releaseFloating(id)
  }, [id, active])
  const rank = useFloatingStack((state) => {
    const mine = state.order[id]
    return mine === undefined ? 0 : Object.values(state.order).filter((value) => value < mine).length
  })
  return BASE + Math.min(rank, MAX_RANK)
}
