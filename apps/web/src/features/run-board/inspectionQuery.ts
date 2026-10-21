import { useQuery } from '@tanstack/react-query'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { isRunAccessError } from '../runs-selector/query'

export function runNodeInspectionKey(selection: SelectedRunState) {
  return ['saved-run-inspection', sessionGeneration(), selection.identity,
    selection.generation.id] as const
}

export async function readForRunVisit<T>(selection: SelectedRunState, signal: AbortSignal,
  read: () => Promise<T>): Promise<T> {
  const session = sessionGeneration()
  const result = await read()
  assertSession(session)
  signal.throwIfAborted()
  if (!selection.isCurrent(selection.generation)) throw new DOMException('Run selection changed.', 'AbortError')
  return result
}

export function useRunNodeRead<T>(selection: SelectedRunState, key: readonly unknown[],
  read: (signal: AbortSignal) => Promise<T>) {
  useHarnessSessionEpoch()
  return useQuery({
    queryKey: [...runNodeInspectionKey(selection), ...key],
    queryFn: ({ signal }) => readForRunVisit(selection, signal, () => read(signal)),
    enabled: selection.active && !selection.invalid && selection.isCurrent(selection.generation)
      && !sessionIsSwitching(),
    retry: false, staleTime: 0, gcTime: 0, placeholderData: () => undefined,
    refetchInterval: query => isRunAccessError(query.state.error) ? false : 3000,
  })
}
