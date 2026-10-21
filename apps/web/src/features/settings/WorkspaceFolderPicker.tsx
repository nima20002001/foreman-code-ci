import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { errorMessage } from '../../shared/errorMessage'
import { useContext, useEffect, useId, useRef, useState, type RefObject } from 'react'
import { useBoundFolderDirectories, type BoundFolderBrowser } from '../../shared/api/workspaceBoundLocation'
import { useCreateWorkspaceFolder, useRenameWorkspaceFolder, useUndoWorkspaceFolder, useDeleteWorkspaceFolders, useHarnessDirectories, useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { WorkspaceFolderNameSchema, type WorkspaceFolderRenameInput } from '@foreman-code/contracts/management'
import { WorkspaceLocationCard } from './WorkspaceLocationCard'
import { ToastContext } from '../../shared/ui/nocturne/toastContext'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { ActionMenu, Alert, Button, Dialog, Icon, LoadingState, TextField } from '../../shared/ui/nocturne'
import './workspaceLocation.css'

type Props = { disabled: boolean; onSelect(path: string): void | Promise<void>; value?: string; label?: string; selectionUnconfirmed?: boolean; copyValue?: string; description?: string;
  directoryBinding?: BoundFolderBrowser; onReloadSavedLocation?(): Promise<boolean>; presentation?: 'card' | 'compact'; triggerRef?: RefObject<HTMLButtonElement | null> }
type Location = Parameters<typeof useHarnessDirectories>[0]
type HistoryEntry = { location: Location; selectedPath?: string; locationsOpen: boolean }

function useFolderPicker({ disabled, onSelect, selectionUnconfirmed = false, directoryBinding }: Props) {
  const [open, setOpen] = useState(false)
  const toasts = useContext(ToastContext)
  const id = useId()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()
  const [selecting, setSelecting] = useState(false)
  const [selectionError, setSelectionError] = useState<string>()
  // Browsing, a highlighted candidate, and the saved prop are different states.
  const [selectedPath, setSelectedPath] = useState<string>()
  const [locationsOpen, setLocationsOpen] = useState(false)
  const [location, setLocation] = useState<Location>({})
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const create = useCreateWorkspaceFolder()
  const rename = useRenameWorkspaceFolder()
  const undo = useUndoWorkspaceFolder()
  const remove = useDeleteWorkspaceFolders()
  const deleteAttempt = useRef(new CommandAttempt<{ paths: string[] }>())
  const [markedPaths, setMarkedPaths] = useState<string[]>([])
  const [editingFolder, setEditingFolder] = useState<NonNullable<typeof create.data>['value'] & { parentPath: string; creationCommandId?: string }>()
  const closeAfterName = useRef(false)
  const undoAttempt = useRef(new CommandAttempt<{ creationCommandId: string }>())
  const [newFolder, setNewFolder] = useState<(NonNullable<typeof create.data>['value'] & { creationCommandId: string; parentPath: string })>()
  const attempt = useRef(new CommandAttempt<{ parentPath: string }>())
  const renameAttempt = useRef(new CommandAttempt<Omit<WorkspaceFolderRenameInput, 'commandId'>>())
  const inFlight = useRef(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const newFolderRef = useRef<HTMLButtonElement>(null)
  const pathRef = useRef<HTMLInputElement>(null)
  const pendingFocus = useRef<'path' | 'new-folder' | null>(null)
  const locked = remove.isPending || deleteAttempt.current.unresolved || undo.isPending || undoAttempt.current.unresolved || selecting || create.isPending || rename.isPending || attempt.current.unresolved || renameAttempt.current.unresolved || selectionUnconfirmed
  const localQuery = useHarnessDirectories(directoryBinding ? {} : location, open && !disabled)
  const boundQuery = useBoundFolderDirectories(directoryBinding, location, open && !disabled)
  const query = directoryBinding ? boundQuery : localQuery
  const refreshFolders = () => { if (directoryBinding) void boundQuery.refetch() }
  const data = query.data
  // Approved Main browse roots do not confer app-managed mutation authority.
  const canMutatePath = (path: string | null | undefined, includeRoot = false) => Boolean(path && localQuery.data && !localQuery.isError
    && localQuery.data.roots.some((root) => (includeRoot && path === root.path) || path.startsWith(root.path.replace(/\/$/, '') + '/')))
  const currentPath = data?.path ?? location.path
  const namingFolder = editingFolder ?? newFolder
  const destination = creating && namingFolder && name.trim()
    ? namingFolder.parentPath.replace(/\/$/, '') + '/' + name.trim()
    : selectedPath ?? (locationsOpen ? undefined : currentPath)
  const canBrowse = !locked && !creating && !disabled && !query.isFetching && !query.isError
  const destinationAllowed = Boolean(destination && data?.roots.some((root) =>
    destination === root.path || destination.startsWith(root.path.replace(/\/$/, '') + '/')))
  const canSelect = !markedPaths.length && !remove.isPending && !deleteAttempt.current.unresolved && !undo.isPending && !undoAttempt.current.unresolved && !selecting && !create.isPending && !attempt.current.unresolved && !disabled
    && destinationAllowed && (selectionUnconfirmed || (!query.isFetching && !query.isError))

  useFolderPickerFocus({ open, creating, error, locked, location, locationsOpen, path: data?.path,
    fetching: query.isFetching, failed: query.isError, nameRef, newFolderRef, pathRef, pendingFocus })

  const openPicker = () => {
    pendingFocus.current = 'path'
    setHistory([]); setLocation({}); setLocationsOpen(false); setSelectedPath(undefined)
    setMarkedPaths([]); setEditingFolder(undefined); closeAfterName.current = false
    setCreating(false); setNewFolder(undefined); setName(''); setError(undefined); setSelectionError(undefined); setOpen(true)
  }
  const navigateFolder = (next: Location, showLocations = false) => {
    setMarkedPaths([])
    pendingFocus.current = 'path'
    setHistory((previous) => [...previous, {
      location: { ...location, rootId: data?.rootId ?? location.rootId, path: data?.path ?? location.path },
      selectedPath, locationsOpen,
    }])
    setLocation(next); setLocationsOpen(showLocations); setSelectedPath(undefined); setSelectionError(undefined)
  }
  const goBack = () => {
    setMarkedPaths([])
    if (creating) { pendingFocus.current = 'new-folder'; setCreating(false); setEditingFolder(undefined); setName(namingFolder?.name ?? ''); setError(undefined); return }
    pendingFocus.current = 'path'
    const previous = history.at(-1)
    if (previous) {
      setLocation(previous.location); setLocationsOpen(previous.locationsOpen); setSelectedPath(previous.locationsOpen ? previous.selectedPath : undefined)
      setHistory((items) => items.slice(0, -1))
    } else {
      setLocation(data?.parent && data.rootId ? { rootId: data.rootId, path: data.parent } : { rootId: location.rootId })
      setLocationsOpen(false); setSelectedPath(undefined)
    }
    setSelectionError(undefined)
  }
  const selectPath = async (path: string) => {
    setSelectedPath(path); setSelecting(true); setSelectionError(undefined)
    try { await onSelect(path); setOpen(false) }
    catch (failure) { setSelectionError(errorMessage(failure, 'The location could not be saved.')) }
    finally { setSelecting(false) }
  }
  const creationRoot = locationsOpen
    ? data?.roots.find((root) => root.path === selectedPath) ?? (data?.roots.length === 1 ? data.roots[0] : undefined)
    : undefined
  const creationParent = locationsOpen ? creationRoot?.path : data?.path
  const createFolder = async () => {
    if (inFlight.current || disabled || selectionUnconfirmed || creating || query.isFetching || query.isError || !creationParent || !canMutatePath(creationParent, true)) return
    inFlight.current = true; setError(undefined)
    try {
      const input = attempt.current.input({ parentPath: creationParent })
      const result = await create.mutateAsync(input)
      attempt.current.succeeded()
      refreshFolders()
      if (locationsOpen && creationRoot) navigateFolder({ rootId: creationRoot.id, path: creationRoot.path })
      setNewFolder({ ...result.value, parentPath: input.parentPath, creationCommandId: input.commandId })
      setEditingFolder(undefined); setMarkedPaths([])
      setSelectedPath(result.value.path); setName(result.value.name); setCreating(true)
    } catch (failure) {
      attempt.current.failed(failure)
      setError(errorMessage(failure, 'The folder could not be created.'))
    } finally { inFlight.current = false }
  }
  const finishName = async (select: boolean) => {
    if (inFlight.current || !namingFolder || !canMutatePath(namingFolder.path)) return
    const valid = WorkspaceFolderNameSchema.safeParse(name)
    if (!valid.success) { setError(valid.error.issues[0]?.message ?? 'Enter a folder name.'); return }
    inFlight.current = true; setError(undefined)
    try {
      let path = namingFolder.path
      if (name.trim() !== namingFolder.name || renameAttempt.current.unresolved) {
        const input = renameAttempt.current.input({ ...(namingFolder.creationCommandId
          ? { creationCommandId: namingFolder.creationCommandId } : { path: namingFolder.path }), name: name.trim() })
        const result = await rename.mutateAsync(input)
        renameAttempt.current.succeeded()
        refreshFolders()
        path = result.value.path
        if (newFolder?.path === namingFolder.path) setNewFolder({ ...newFolder, ...result.value })
      }
      setSelectedPath(path); setCreating(false); setEditingFolder(undefined); setMarkedPaths([])
      if (select) await selectPath(path)
      else if (closeAfterName.current) setOpen(false)
      else { pendingFocus.current = 'path'; pathRef.current?.focus() }
    } catch (failure) {
      closeAfterName.current = false
      renameAttempt.current.failed(failure)
      setError(errorMessage(failure, 'The folder could not be renamed.'))
    } finally { inFlight.current = false }
  }

  const deleteFolders = async (paths: string[]) => {
    if (!paths.length || !paths.every(path => canMutatePath(path)) || inFlight.current || disabled || creating || selectionUnconfirmed) return
    inFlight.current = true; setError(undefined); setMarkedPaths(paths)
    try {
      const result = await remove.mutateAsync(deleteAttempt.current.input({ paths }))
      deleteAttempt.current.succeeded()
      refreshFolders()
      setMarkedPaths(result.value.failed.map((item) => item.path))
      if (newFolder && result.value.deleted.includes(newFolder.path)) setNewFolder(undefined)
      if (selectedPath && result.value.deleted.includes(selectedPath)) setSelectedPath(undefined)
      if (result.value.failed.length) setError(result.value.failed.map((item) => `${item.path.split('/').at(-1)}: ${item.message}`).join('\n'))
      else { pendingFocus.current = 'new-folder'; toasts?.notify({ tone: 'success', title: result.value.deleted.length === 1 ? 'Folder deleted' : 'Folders deleted' }) }
    } catch (failure) {
      deleteAttempt.current.failed(failure)
      setError(errorMessage(failure, 'The folders could not be deleted.'))
    } finally { inFlight.current = false }
  }

  const undoCreation = async () => {
    if (!newFolder || !canMutatePath(newFolder.path) || inFlight.current || disabled || remove.isPending || deleteAttempt.current.unresolved || selecting || create.isPending || rename.isPending
      || attempt.current.unresolved || renameAttempt.current.unresolved || selectionUnconfirmed) return
    inFlight.current = true; setError(undefined)
    try {
      await undo.mutateAsync(undoAttempt.current.input({ creationCommandId: newFolder.creationCommandId }))
      undoAttempt.current.succeeded()
      refreshFolders()
      if (currentPath === newFolder.path || currentPath?.startsWith(newFolder.path + '/')) {
        setLocation({ rootId: data?.rootId ?? location.rootId, path: newFolder.parentPath })
        setHistory([])
      }
      setHistory((items) => items.filter((item) => item.location.path !== newFolder.path && !item.location.path?.startsWith(newFolder.path + '/')))
      setSelectedPath(undefined); setCreating(false); setNewFolder(undefined); setName('')
      pendingFocus.current = 'new-folder'
      toasts?.notify({ tone: 'success', title: 'Folder creation undone' })
    } catch (failure) {
      undoAttempt.current.failed(failure)
      setError(errorMessage(failure, 'Folder creation could not be undone.'))
    } finally { inFlight.current = false }
  }

  const listedEntries = locationsOpen
    ? data?.roots.map((root) => ({ name: root.label, path: root.path, rootId: root.id }))
    : data?.directories.map((entry) => ({ ...entry, rootId: data?.rootId }))
  const entries = !locationsOpen && newFolder && newFolder.parentPath === currentPath
    ? [...(listedEntries ?? []).filter((entry) => entry.path !== newFolder.path), { ...newFolder, rootId: data?.rootId }]
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    : listedEntries


  return {
    open, setOpen, toasts, id, creating, setCreating, name, setName, error, setError, selecting,
    setSelecting, selectionError, setSelectionError, setSelectedPath, locationsOpen, location, setLocation,
    history, setHistory, create, rename, undo, remove, deleteAttempt, markedPaths, setMarkedPaths,
    setEditingFolder, closeAfterName, undoAttempt, newFolder, attempt, renameAttempt, inFlight, nameRef,
    newFolderRef, pathRef, locked, boundQuery, query, data, canMutatePath, currentPath, namingFolder,
    destination, canBrowse, canSelect, openPicker, navigateFolder, goBack, selectPath, creationParent,
    createFolder, finishName, deleteFolders, undoCreation, entries,
  }
}

function FolderPicker({ disabled, onSelect, value, label = 'Project folder', selectionUnconfirmed = false, copyValue, description, directoryBinding, onReloadSavedLocation, presentation, triggerRef }: Props) {
  const {
    open, setOpen, toasts, id, creating, setCreating, name, setName, error, setError, selecting,
    setSelecting, selectionError, setSelectionError, setSelectedPath, locationsOpen, location, setLocation,
    history, setHistory, create, rename, undo, remove, deleteAttempt, markedPaths, setMarkedPaths,
    setEditingFolder, closeAfterName, undoAttempt, newFolder, attempt, renameAttempt, inFlight, nameRef,
    newFolderRef, pathRef, locked, boundQuery, query, data, canMutatePath, currentPath, namingFolder,
    destination, canBrowse, canSelect, openPicker, navigateFolder, goBack, selectPath, creationParent,
    createFolder, finishName, deleteFolders, undoCreation, entries,
  } = useFolderPicker({
    disabled, onSelect, value, label, selectionUnconfirmed, copyValue, description, directoryBinding,
    onReloadSavedLocation, presentation, triggerRef,
  })
  const operationPending = create.isPending || rename.isPending || undo.isPending || remove.isPending || selecting
  const operationUncertain = attempt.current.unresolved || renameAttempt.current.unresolved
    || undoAttempt.current.unresolved || deleteAttempt.current.unresolved || selectionUnconfirmed
  useUnsavedChanges({
    scope: 'surface', label: 'Project folder', dirty: open && creating,
    busy: operationPending, uncertain: operationUncertain && !operationPending, error: error ?? selectionError,
    saveDisabled: selectionUnconfirmed,
    save: async () => {
      if (deleteAttempt.current.unresolved) await deleteFolders(markedPaths)
      else if (undoAttempt.current.unresolved) await undoCreation()
      else if (attempt.current.unresolved) await createFolder()
      else if (creating) await finishName(true)
    },
    discard: () => {
      if (locked || inFlight.current) return
      setCreating(false)
      setOpen(false)
    },
  })

  return <>
    {value !== undefined ? <WorkspaceLocationCard label={label} path={value} description={description} presentation={presentation} triggerRef={triggerRef}
      disabled={disabled} onChoose={openPicker} onCopy={copyValue ? async () => {
        try { await navigator.clipboard.writeText(copyValue); toasts?.notify({ tone: 'success', title: 'Folder path copied' }) }
        catch { toasts?.notify({ tone: 'danger', title: 'Could not copy the folder path' }) }
      } : undefined} />
      : <Button leading={<Icon name="folder" size={16} />} disabled={disabled} onClick={openPicker}>Choose folder</Button>}
    <Dialog closeOnOutsideClick open={open} onOpenChange={(next) => {
      if (!next && creating) { closeAfterName.current = true; if (!inFlight.current) void finishName(false); return }
      if (!locked) setOpen(next)
    }} busy={locked} title="Choose folder" description={directoryBinding ? 'Main' : undefined}
      className={`workspace-folder-dialog${directoryBinding ? ' workspace-folder-dialog--minimal-labels' : ''}`} onKeyDownCapture={(event) => {
        if (event.key === 'Delete' && !creating && !(event.target instanceof HTMLInputElement)) {
          if (markedPaths.length && !locked) { event.preventDefault(); void deleteFolders(markedPaths) }
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey && newFolder) {
          event.preventDefault(); event.stopPropagation(); void undoCreation()
        }
      }}
      headerLeading={<Button variant="ghost" leading={<Icon name="arrow" size={16} style={{ transform: 'rotate(180deg)' }} />}
        data-skip-folder-blur
        disabled={locked || disabled || query.isFetching || (!creating && !history.length && !data?.parent && !(query.isError && location.path))}
        onClick={goBack}>Back</Button>}
      footer={<>
        <div className="workspace-folder-confirm">
          <Button variant="ghost" disabled={locked} onClick={() => {
            if (creating) { closeAfterName.current = true; void finishName(false) } else setOpen(false)
          }}>Cancel</Button>
          <Button variant="primary" loading={selecting || create.isPending || rename.isPending}
            data-confirm-location
            disabled={creating ? remove.isPending || deleteAttempt.current.unresolved || undo.isPending || undoAttempt.current.unresolved || disabled || create.isPending || rename.isPending || selecting || !name.trim() : !canSelect}
            onClick={async () => {
              if (creating) { await finishName(true); return }
              if (!canSelect || !destination || inFlight.current) return
              inFlight.current = true
              try { await selectPath(destination) } finally { inFlight.current = false }
            }}>{selecting ? 'Saving…' : create.isPending ? 'Creating…' : rename.isPending ? 'Naming…' : 'Select location'}</Button>
        </div>
      </>}>
      <div className="workspace-folder-browser">
        {selectionError ? <Alert tone="danger" live title={selectionError}>
          {selectionUnconfirmed ? 'Saving could not be confirmed. Retry Select location to resolve the same request.' : null}
        </Alert> : null}
        <div className="workspace-folder-destination">
          <TextField ref={pathRef} label="Destination" value={destination ?? ''} placeholder="Choose a location" readOnly />
        </div>
        <div className="workspace-folder-toolbar">
          {data && data.roots.length > 1 && !locationsOpen
            ? <Button variant="ghost" disabled={!canBrowse} onClick={() => navigateFolder(location, true)}>Locations</Button>
            : directoryBinding && !locationsOpen ? null : <h3 id={id + '-folders'}>{locationsOpen ? 'Locations' : 'Folders'}</h3>}
          <span className="workspace-folder-actions">
          {markedPaths.length ? <Button variant="ghost" disabled={remove.isPending || (locked && !deleteAttempt.current.unresolved)} onClick={() => void deleteFolders(markedPaths)}>
            {deleteAttempt.current.unresolved && !remove.isPending ? 'Retry delete' : `Delete (${markedPaths.length})`}
          </Button> : null}
          {newFolder && canMutatePath(newFolder.path) ? <Button variant="ghost" data-skip-folder-blur aria-keyshortcuts="Control+z Meta+z"
            disabled={remove.isPending || deleteAttempt.current.unresolved || undo.isPending || selecting || create.isPending || rename.isPending || attempt.current.unresolved || renameAttempt.current.unresolved || selectionUnconfirmed}
            onClick={() => void undoCreation()}>{undo.isPending ? 'Undoing…' : undoAttempt.current.unresolved ? 'Retry undo' : 'Undo'}</Button> : null}
          {canMutatePath(creationParent, true) ? <Button ref={newFolderRef} variant="ghost" disabled={remove.isPending || deleteAttempt.current.unresolved || undo.isPending || undoAttempt.current.unresolved || !creationParent || disabled || creating || create.isPending || selecting || selectionUnconfirmed || renameAttempt.current.unresolved || query.isFetching || query.isError}
            onClick={() => void createFolder()}>{attempt.current.unresolved && !create.isPending ? 'Retry creation' : 'New folder'}</Button> : null}
          </span>
        </div>
        {error && !creating ? <Alert tone="danger" live title={error} /> : null}
        {attempt.current.unresolved && !create.isPending ? <p role="status">Creation could not be confirmed. Retry creation to resolve the same request.</p> : null}
        {!creating && (query.isFetching ? <LoadingState label="Loading folders…" /> : query.isError
          ? <Alert tone="danger" live title={query.error.message}
              action={<Button disabled={locked || disabled} onClick={() => void query.refetch()}>Retry</Button>} />
          : data?.roots.length === 0
            ? <p className="workspace-folder-empty" role="status">No folders are available to browse.</p>
            : null)}
        <p className="n-sr-only" id={id + '-help'}>Open a folder to browse. {canMutatePath(currentPath, true) ? 'Control-click selects multiple folders; Delete removes selected empty folders. ' : ''}Select location confirms the destination. {newFolder && canMutatePath(newFolder.path) ? 'Control+Z undoes the latest folder creation.' : ''}</p>
        {(!locationsOpen && creating) || (!query.isError && !query.isFetching && Boolean(entries?.length)) ? <ul className="workspace-folder-entries" aria-label={locationsOpen ? 'Locations' : 'Folders'}>
          {entries?.map((entry) => <li key={entry.path} className="workspace-folder-entry" data-selected={markedPaths.includes(entry.path) || (creating && namingFolder?.path === entry.path)}>
            {creating && namingFolder?.path === entry.path ? <div className="workspace-folder-name-editor">
              <Icon name="folder" size={16} />
              <TextField ref={nameRef} label="Folder name" value={name} error={error} disabled={locked}
                autoComplete="off" spellCheck={false}
                onChange={(event) => { setName(event.target.value); setError(undefined) }}
                onBlur={(event) => {
                  if (event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-skip-folder-blur],[data-confirm-location]')) return
                  if (!locked) void finishName(false)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void finishName(false) }
                  if (event.key === 'Escape' && !locked) { event.preventDefault(); event.stopPropagation(); goBack() }
                }} />
              {renameAttempt.current.unresolved && !rename.isPending ? <p role="status">Retry Select location to confirm this name.</p> : null}
            </div> : <Button className="workspace-folder-select" disabled={!canBrowse} variant="ghost"
              aria-pressed={markedPaths.includes(entry.path)}
              aria-describedby={id + '-help'} leading={<Icon name="folder" size={16} />}
              onClick={(event) => {
                if ((event.ctrlKey || event.metaKey) && !locationsOpen && canMutatePath(entry.path)) {
                  setMarkedPaths((paths) => paths.includes(entry.path) ? paths.filter((path) => path !== entry.path) : [...paths, entry.path])
                } else if (canBrowse && entry.rootId) navigateFolder({ rootId: entry.rootId, path: entry.path })
              }}>
              {entry.name}
            </Button>}
            {!locationsOpen && canMutatePath(entry.path) ? <ActionMenu label={`Actions for ${entry.name}`} width={160} disabled={!canBrowse} items={[
              { id: 'rename', label: 'Rename', onSelect: () => {
                setEditingFolder({ ...entry, parentPath: currentPath!, ...(newFolder?.path === entry.path ? { creationCommandId: newFolder.creationCommandId } : {}) })
                setName(entry.name); setError(undefined); setMarkedPaths([]); setCreating(true)
              } },
              { id: 'delete', label: 'Delete', danger: true, onSelect: () => { void deleteFolders([entry.path]) } },
            ]} /> : null}
          </li>)}
        </ul> : null}
        {!creating && !locationsOpen && data?.nextCursor && !query.isError ? <Button className="workspace-folder-next" variant="ghost"
          disabled={!canBrowse} onClick={() => navigateFolder({ rootId: data.rootId ?? undefined, path: data.path ?? undefined, cursor: data.nextCursor! })}>
          Next folders
        </Button> : null}
        {directoryBinding && boundQuery.data?.truncated && !data?.nextCursor ? <p role="status">This folder has more entries than can be shown. Browse a more specific folder.</p> : null}
        {onReloadSavedLocation ? <Button disabled={locked || disabled || creating} onClick={async () => {
          setSelecting(true)
          try {
            if (!await onReloadSavedLocation()) return
            setLocation({})
            setHistory([])
            setSelectedPath(undefined)
            setSelectionError(undefined)
          } finally { setSelecting(false) }
        }}>Reload saved location</Button> : null}
      </div>
    </Dialog>
  </>
}

export function WorkspaceFolderPicker(props: Props) {
  const epoch = useHarnessSessionEpoch()
  return <FolderPicker key={epoch} {...props} />
}

type FolderPickerFocus = {
  open: boolean
  creating: boolean
  error: string | undefined
  locked: boolean
  location: Location
  locationsOpen: boolean
  path: string | null | undefined
  fetching: boolean
  failed: boolean
  nameRef: RefObject<HTMLInputElement | null>
  newFolderRef: RefObject<HTMLButtonElement | null>
  pathRef: RefObject<HTMLInputElement | null>
  pendingFocus: RefObject<'path' | 'new-folder' | null>
}

function useFolderPickerFocus({ open, creating, error, locked, location, locationsOpen, path,
  fetching, failed, nameRef, newFolderRef, pathRef, pendingFocus }: FolderPickerFocus) {
  useEffect(() => {
    if (open && creating) { nameRef.current?.focus(); nameRef.current?.select() }
  }, [open, creating, nameRef])
  useEffect(() => { if (error && !locked) nameRef.current?.focus() }, [error, locked, nameRef])
  useEffect(() => {
    // Deliberate navigation restores focus; background refreshes do not.
    if (!open || creating || !pendingFocus.current) return
    if (pendingFocus.current === 'new-folder' && newFolderRef.current?.disabled) return
    const target = pendingFocus.current === 'new-folder' ? newFolderRef.current : pathRef.current
    if (target) { target.focus(); pendingFocus.current = null }
  }, [open, creating, location, locationsOpen, path, fetching, failed, locked, pendingFocus, newFolderRef, pathRef])

}
