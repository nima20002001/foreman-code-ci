import { errorMessage } from '../../shared/errorMessage'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useStore } from 'zustand'
import { createResourceSelection } from '../../shared/ui/resourceSelection'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'
import { LoadMore } from '../../shared/ui/LoadMore'
import type { ManagedWorkspace, WorkspaceBatchArchiveInput, WorkspaceStorageFolderDeleteInput } from '@foreman-code/contracts/management'

import {
  queryKeys, useArchiveManagedWorkspaceMutation, useWorkspacePages,
  useUpdateManagedWorkspaceMutation,
  useWorkspaceStorageFolderPages,
} from '../../shared/api/query'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { ApiError, apiClient } from '../../shared/api/client'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { ActionMenu, Alert, Button, Dialog, EmptyState, ErrorState, LoadingState, PageHeader, TextField } from '../../shared/ui/nocturne'
import { ResourceActionsMenu, ResourceCard } from '../../shared/ui/ResourceCard'
import '../../shared/ui/resourceDirectory.css'
import { WorkspaceStorageFolderCard } from './WorkspaceStorageFolderCards'
import { folderSelectionId, type WorkspaceSelectionTarget } from './workspaceSelection'
interface CardCommand { type: 'rename' | 'archive'; workspaceId: string; expectedRevision: number; name?: string }

