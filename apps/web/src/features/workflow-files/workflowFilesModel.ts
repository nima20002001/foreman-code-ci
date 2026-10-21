import type {
  BoardFilesListInput, FilePage, FileRow, PermanentFileScope,
  WorkflowReferenceFileScope, WorkspaceReferenceFileScope,
} from '@foreman-code/contracts/files'

export type WorkflowFilesIdentity = Pick<BoardFilesListInput, 'workspaceId' | 'workflowId'>

export function workflowReferenceScope(identity: WorkflowFilesIdentity): WorkflowReferenceFileScope {
  return { kind: 'workflow_reference', workspaceId: identity.workspaceId, workflowId: identity.workflowId }
}

export function inheritedReferenceScope(identity: WorkflowFilesIdentity): WorkspaceReferenceFileScope {
  return { kind: 'workspace_reference', workspaceId: identity.workspaceId }
}

/** Names and object property order are never identity. */
export function referenceScopeKey(scope: PermanentFileScope): string {
  return JSON.stringify(scope.kind === 'workflow_reference'
    ? [scope.kind, scope.workspaceId, scope.workflowId] : [scope.kind, scope.workspaceId])
}

export function referenceFilesKey(scope: PermanentFileScope, generation: number) {
  return ['reference-files', generation, referenceScopeKey(scope)] as const
}

/** FIL-36's two exact-scope roots, not the frozen grouped-list DTO. */
export function referenceFilesRoot(scope: PermanentFileScope): string {
  const workspace = `/api/workspaces/${encodeURIComponent(scope.workspaceId)}`
  return scope.kind === 'workflow_reference'
    ? `${workspace}/workflows/${encodeURIComponent(scope.workflowId)}/reference-files`
    : `${workspace}/reference-files`
}

/** Paging can overlap after a mutation. Deduplicate IDs only; preserve equal names. */
export function visibleReferenceRows(pages: readonly FilePage[] = []): FileRow[] {
  const rows = new Map<string, FileRow>()
  for (const page of pages) for (const row of page.items) rows.set(row.file.fileId, row)
  return Array.from(rows.values()).filter(({ file }) => file.state !== 'removed')
}

export function referenceFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
