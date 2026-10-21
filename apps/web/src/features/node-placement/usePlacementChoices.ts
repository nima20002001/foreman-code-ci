import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient, type Query } from '@tanstack/react-query'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { ComputerActivityList } from '@foreman-code/contracts/computer-activity'
import type { ComputerMaintenanceList } from '@foreman-code/contracts/computer-maintenance'
import type { NodePlacementChoicesInput } from '@foreman-code/contracts/placement-readback'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { isApiAccessError } from '../../shared/api/accessError'
import { readPlacementChoices } from './client'
import type { NodePlacementOption } from './NodePlacementField'

function computerReadiness(query: Query, session: number): string | undefined {
  if (query.queryKey[1] !== session || !query.state.data) return undefined
  if (query.queryKey[0] === 'computer-activity') {
    const activity = query.state.data as ComputerActivityList
    return canonicalJson(activity.computers.map(({ target, online }) => ({ target, online })))
  }
  if (query.queryKey[0] === 'computer-maintenance') {
    const computer = query.state.data as ComputerMaintenanceList['computers'][number]
    return canonicalJson({ target: computer.target, readiness: computer.workerReadiness,
      workerVersion: computer.status?.worker?.currentVersion,
      harnesses: computer.status?.harnesses.map(({ harness, installed, version }) => ({ harness, installed, version })) })
  }
  return undefined
}

export function usePlacementChoices(scope: NodePlacementChoicesInput | undefined, visit: string) {
  const session = sessionGeneration()
  const client = useQueryClient()
  const queryKey = useMemo(() => ['node-placement-choices', session, visit, scope?.workspaceId, scope?.workflowId,
    scope?.nodeId, scope?.agentConfigurationVersionId],
  [session, visit, scope?.workspaceId, scope?.workflowId, scope?.nodeId, scope?.agentConfigurationVersionId])
  const enabled = !!scope && !sessionIsSwitching()
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      if (!scope) throw new Error('Save this node and Agent before choosing a computer.')
      const response = await readPlacementChoices(scope, { signal })
      assertSession(session)
      return response
    },
    refetchInterval: query => {
      if (isApiAccessError(query.state.error)) return false
      return query.state.data?.pending ? 5_000 : false
    },
    enabled, retry: false, staleTime: 0, gcTime: 0, placeholderData: () => undefined,
  })
  useEffect(() => {
    if (!enabled) return
    const cache = client.getQueryCache()
    const observed = new Map<string, string>()
    for (const entry of cache.getAll()) {
      const readiness = computerReadiness(entry, session)
      if (readiness !== undefined) observed.set(entry.queryHash, readiness)
    }
    return cache.subscribe(event => {
      if (event.type !== 'updated' || event.action.type !== 'success') return
      const readiness = computerReadiness(event.query, session)
      if (readiness === undefined) return
      const previous = observed.get(event.query.queryHash)
      observed.set(event.query.queryHash, readiness)
      if (readiness === previous || session !== sessionGeneration() || sessionIsSwitching()) return
      if (isApiAccessError(client.getQueryState(queryKey)?.error)) return
      void client.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false })
    })
  }, [client, enabled, queryKey, session])
  const current = session === sessionGeneration() && !sessionIsSwitching()
  const options: readonly NodePlacementOption[] = current && !query.isError && query.data ? query.data.choices.map((choice) => ({
    placement: choice.placement, label: choice.label,
    ...(choice.availability !== 'ready' ? { unavailableReason: choice.reason ?? `Computer ${choice.availability}` } : {}),
  })) : []
  return { ...query, current, options }
}
