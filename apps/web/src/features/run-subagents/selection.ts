import { useCallback, useSyncExternalStore } from 'react'
import { defaultParseSearch, defaultStringifySearch, useRouter } from '@tanstack/react-router'
import { RunSubagentGetInputSchema } from '@foreman-code/contracts/subagents'
import { readRunSelection, SELECTED_SUBAGENT_FRAGMENT_PARAM } from '../runs-selector/search'
import type { SubagentsScope } from './query'

export const SUBAGENT_SEARCH_PARAM = SELECTED_SUBAGENT_FRAGMENT_PARAM
/** URL fragment selection keeps the frozen, strict Board search contract unchanged. */
export function useSelectedSubagent(scope: SubagentsScope) {
  const router = useRouter()
  const parse = router.options.parseSearch ?? defaultParseSearch
  const read = useCallback(() => {
    const location = router.history.location
    const search = parse(location.search)
    const run = readRunSelection(scope, { pathname: location.pathname, search })
    if (!run.active || run.invalid || run.identity.runId !== scope.runId) return null
    const result = RunSubagentGetInputSchema.shape.subagentId.safeParse(new URLSearchParams(location.hash.slice(1)).get(SUBAGENT_SEARCH_PARAM))
    return result.success ? result.data : null
  }, [router, parse, scope])
  const subscribe = useCallback((notify: () => void) => router.history.subscribe(notify), [router])
  const selected = useSyncExternalStore(subscribe, read, read)
  const select = useCallback((id: string | null) => {
    const location = router.history.location
    const search = parse(location.search)
    const run = readRunSelection(scope, { pathname: location.pathname, search })
    if (!run.active || run.invalid || run.identity.runId !== scope.runId) return Promise.resolve()
    const fragment = new URLSearchParams(location.hash.slice(1))
    if (id === null) fragment.delete(SUBAGENT_SEARCH_PARAM)
    else fragment.set(SUBAGENT_SEARCH_PARAM, RunSubagentGetInputSchema.shape.subagentId.parse(id))
    const hash = fragment.size ? `#${fragment}` : ''
    const query = (router.options.stringifySearch ?? defaultStringifySearch)(search)
    return router.navigate({ href: `${location.pathname}${query}${hash}`, resetScroll: false })
  }, [router, parse, scope])
  return { selected, select }
}
