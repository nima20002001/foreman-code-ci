import { useManagedWorkspacesQuery } from '../../shared/api/query'

/** Workspace labels for skills; only workspaces the user may read are listed. */
export function useWorkspaceNames(enabled = true) {
  const workspaces = useManagedWorkspacesQuery(enabled)
  const items = workspaces.data?.items ?? []
  return { workspaces, options: items.map((item) => ({ value: item.workspace.id, label: item.workspace.name })),
    name: (id: string) => items.find((item) => item.workspace.id === id)?.workspace.name ?? 'Workspace' }
}
