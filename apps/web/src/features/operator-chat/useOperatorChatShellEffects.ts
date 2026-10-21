import { useEffect, type RefObject } from 'react'
import { chatStoragePrefix } from '../../shared/api/protectedChatStorage'
import { operatorChatNarrowQuery, useOperatorChatStore } from './operatorChatStore'
import type { RefreshOutbox } from './operatorChatShared'

/** Panel-level effects: cross-tab outbox refresh, focus management, close animation and narrow-screen history. */
export function useOperatorChatShellEffects({ enabled, open, closing, setClosing, closeRef, launcherRef, refreshOutbox }: {
  enabled: boolean
  open: boolean
  closing: boolean
  setClosing: (closing: boolean) => void
  closeRef: RefObject<HTMLButtonElement | null>
  launcherRef: RefObject<HTMLButtonElement | null>
  refreshOutbox: RefreshOutbox
}) {
  const setHistoryOpen = useOperatorChatStore((state) => state.setHistoryOpen)
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(chatStoragePrefix)) refreshOutbox((value) => value + 1)
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [refreshOutbox])

  useEffect(() => {
    if (enabled && open) closeRef.current?.focus()
  }, [closeRef, enabled, open])
  useEffect(() => {
    if (!closing || open) return
    const timer = window.setTimeout(() => {
      setClosing(false)
      window.requestAnimationFrame(() => launcherRef.current?.focus())
    }, 180)
    return () => window.clearTimeout(timer)
  }, [closing, launcherRef, open, setClosing])
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(operatorChatNarrowQuery)
    const change = () => { if (media.matches) setHistoryOpen(false) }
    change()
    media.addEventListener?.('change', change)
    return () => media.removeEventListener?.('change', change)
  }, [setHistoryOpen])
}
