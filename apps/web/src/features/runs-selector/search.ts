import { RunBoardSnapshotGetInputSchema } from '@foreman-code/contracts/run-snapshots'
import { WorkspaceBoardSearchSchema, resolveWorkflowBoardLocation } from '@foreman-code/contracts/wave25'
import type { RunsSelectorScope } from './types'
import type { RunSelection } from './selectionGeneration'

/** Deliberately NOT `runId`: that frozen Board field requires version/semantics pins. */
export const SELECTED_RUN_PARAM = 'selectedRunId'
export const SELECTED_SUBAGENT_FRAGMENT_PARAM = 'selectedSubagentId'
const runIdSchema = RunBoardSnapshotGetInputSchema.shape.runId
export const RunsSelectorSearchSchema = WorkspaceBoardSearchSchema.safeExtend({
  selectedRunId: runIdSchema.optional(),
})

export function withoutRunsSelectorSearch<T extends object>(search: T) {
  const { selectedRunId: _selectedRun, ...boardSearch } = search as T & { selectedRunId?: unknown }
  void _selectedRun
  return boardSearch
}

/** Route integration seam; never loosen or change the frozen Board schema. */
export function resolveRunsSelectorBoardLocation(pathname: string, rawSearch: unknown) {
  const search = RunsSelectorSearchSchema.parse(rawSearch)
  const boardSearch = withoutRunsSelectorSearch(search)
  if (search.selectedRunId === undefined) return resolveWorkflowBoardLocation(pathname, boardSearch)
  // Selected Run inspection gets its version from the saved snapshot, not URL pins.
  const baseSearch = { ...boardSearch }
  delete baseSearch.runNodeId
  delete baseSearch.runRelationshipId
  delete baseSearch.runExchangeKey
  const board = resolveWorkflowBoardLocation(pathname, baseSearch)
  return { ...board, search: boardSearch }
}

export function readRunSelection(
  scope: RunsSelectorScope,
  location: { pathname: string; search: Record<string, unknown> },
): RunSelection {
  const identity = { ...scope, runId: null }
  const match = /^\/workspaces\/([^/]+)(?:\/workflows\/([^/]+)\/(?:draft|runs\/([^/]+)\/graph\/[^/]+\/3))?\/?$/.exec(location.pathname)
  let workspaceId: string | undefined, workflowId: unknown, pathRunId: string | undefined
  try {
    workspaceId = match ? decodeURIComponent(match[1]!) : undefined
    workflowId = match?.[2] ? decodeURIComponent(match[2]) : location.search.workflowId
    pathRunId = match?.[3] ? decodeURIComponent(match[3]) : undefined
  } catch { return { identity, active: false, invalid: true } }
  const active = workspaceId === scope.workspaceId && (workflowId === undefined || workflowId === scope.workflowId)
  if (!active) return { identity, active: false, invalid: false }
  // Existing fully pinned Board links are read aliases, not another local state source.
  const legacyRunId = pathRunId ?? location.search.runId
  const selectedRunId = location.search[SELECTED_RUN_PARAM]
  if (selectedRunId !== undefined && legacyRunId !== undefined && selectedRunId !== legacyRunId) {
    return { identity, active, invalid: true }
  }
  const raw = selectedRunId ?? legacyRunId
  if (raw === undefined) return { identity, active, invalid: false }
  const parsed = runIdSchema.safeParse(raw)
  // A history deep link must pin the workflow, not inherit the default workflow.
  if (!parsed.success || workflowId !== scope.workflowId) return { identity, active, invalid: true }
  return { identity: { ...scope, runId: parsed.data }, active, invalid: false }
}

export function searchForSelectedRun(
  previous: Record<string, unknown>, scope: RunsSelectorScope, runId: string | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...previous, workflowId: scope.workflowId }
  // Never leave another Run's graph/inspector pins beneath a new history selection.
  for (const key of ['runId', 'workflowVersionId', 'executionSemanticsVersion', 'runNodeId',
    'runRelationshipId', 'runExchangeKey', 'activityKind', 'activityAgentId', 'boardExecutionId', SELECTED_RUN_PARAM]) delete next[key]
  if (runId !== null) next[SELECTED_RUN_PARAM] = runIdSchema.parse(runId)
  return next
}

export function clearSelectedSubagentHash(hash: string): string {
  const prefix = hash.startsWith('#') ? '#' : ''
  const fragment = new URLSearchParams(hash.replace(/^#/, ''))
  if (!fragment.has(SELECTED_SUBAGENT_FRAGMENT_PARAM)) return hash
  fragment.delete(SELECTED_SUBAGENT_FRAGMENT_PARAM)
  return fragment.size ? `${prefix}${fragment}` : ''
}
