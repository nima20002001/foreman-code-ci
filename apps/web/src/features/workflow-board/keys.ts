import { sessionGeneration } from '../../shared/api/sessionBoundary'
export const boardDraftContextKey = (workspaceId: string, workflowId: string) =>
  ['workbench', 'board-draft-context', sessionGeneration(), workspaceId, workflowId] as const
export const boardRunListKey = (workspaceId: string, workflowId: string) =>
  ['workbench', 'board-runs', sessionGeneration(), workspaceId, workflowId] as const
/** The immutable version pin of the active Run the Board takes over with. */
export const boardLiveRunSnapshotKey = (workspaceId: string, workflowId: string, runId: string | undefined) =>
  ['workbench', 'board-live-run-snapshot', sessionGeneration(), workspaceId, workflowId, runId] as const
