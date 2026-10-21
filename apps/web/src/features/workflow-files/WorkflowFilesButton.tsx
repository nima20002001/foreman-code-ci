import { errorMessage } from '../../shared/errorMessage'
import { useEffect, useId, useMemo, useRef } from 'react'
import { useStore } from 'zustand'
import { Download, Files } from 'lucide-react'
import type { FileWithRevision, PermanentFileScope } from '@foreman-code/contracts/files'
import { Button, IconButton } from '../../shared/ui/nocturne/Button'
import { Dialog, Tooltip } from '../../shared/ui/nocturne/Overlays'
import { Icon } from '../../shared/ui/nocturne/Icon'
import { TextField } from '../../shared/ui/nocturne/Fields'
import { TrashIconButton } from '../../shared/ui/ResourceCard'
import { useFloatingSurface } from '../../shared/ui/nocturne/useFloatingSurface'
import { useFileDrop } from '../../shared/ui/useFileDrop'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { ATTACHMENT_ACCEPT, inspectAttachment } from '../attachments/attachmentFiles'
import { createWorkflowFilesHttpClient, type WorkflowFilesClient } from './workflowFilesClient'
import { referenceFileSize, referenceScopeKey, visibleReferenceRows, type WorkflowFilesIdentity } from './workflowFilesModel'
import { createWorkflowFilesStore } from './workflowFilesStore'
import { useWorkflowFiles } from './useWorkflowFiles'
import './workflowFiles.css'

export interface WorkflowFilesButtonProps extends WorkflowFilesIdentity {
  /** Presentation only; the FIL-36 service always enforces current grants. */
  readOnly?: boolean
  className?: string
  client?: WorkflowFilesClient
}
const httpClient = createWorkflowFilesHttpClient()

export function WorkflowFilesButton(props: WorkflowFilesButtonProps) {
  // Switching A/B synchronously drops presentation and mutation observers, even
  // when the caller reuses this component rather than keying its Board.
  return <ScopedWorkflowFilesButton key={JSON.stringify([sessionGeneration(), props.workspaceId, props.workflowId])} {...props} />
}

function ScopedWorkflowFilesButton({ workspaceId, workflowId, readOnly = false, className, client = httpClient }: WorkflowFilesButtonProps) {
  const store = useMemo(createWorkflowFilesStore, [])
  const { open, removal, selectionIssue, setOpen, setRemoval, setSelectionIssue } = useStore(store)
  const files = useWorkflowFiles({ workspaceId, workflowId }, open, client)
  const trigger = useRef<HTMLButtonElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const cancelRemoval = useRef<HTMLButtonElement>(null)
  const id = useId()
  useFloatingSurface(open, trigger, surface, 340, 'end')

  useEffect(() => {
    if (!open) return
    surface.current?.focus()
    let startedOutside = false
    const outside = (target: EventTarget | null) => target instanceof Node
      && !trigger.current?.contains(target) && !surface.current?.contains(target)
    const down = (event: PointerEvent) => { startedOutside = outside(event.target) }
    const click = (event: MouseEvent) => {
      if (startedOutside && outside(event.target) && !store.getState().removal) setOpen(false)
      startedOutside = false
    }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('click', click, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('click', click, true)
    }
  }, [open, setOpen, store])

  function close() { setOpen(false); trigger.current?.focus() }
  function askRemove(row: FileWithRevision) {
    files.remove.reset()
    setRemoval({ row, commandId: crypto.randomUUID() })
  }
  function selectFile(file: File | undefined) {
    if (!file || readOnly || files.upload.isPending) return
    const inspected = inspectAttachment(file)
    setSelectionIssue(inspected.ok ? null : inspected.issue)
    if (inspected.ok) files.upload.mutate({ file, requestId: crypto.randomUUID() })
  }
  const drop = useFileDrop({ disabled: readOnly || files.upload.isPending || Boolean(removal), maxFiles: 1,
    onFiles: (selected) => selectFile(selected[0]) })
  const uploadError = files.upload.isError && !selectionIssue
  return <div className={['workflow-files-control', className].filter(Boolean).join(' ')}
    onBlur={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)
        && !store.getState().removal) setOpen(false)
    }}>
    <IconButton ref={trigger} size="sm" variant="ghost" label="Files"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}><Files size={16} aria-hidden="true" focusable="false" /></IconButton>
    {open && <div ref={surface} id={id} role="dialog" aria-label="Files" tabIndex={-1} popover="manual"
      className="n-theme workflow-files-popover"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && !removal) {
          event.preventDefault(); event.stopPropagation(); close()
        }
      }}>
      <header className="workflow-files-heading"><strong>Files</strong>
        <div className="workflow-files-actions">
          {!readOnly && <IconButton size="sm" variant="ghost" label="Add file"
            disabled={files.upload.isPending} onClick={() => picker.current?.click()}><Icon name="plus" size={16} /></IconButton>}
          <IconButton size="sm" variant="ghost" label="Close files" onClick={close}><Icon name="close" size={16} /></IconButton>
        </div>
      </header>
      <section role="group" aria-label="Workflow files" className="workflow-files-group workflow-files-drop-area" {...drop.dropTargetProps}>
        {!readOnly && <div hidden><TextField ref={picker} type="file" label="Choose workflow file" hidden
          accept={ATTACHMENT_ACCEPT} tabIndex={-1} disabled={files.upload.isPending}
          onChange={(event) => { drop.clearDropError(); selectFile(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} /></div>}
        {files.upload.isPending && <p className="workflow-files-status" role="status">Uploading…</p>}
        {drop.isDragging && visibleReferenceRows(files.workflow.data?.pages).length > 0 &&
          <p className="workflow-files-status" role="status">Drop to add file</p>}
        {drop.dropError && <p className="workflow-files-error" role="alert">{drop.dropError}</p>}
        {selectionIssue && <p className="workflow-files-error" role="alert" title={selectionIssue.message}>{selectionIssue.label}</p>}
        {uploadError && <div className="workflow-files-status"><p role="alert" title={errorDetail(files.upload.error)}>Upload failed</p>
          {!readOnly && <IconButton size="sm" variant="ghost" label="Retry upload" onClick={() => {
            if (files.upload.variables) files.upload.mutate(files.upload.variables)
          }}><Icon name="refresh" size={16} /></IconButton>}
        </div>}
        <FileGroup query={files.workflow} scope={files.workflowScope} files={files} label="workflow"
          emptyLabel={readOnly ? 'No files' : drop.isDragging ? 'Drop to add file' : 'Drop a file here'} onRemove={readOnly ? undefined : askRemove} />
      </section>
      {(files.workspace.isPending || files.workspace.isError || files.workspace.hasNextPage || visibleReferenceRows(files.workspace.data?.pages).length > 0) &&
        <section role="group" aria-label="Inherited workspace files" className="workflow-files-group workflow-files-inherited">
          <div className="workflow-files-heading"><h3>Workspace</h3>
            <span role="img" title="Inherited · read-only" aria-label="Inherited, read-only"><Icon name="lock" size={14} /></span>
          </div>
          <FileGroup query={files.workspace} scope={files.workspaceScope} files={files} label="workspace" />
        </section>}
      {files.download.isError && <p className="workflow-files-error" role="alert" title={errorDetail(files.download.error)}>Download failed</p>}
    </div>}
    {removal && <Dialog open onOpenChange={(next) => { if (!next) setRemoval(null) }} title="Remove file?"
      role="alertdialog" size="sm" busy={files.remove.isPending} initialFocusRef={cancelRemoval} returnFocusRef={trigger}
      className="workflow-files-confirm" footer={<>
        <Button ref={cancelRemoval} size="sm" disabled={files.remove.isPending} onClick={() => setRemoval(null)}>Cancel</Button>
        <Button size="sm" variant="danger" loading={files.remove.isPending} disabled={readOnly} onClick={() => {
          files.remove.mutate({ commandId: removal.commandId,
            ref: { fileId: removal.row.file.fileId, revisionId: removal.row.revision.revisionId } },
          { onSuccess: () => setRemoval(null) })
        }}>Remove</Button>
      </>}>
      <p className="workflow-files-confirm-name">{removal.row.revision.filename}</p>
      {files.remove.isError && <p className="workflow-files-error" role="alert" title={errorDetail(files.remove.error)}>Remove failed</p>}
    </Dialog>}
  </div>
}

