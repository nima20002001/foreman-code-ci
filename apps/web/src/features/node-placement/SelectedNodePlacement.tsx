import { useQuery } from '@tanstack/react-query'
import { useBlockingReadError } from '../../shared/api/readFailure'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { isRunAccessError, runReadErrorLabel } from '../runs-selector/query'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { NodePlacementFacts } from './NodePlacementFacts'
import { readNodePlacement } from './client'

/** Same visit-generation fence as RunBoard. No current Agent or workspace
 * settings can fill missing accepted placement. No stale/private placeholders. */
export function SelectedNodePlacement({ selection, nodeId }: { selection: SelectedRunState; nodeId: string }) {
  const { identity, generation } = selection
  const session = useHarnessSessionEpoch()
  const query = useQuery({
    queryKey: ['node-placement', session, identity.workspaceId, identity.workflowId, identity.runId, generation.id, nodeId],
    queryFn: async ({ signal }) => {
      if (identity.runId === null) throw new Error('Select an exact Run before reading computer evidence.')
      const result = await readNodePlacement({ ...identity, runId: identity.runId, nodeId }, { signal })
      assertSession(session)
      if (!selection.isCurrent(generation)) throw new DOMException('Run selection changed.', 'AbortError')
      return result
    },
    enabled: selection.active && !selection.invalid && identity.runId !== null && !sessionIsSwitching(),
    retry: false, staleTime: 0, gcTime: 0, placeholderData: () => undefined,
    refetchInterval: query => isRunAccessError(query.state.error) ? false : 3000,
  })
  const blocked = useBlockingReadError(query)
  const current = selection.active && !selection.invalid && selection.isCurrent(generation) && session === sessionGeneration() && !sessionIsSwitching()
  if (!current || identity.runId === null) return null
  if (blocked || query.isError && !query.data) return <p role="status">{runReadErrorLabel(query.error)}. Computer evidence is unavailable.
    <button type="button" onClick={() => { if (selection.isCurrent(generation)) void query.refetch() }}>Refresh computer evidence</button>
  </p>
  if (!query.data) return <p role="status">{query.isPaused ? 'Offline. Computer evidence is unavailable.' : 'Reading accepted computer evidence…'}</p>
  return <>
    {query.isError ? <p role="status">Computer details refresh failed. Showing the last successful read from {new Date(query.dataUpdatedAt).toLocaleTimeString()}.
      <button type="button" onClick={() => void query.refetch()}>Retry computer details</button></p> : null}
    <NodePlacementFacts runId={identity.runId} nodeId={nodeId} readback={query.data.readback} />
  </>
}
