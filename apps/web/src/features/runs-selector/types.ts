import type { RunBoardSnapshotGetInput } from '@foreman-code/contracts/run-snapshots'

export type RunsSelectorScope = Readonly<Pick<RunBoardSnapshotGetInput, 'workspaceId' | 'workflowId'>>
export type SelectedRunIdentity = Readonly<RunsSelectorScope & { runId: RunBoardSnapshotGetInput['runId'] | null }>
