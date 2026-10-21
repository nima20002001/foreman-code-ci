import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { AppNavigationHistoryContext } from './appNavigationHistoryContext'

function isAppDestination(pathname: string) {
  return /^\/(workspaces|settings|terminal|approvals)(\/|$)/.test(pathname)
}

/** Only observed app entries are safe to revisit; a deep link cannot establish its predecessor. */
export function AppNavigationHistoryProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const entries = useRef(new Set<number>())
  const [canGoBack, setCanGoBack] = useState(false)
  useEffect(() => {
    const record = () => {
      const { pathname, state } = router.history.location
      const index = state.__TSR_index
      if (isAppDestination(pathname)) entries.current.add(index)
      else entries.current.delete(index)
      setCanGoBack(entries.current.has(index - 1))
    }
    record()
    return router.history.subscribe(({ action, location }) => {
      if (action.type === 'PUSH') {
        for (const index of entries.current) if (index >= location.state.__TSR_index) entries.current.delete(index)
      }
      record()
    })
  }, [router])
  return <AppNavigationHistoryContext.Provider value={canGoBack}>{children}</AppNavigationHistoryContext.Provider>
}