function WorkspaceCardActions({ workspaceId, name, revision = 0, disabled, onCommand }: {
  workspaceId: string
  name: string
  revision?: number
  disabled?: boolean
  onCommand: (input: CardCommand & { commandId: string }) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [nextName, setNextName] = useState(name)
  const [baseRevision, setBaseRevision] = useState(revision)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const inFlight = useRef(false)
  const attempt = useRef(new CommandAttempt<CardCommand>())
  const lastCommand = useRef<CardCommand | undefined>(undefined)
  const close = () => {
    if (!inFlight.current && !attempt.current.unresolved) setOpen(false)
  }
  useEffect(() => {
    // A refetch while the menu is open cannot attach a new revision to an old form.
    if (!open) { setNextName(name); setBaseRevision(revision) }
  }, [name, open, revision])

  const submit = async (type: CardCommand['type']) => {
    if (inFlight.current) return
    const value = nextName.trim()
    if (type === 'rename' && !value) { setError('Enter a workspace name.'); return }
    inFlight.current = true
    setPending(true); setError(undefined)
    const generation = sessionGeneration()
    try {
      const input: CardCommand = attempt.current.unresolved && lastCommand.current ? lastCommand.current : {
        type, workspaceId, expectedRevision: baseRevision, ...(type === 'rename' ? { name: value } : {}),
      }
      lastCommand.current = input
      await onCommand(attempt.current.input(input))
      assertSession(generation)
      attempt.current.succeeded()
      setOpen(false)
    } catch (cause) {
      attempt.current.failed(cause)
      if (sessionGeneration() === generation) setError(errorMessage(cause, 'The workspace could not be updated.'))
    } finally { inFlight.current = false; setPending(false) }
  }
  const uncertain = attempt.current.unresolved && !pending
  return (
    <ResourceActionsMenu name={name} disabled={disabled} open={open} onOpenChange={(next) => {
      if (!next) close()
      else { setNextName(name); setBaseRevision(revision); setError(undefined); setConfirmingRemove(false); setOpen(true) }
    }}>
      <TextField label="Name" disabled={pending || uncertain} value={nextName} onChange={(event) => setNextName(event.target.value)} />
      {error ? <Alert live tone="danger" title={error} /> : null}
      {uncertain ? <>
        <Alert live tone="warning" title="The previous request may have succeeded.">Retry it before making another change.</Alert>
        <Button onClick={() => void submit(lastCommand.current?.type ?? 'rename')}>Retry previous request</Button>
      </> : confirmingRemove ? <>
        <Alert tone="warning" title="Remove this workspace?">App-created project folders and their contents will be deleted. Existing folders you selected are kept. Workflow and run history is retained.</Alert>
        <Button variant="danger" disabled={pending} onClick={() => void submit('archive')}>Confirm removal</Button>
        <Button disabled={pending} onClick={() => setConfirmingRemove(false)}>Cancel</Button>
      </> : <>
        <Button disabled={pending} onClick={() => void submit('rename')}>Rename</Button>
        <Button variant="danger" disabled={pending} onClick={() => setConfirmingRemove(true)}>Remove workspace</Button>
        <Button variant="ghost" disabled={pending} onClick={close}>Close</Button>
      </>}
    </ResourceActionsMenu>
  )
}

export function WorkspaceDirectory() {
  const queryClient = useQueryClient()
  const managedQuery = useWorkspacePages(true, 'directory')

  const failed = managedQuery.isError && !managedQuery.isFetchNextPageError
  const loading = managedQuery.isPending
  const folderQuery = useWorkspaceStorageFolderPages(!loading && !failed)
  const [selectionStore] = useState(() => createResourceSelection<WorkspaceSelectionTarget>())
  const selection = useStore(selectionStore)
  const count = Object.keys(selection.selected).length
  const attempt = useRef(new CommandAttempt<Omit<WorkspaceBatchArchiveInput, 'commandId'>>())
  const folderAttempts = useRef(new Map<string, CommandAttempt<Omit<WorkspaceStorageFolderDeleteInput, 'commandId'>>>())
  const confirmationTargets = useRef<WorkspaceSelectionTarget[]>([])
  const confirmedDeleted = useRef(0)
  const inFlight = useRef(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const recordDeleted = (ids: string[]) => {
    confirmedDeleted.current += ids.length
    selectionStore.setState((current) => ({
      selected: Object.fromEntries(Object.entries(current.selected).filter(([id]) => !ids.includes(id))),
      notice: `${confirmedDeleted.current} deleted. Undeleted selections are kept until their removal is confirmed.`,
    }))
  }
  const batch = useMutation({ mutationFn: async (targets: WorkspaceSelectionTarget[]) => {
    const generation = sessionGeneration()
    const workspaces = targets.filter((target) => target.kind === 'workspace')
    if (workspaces.length) {
      try {
        const result = await apiClient.archiveManagedWorkspaceBatch(attempt.current.input({
          workspaces: workspaces.map(({ workspaceId, expectedRevision }) => ({ workspaceId, expectedRevision })),
        }))
        assertSession(generation)
        attempt.current.succeeded()
        const deleted = new Set(result.value.workspaceIds)
        queryClient.setQueriesData<InfiniteData<Awaited<ReturnType<typeof apiClient.listManagedWorkspacePage>>>>(
          { queryKey: [...queryKeys.managedWorkspaces, 'pages'] }, (current) => current ? {
            ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.filter((item) => !deleted.has(item.workspace.id)) })),
          } : current,
        )
        recordDeleted([...deleted])
        queryClient.removeQueries({ predicate: (query) => deleted.has(String(query.queryKey[3]))
          && query.queryKey[1] === 'management' && query.queryKey[2] === 'workspace' })
      } catch (error) { attempt.current.failed(error); throw error }
    }
    for (const target of targets) {
      if (target.kind !== 'folder') continue
      const folderAttempt = folderAttempts.current.get(target.path) ?? new CommandAttempt<Omit<WorkspaceStorageFolderDeleteInput, 'commandId'>>()
      folderAttempts.current.set(target.path, folderAttempt)
      try {
        const result = await apiClient.deleteWorkspaceStorageFolder(folderAttempt.input({ path: target.path, expectedIdentity: target.identity }))
        assertSession(generation)
        folderAttempt.succeeded()
        queryClient.setQueryData<InfiniteData<Awaited<ReturnType<typeof apiClient.listWorkspaceStorageFolderPage>>>>(
          queryKeys.workspaceStorageFolders, (current) => current ? {
            ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.filter((item) => item.path !== result.value.path) })),
          } : current,
        )
        recordDeleted([folderSelectionId(result.value.path)])
      } catch (error) { folderAttempt.failed(error); throw error }
    }
  } })
  const uncertain = attempt.current.unresolved || [...folderAttempts.current.values()].some((value) => value.unresolved)
  const locked = batch.isPending || uncertain
  const toggleSelection = (id: string, target: WorkspaceSelectionTarget) => {
    if (locked) return
    selection.toggle(id, target)
    if (Object.keys(selectionStore.getState().selected).length) selectionStore.setState({ selecting: true, notice: '' })
    else selection.clear()
  }
  const closeConfirmation = () => { if (!locked) { selection.confirm(false); batch.reset() } }
  const deleteSelected = async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      await batch.mutateAsync(Object.values(selectionStore.getState().selected))
      const noun = confirmationTargets.current.every((target) => target.kind === 'workspace') ? 'workspace'
        : confirmationTargets.current.every((target) => target.kind === 'folder') ? 'folder' : 'item'
      selection.clear(`${confirmedDeleted.current} ${noun}${confirmedDeleted.current === 1 ? '' : 's'} deleted.`)
    } catch { /* The mutation shows the error; only confirmed targets leave the selection. */ }
    finally {
      inFlight.current = false
      void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspaces })
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceStorageFolders })
    }
  }

  const items = useMemo(() => [...new Map((managedQuery.data?.pages.flatMap((page) => page.items) ?? [])
    .map((item) => [item.workspace.id, item])).values()], [managedQuery.data])
  const workspaces = useMemo(
    () => items.map((item) => item.workspace),
    [items],
  )
  const folders = [...new Map((folderQuery.data?.pages.flatMap((page) => page.items) ?? []).map((folder) => [folder.path, folder])).values()]
  // Workspace-scoped readers cannot browse unrelated folders on the runner.
  const foldersDenied = folderQuery.isError && ApiError.is(folderQuery.error) && folderQuery.error.status === 403
  const foldersFailed = folderQuery.isError && !folderQuery.isFetchNextPageError
  const showFolders = !loading && !failed && !foldersDenied
  const visibleFolders = showFolders && !folderQuery.isPending && !foldersFailed ? folders : []
  const selectable = [
    ...items.map((item) => ({ id: item.workspace.id, revision: { kind: 'workspace' as const, workspaceId: item.workspace.id, name: item.workspace.name, expectedRevision: item.revision } })),
    ...folders.filter((folder) => folder.deletion.status === 'available').map((folder) => ({ id: folderSelectionId(folder.path),
      revision: { kind: 'folder' as const, name: folder.name, path: folder.path, identity: folder.identity } })),
  ].slice(0, 100)
  const allShownSelected = selectable.length > 0 && selectable.every((item) => item.id in selection.selected)
  const managedById = new Map(items.map((item) => [item.workspace.id, item]))
  const selectedProtected = folders.some((folder) => folder.deletion.status === 'protected' && folderSelectionId(folder.path) in selection.selected)
  const confirmationNoun = confirmationTargets.current.every((target) => target.kind === 'workspace') ? 'workspace'
    : confirmationTargets.current.every((target) => target.kind === 'folder') ? 'folder' : 'item'
  const confirmationLabel = `${confirmationTargets.current.length} ${confirmationNoun}${confirmationTargets.current.length === 1 ? '' : 's'}`

  const execute = useWorkspaceCardCommands(queryClient)
  return (
    <section className="workspace-directory resource-directory" aria-label="Workspaces">
      <PageHeader
        title="Workspaces"
        actions={selection.selecting && !failed ? <div className="resource-directory-actions">
          <Button variant="danger" disabled={!count || locked || selectedProtected} onClick={() => {
            confirmationTargets.current = Object.values(selection.selected)
            confirmedDeleted.current = 0
            batch.reset(); selection.confirm(true)
          }}>Delete selected{count ? ` (${count})` : ''}</Button>
          <ActionMenu label="Selection options" width={200} disabled={locked} items={[
            { id: 'select-shown', label: allShownSelected ? 'Clear selection'
              : items.length + folders.filter((folder) => folder.deletion.status === 'available').length > 100 ? 'Select first 100 shown' : 'Select all shown',
              disabled: !selectable.length, onSelect: () => allShownSelected ? selection.clear() : selection.selectMany(selectable) },
            { id: 'cancel-selection', label: 'Cancel selection', onSelect: () => selection.clear() },
          ]} />
        </div> : undefined}
      />
      {selection.notice ? <p role="status">{selection.notice}</p> : null}
      {selectedProtected ? <Alert tone="warning" title="A selected folder is now protected.">Deselect it to continue. Its protection reason is shown on its card.</Alert> : null}
      {failed ? <ErrorState title="Workspaces unavailable" description="Check the local API connection, then retry the workspace list."
          onRetry={() => void managedQuery.refetch()} /> : workspaces.length + visibleFolders.length > 0 ? (
        <ul className="workspace-card-list resource-card-list" data-testid="workspace-card-list">
          {workspaces.map((workspace) => <li key={workspace.id}>
            <ResourceCard name={workspace.name} icon="folder" data-testid={`workspace-card-${workspace.id}`}
              selection={{
                mode: selection.selecting ? 'visible' : 'hover',
                'aria-label': `Select ${workspace.name}`, checked: workspace.id in selection.selected,
                disabled: locked || (count >= 100 && !(workspace.id in selection.selected)),
                onChange: () => toggleSelection(workspace.id, { kind: 'workspace', workspaceId: workspace.id,
                  name: workspace.name, expectedRevision: managedById.get(workspace.id)!.revision }),
              }}
              open={<Link to="/workspaces/$workspaceId/settings" params={{ workspaceId: workspace.id }} search={{}} aria-label={workspace.name} />}
              actions={<WorkspaceCardActions workspaceId={workspace.id} name={workspace.name}
                revision={managedById.get(workspace.id)?.revision} disabled={locked} onCommand={execute} />}
              protection={managedById.get(workspace.id)?.locationValidation.status === 'restricted' ? { label: 'Location restricted' } : undefined} />
          </li>)}
          {visibleFolders.map((folder) => <li key={folderSelectionId(folder.path)}>
            <WorkspaceStorageFolderCard folder={folder} selection={{ ...selection, toggle: toggleSelection, locked, count }} />
          </li>)}
        </ul>
      ) : loading ? <LoadingState label="Loading workspaces…" />
        : failed ? <Alert live tone="danger" title="Workspaces unavailable" />
          : !folders.length ? <div data-testid="workspace-directory-empty">
            <EmptyState icon="folder" title="No workspaces yet" description="Use New workspace in the navigation to create one." />
          </div> : null}
      <LoadMore loadAll label="workspaces" query={managedQuery} />
      {showFolders ? folderQuery.isPending ? <LoadingState label="Checking workspace folders…" />
        : foldersFailed ? <ErrorState title="Workspace folders unavailable" description="Folders on disk could not be checked."
          onRetry={() => void folderQuery.refetch()} /> : <LoadMore loadAll label="workspace folders" query={folderQuery} /> : null}
      <Dialog open={selection.confirming} onOpenChange={(open) => { if (!open) closeConfirmation() }}
        title={`Delete ${confirmationLabel}?`}
        description="App-created project folders and selected disk folders will be permanently deleted with all files and subfolders. Existing folders selected as workspace destinations are kept. Workflow and run history is retained. Active runs block workspace deletion. Folder deletions run one at a time; earlier confirmed deletions remain if a later target fails."
        busy={locked} initialFocusRef={cancelRef} size="sm"
        footer={<>
          <Button ref={cancelRef} disabled={locked} onClick={closeConfirmation}>Cancel</Button>
          <Button variant="danger" disabled={batch.isPending || (selectedProtected && !uncertain)} onClick={() => void deleteSelected()}>
            {batch.isPending ? 'Deleting…' : uncertain ? 'Retry deletion' : confirmedDeleted.current ? `Delete remaining (${count})` : `Delete ${confirmationLabel}`}
          </Button>
        </>}>
        <ul>{confirmationTargets.current.map((target) => <li key={target.kind === 'folder' ? folderSelectionId(target.path) : target.workspaceId}>
          {target.name}{target.kind === 'folder' ? <span dir="ltr"> — {target.path}</span> : null}
          {!((target.kind === 'folder' ? folderSelectionId(target.path) : target.workspaceId) in selection.selected) ? <small> — Deleted</small> : null}
        </li>)}</ul>
        {confirmedDeleted.current > 0 ? <p role="status">{confirmedDeleted.current} deleted. {count} remaining selections.</p> : null}
        {selectedProtected && !uncertain ? <Alert tone="warning" title="A selected folder is now protected.">Close this confirmation and deselect it to continue.</Alert> : null}
        {batch.isError ? <Alert tone="danger" live title={batch.error.message} /> : null}
        {uncertain && !batch.isPending ? <p role="status">The request may have succeeded. Retry deletion to check its outcome safely.</p> : null}
      </Dialog>
    </section>
  )
}

