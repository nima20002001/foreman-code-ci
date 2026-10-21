import { useLayoutEffect } from 'react'
import { create } from 'zustand'

type ScrollPosition = { top: number; left: number }
type SidePanelPresentation = {
  widths: Record<string, number>
  scroll: Record<string, Record<string, ScrollPosition>>
  collapsedTeams: Record<string, string[]>
  setWidth(scope: string, width: number): void
  rememberScroll(scope: string, positions: Record<string, ScrollPosition>): void
  toggleTeam(scope: string, nodeId: string): void
}

/** Local presentation only. The URL remains the sole owner of active selection. */
export const useSidePanelPresentation = create<SidePanelPresentation>(set => ({
  widths: {}, scroll: {}, collapsedTeams: {},
  toggleTeam: (scope, nodeId) => set(state => ({ collapsedTeams: { ...state.collapsedTeams,
    [scope]: (state.collapsedTeams[scope] ?? []).includes(nodeId)
      ? state.collapsedTeams[scope]!.filter(id => id !== nodeId) : [...(state.collapsedTeams[scope] ?? []), nodeId],
  } })),
  setWidth: (scope, width) => set(state => ({ widths: { ...state.widths, [scope]: width } })),
  rememberScroll: (scope, positions) => set(state => ({ scroll: { ...state.scroll, [scope]: positions } })),
}))

/** Existing transcript components may unmount; their DOM scroll is retained without a second subscription. */
export function useSidePanelScroll(host: HTMLDivElement | null, scope: string, suspended: boolean) {
  useLayoutEffect(() => {
    if (!host || suspended) return
    const positions = { ...useSidePanelPresentation.getState().scroll[scope] }
    const restored = new WeakSet<Element>()
    const key = (element: HTMLElement) => element === host ? 'panel'
      : `${element.tagName}:${element.getAttribute('aria-label') ?? ''}:${element.className}`
    const remember = (event: Event) => {
      if (!(event.target instanceof HTMLElement)) return
      positions[key(event.target)] = { top: event.target.scrollTop, left: event.target.scrollLeft }
    }
    const restore = () => {
      for (const element of [host, ...host.querySelectorAll<HTMLElement>('[role="region"], [class*="scroll"]')]) {
        const saved = positions[key(element)]
        if (!saved || restored.has(element)) continue
        restored.add(element)
        element.scrollTop = saved.top; element.scrollLeft = saved.left
        // Let existing follow-latest logic observe the restored browsing position.
        element.dispatchEvent(new Event('scroll'))
      }
    }
    host.addEventListener('scroll', remember, true)
    restore()
    const observer = new MutationObserver(restore)
    observer.observe(host, { childList: true, subtree: true })
    return () => {
      observer.disconnect(); host.removeEventListener('scroll', remember, true)
      useSidePanelPresentation.getState().rememberScroll(scope, positions)
    }
  }, [host, scope, suspended])
}
