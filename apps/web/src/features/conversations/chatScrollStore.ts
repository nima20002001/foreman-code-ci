import { useLayoutEffect, type RefObject } from 'react'
import { create } from 'zustand'
import { identityChangedEvent, identityEpoch } from '../../shared/api/protectedChatStorage'

type Position = { top: number; following: boolean }
const useChatScrollStore = create<{ positions: Record<string, Position>; remember(key: string, value: Position): void }>(set => ({
  positions: {}, remember: (key, value) => set(state => ({ positions: { ...state.positions, [key]: value } })),
}))
if (typeof window !== 'undefined') window.addEventListener(identityChangedEvent, () => useChatScrollStore.setState({ positions: {} }))

/** One presentation store shared by the existing floating and docked transcript renderers. */
export function useRememberedChatScroll(key: string | undefined, element: RefObject<HTMLDivElement | null>, following: RefObject<boolean>) {
  const scoped = key ? `${identityEpoch()}:${key}` : undefined
  useLayoutEffect(() => {
    const node = element.current, saved = scoped ? useChatScrollStore.getState().positions[scoped] : undefined
    if (saved && node) { node.scrollTop = saved.top; following.current = saved.following }
    return () => { if (scoped && node) useChatScrollStore.getState().remember(scoped, { top: node.scrollTop, following: following.current }) }
  }, [element, following, scoped])
}