function FileGroup({ query, scope, files, label, emptyLabel = 'No files', onRemove }: {
  query: ReturnType<typeof useWorkflowFiles>['workflow']
  scope: PermanentFileScope
  files: ReturnType<typeof useWorkflowFiles>
  label: 'workflow' | 'workspace'
  emptyLabel?: string
  onRemove?: (row: FileWithRevision) => void
}) {
  const rows = visibleReferenceRows(query.data?.pages)
  return <>
    {query.isPending && <p className="workflow-files-status" role="status">Loading…</p>}
    {query.isError && <div className="workflow-files-status"><p role="alert">Couldn’t load</p>
      <IconButton size="sm" variant="ghost" label={`Retry ${label} files`} disabled={query.isFetching}
        onClick={() => { void query.refetch() }}><Icon name="refresh" size={16} /></IconButton>
    </div>}
    {!query.isPending && !query.isError && rows.length === 0 && !files.upload.isPending && <p className="workflow-files-status workflow-files-empty">{emptyLabel}</p>}
    <ul className="workflow-files-list">
      {rows.map((row) => {
        const downloading = files.download.isPending && files.download.variables?.row.file.fileId === row.file.fileId
          && referenceScopeKey(files.download.variables.scope) === referenceScopeKey(scope)
        return <li key={row.file.fileId} className="workflow-files-row">
          <div className="workflow-files-name"><span title={row.revision.filename}>{row.revision.filename}</span>
            <small>{referenceFileSize(row.revision.byteSize)}{row.file.state === 'pending' ? ' · Pending' : ''}</small>
          </div>
          <div className="workflow-files-actions">
            {row.file.state === 'ready' && <Tooltip content="Download"><IconButton size="sm" variant="ghost"
              label={`Download ${row.revision.filename}`} disabled={files.download.isPending} loading={downloading}
              onClick={() => files.download.mutate({ scope, row })}><Download size={16} aria-hidden="true" focusable="false" /></IconButton></Tooltip>}
            {onRemove && <TrashIconButton target={row.revision.filename} action="Remove"
              disabled={files.remove.isPending} onClick={() => onRemove(row)} />}
          </div>
        </li>
      })}
    </ul>
    {query.hasNextPage && <Button size="sm" variant="ghost" aria-label={`More ${label} files`}
      loading={query.isFetchingNextPage} disabled={query.isFetching}
      onClick={() => { void query.fetchNextPage() }}>More</Button>}
  </>
}

function errorDetail(error: unknown): string {
  return errorMessage(error, 'Request failed.')
}
