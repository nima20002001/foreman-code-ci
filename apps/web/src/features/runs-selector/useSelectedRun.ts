import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { defaultParseSearch, defaultStringifySearch, useRouter } from '@tanstack/react-router'
import { createRunSelectionSource } from './selectionGeneration'
import { readRunSelection, searchForSelectedRun, clearSelectedSubagentHash } from './search'
import type { RunsSelectorScope } from './types'

/** URL-only identity. No effect selects the newest Run and no local-storage fallback exists. */
export function useSelectedRun({ workspaceId, workflowId }: RunsSelectorScope) {
  const router = useRouter()
  const source = useMemo(() => createRunSelectionSource(
    () => readRunSelection({ workspaceId, workflowId }, {
      pathname: router.history.location.pathname,
      search: (router.options.parseSearch ?? defaultParseSearch)(router.history.location.search),
    }),
    (notify) => router.history.subscribe(notify),
  ), [router, workspaceId, workflowId])
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const { generation } = snapshot
  const capture = useCallback(() => generation, [generation])
  const selectRun = useCallback((runId: string | null) => {
    // An old open menu/callback must not navigate back into a departed workspace.
    if (!source.getSnapshot().active) return Promise.resolve()
    const history = router.history.location
    const previous = (router.options.parseSearch ?? defaultParseSearch)(history.search)
    const search = searchForSelectedRun(previous, { workspaceId, workflowId }, runId)
    // Use the router (including blockers), never window.history.pushState.
    // href avoids tying this standalone lane to the app's registered search type
    // before the documented route mount has extended that type.
    const query = (router.options.stringifySearch ?? defaultStringifySearch)(search)
    const hash = source.getSnapshot().identity.runId === runId
      ? history.hash : clearSelectedSubagentHash(history.hash)
    return router.navigate({ href: `/workspaces/${encodeURIComponent(workspaceId)}${query}${hash}`,
      resetScroll: false, replace: false })
  }, [router, source, workspaceId, workflowId])
  return useMemo(() => ({ ...snapshot, capture, isCurrent: source.isCurrent, selectRun }),
    [snapshot, capture, source, selectRun])
}
export type SelectedRunState = ReturnType<typeof useSelectedRun>
