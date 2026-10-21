import { InfoHint } from '../../shared/ui/InfoHint'
import { useRef, useState } from 'react'
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import type { WorkspaceStorageFolder, WorkspaceStorageFolderDeleteInput } from '@foreman-code/contracts/management'
import { apiClient } from '../../shared/api/client'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { queryKeys } from '../../shared/api/query'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, Button, Dialog } from '../../shared/ui/nocturne'
import { ResourceActionsMenu, ResourceCard } from '../../shared/ui/ResourceCard'
import { folderSelectionId, type WorkspaceSelectionTarget } from './workspaceSelection'

interface FolderSelection {
  selecting: boolean
  selected: Record<string, WorkspaceSelectionTarget>
  locked: boolean
  count: number
  toggle: (id: string, value: WorkspaceSelectionTarget) => void
}

export function WorkspaceStorageFolderCard({ folder, selection }: { folder: WorkspaceStorageFolder; selection: FolderSelection }) {
  const [confirming, setConfirming] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const queryClient = useQueryClient()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const inFlight = useRef(false)
  const attempt = useRef(new CommandAttempt<Omit<WorkspaceStorageFolderDeleteInput, 'commandId'>>())
  const target = useRef(folder)
  const removal = useMutation({ mutationFn: (input: WorkspaceStorageFolderDeleteInput) => apiClient.deleteWorkspaceStorageFolder(input) })
  const locked = removal.isPending || attempt.current.unresolved
  const close = () => { if (!locked) { setConfirming(false); removal.reset() } }
  const remove = async () => {
    if (inFlight.current) return
    inFlight.current = true
    const generation = sessionGeneration()
    try {
      const result = await removal.mutateAsync(attempt.current.input({ path: target.current.path, expectedIdentity: target.current.identity }))
      assertSession(generation)
      attempt.current.succeeded()
      queryClient.setQueryData<InfiniteData<Awaited<ReturnType<typeof apiClient.listWorkspaceStorageFolderPage>>>>(
        queryKeys.workspaceStorageFolders, (current) => current ? {
          ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.filter((item) => item.path !== result.value.path) })),
        } : current,
      )
      setConfirming(false)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceStorageFolders })
    } catch (error) { attempt.current.failed(error) }
    finally { inFlight.current = false }
  }
  const selected = folderSelectionId(folder.path) in selection.selected
  return <ResourceCard name={folder.name} icon="folder"
    selection={{
      mode: selection.selecting ? 'visible' : 'hover',
      hint: folder.deletion.status === 'protected' ? <span className="visually-hidden">{folder.deletion.message}</span> : undefined,
      'aria-label': `Select folder ${folder.name}`, checked: selected,
      disabled: selection.locked || (!selected && (folder.deletion.status === 'protected' || selection.count >= 100)),
      onChange: () => selection.toggle(folderSelectionId(folder.path), { kind: 'folder', name: folder.name, path: folder.path, identity: folder.identity }),
    }}
    actions={<ResourceActionsMenu name={`folder ${folder.name}`} disabled={selection.locked} open={menuOpen} onOpenChange={setMenuOpen}>
      <span>Folder<InfoHint label="Folder">Folder on disk without a workspace.</InfoHint></span>
      {folder.deletion.status === 'protected' ? <Alert tone="warning" title="This folder is protected.">{folder.deletion.message}</Alert> : null}
      <Button variant="danger" disabled={folder.deletion.status === 'protected'}
        onClick={() => { target.current = folder; setMenuOpen(false); setConfirming(true) }}>Delete folder</Button>
      <Button variant="ghost" onClick={() => setMenuOpen(false)}>Close</Button>
    </ResourceActionsMenu>}
    protection={folder.deletion.status === 'protected' ? { label: `Protected folder. ${folder.deletion.message}`, reason: folder.deletion.message } : undefined}>
    <Dialog open={confirming} onOpenChange={(open) => { if (!open) close() }}
      title={`Delete ${target.current.name}?`} busy={locked} initialFocusRef={cancelRef} size="sm"
      description="This permanently deletes this workspace folder and all its files and subfolders. It cannot be undone."
      footer={<>
        <Button ref={cancelRef} disabled={locked} onClick={close}>Cancel</Button>
        <Button variant="danger" disabled={removal.isPending} onClick={() => void remove()}>
          {removal.isPending ? 'Deleting…' : attempt.current.unresolved ? 'Retry deletion' : 'Delete folder and contents'}
        </Button>
      </>}>
      <p dir="ltr">{target.current.path}</p>
      {removal.isError ? <Alert live tone="danger" title={removal.error.message} /> : null}
      {attempt.current.unresolved && !removal.isPending ? <p role="status">The request may have succeeded. Retry deletion to check its outcome safely.</p> : null}
    </Dialog>
  </ResourceCard>
}