function useWorkspaceCardCommands(queryClient: ReturnType<typeof useQueryClient>) {
  const updateWorkspace = useUpdateManagedWorkspaceMutation()
  const archiveWorkspace = useArchiveManagedWorkspaceMutation()
  const execute = async (input: CardCommand & { commandId: string }) => {
    const { workspaceId, commandId, expectedRevision } = input
    const response = input.type === 'rename'
      ? await updateWorkspace.mutateAsync({ workspaceId, commandId, expectedRevision, name: input.name! })
      : await archiveWorkspace.mutateAsync({ workspaceId, commandId, expectedRevision })
    // The write has committed. Cache refresh failure must not turn it into a retryable write.
    queryClient.setQueriesData<InfiniteData<{ items: ManagedWorkspace[]; pageInfo: { nextCursor: string | null } }>>({ queryKey: [...queryKeys.managedWorkspaces, 'pages'] }, (current) => current ? {
      ...current,
      pages: current.pages.map((page) => ({ ...page, items: input.type === 'archive' ? page.items.filter((item) => item.workspace.id !== workspaceId)
        : page.items.map((item) => item.workspace.id === workspaceId ? response.value : item) })),
    } : current)
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspaces }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceStorageFolders }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) }),
    ]).catch(() => undefined)
  }
  return execute
}
