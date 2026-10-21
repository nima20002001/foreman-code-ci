import type { WorkspaceBatchArchiveInput, WorkspaceStorageFolder } from '@foreman-code/contracts/management'

/** Interaction snapshots, not another copy of the live workspace/folder catalog. */
export type WorkspaceSelectionTarget =
  | (WorkspaceBatchArchiveInput['workspaces'][number] & { kind: 'workspace'; name: string })
  | (Pick<WorkspaceStorageFolder, 'path' | 'identity' | 'name'> & { kind: 'folder' })

export const folderSelectionId = (path: string) => `folder:${path}`
