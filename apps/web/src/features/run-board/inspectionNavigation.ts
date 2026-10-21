import { defaultStringifySearch, useLocation, useRouter } from '@tanstack/react-router'
import { readRunInspectionKey, runInspectionKey } from '@foreman-code/contracts/wave25'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'

export function useRunNodeInspectionNavigation(selection: SelectedRunState) {
  const router = useRouter()
  const location = useLocation()
  const search = location.search as Record<string, unknown>
  const nodeId = typeof search.runNodeId === 'string' ? search.runNodeId : undefined
  const exchange = typeof search.runExchangeKey === 'string' ? search.runExchangeKey : undefined
  const executionId = readRunInspectionKey(exchange).executionId
  const inspect = (nextNodeId?: string, nextExecutionId?: string) => {
    if (!selection.isCurrent(selection.generation)) return
    const next = { ...search }
    delete next.runNodeId
    delete next.runRelationshipId
    delete next.runExchangeKey
    if (nextNodeId) next.runNodeId = nextNodeId
    if (nextExecutionId) next.runExchangeKey = runInspectionKey({ executionId: nextExecutionId })
    const query = (router.options.stringifySearch ?? defaultStringifySearch)(next)
    void router.navigate({ href: `${location.pathname}${query}${location.hash}`, resetScroll: false })
  }
  return { nodeId, executionId, inspect }
}
