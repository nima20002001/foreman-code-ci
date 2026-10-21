import { InfoHint } from '../../shared/ui/InfoHint'
import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { useMutation } from '@tanstack/react-query'
import { createStore, useStore } from 'zustand'
import { Download, File as FileIcon, RotateCcw, Trash2, Upload } from 'lucide-react'
import type { FileRow } from '@foreman-code/contracts/files'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { Button, Dialog, IconButton, TextField } from '../../shared/ui/nocturne'
import { useFileDrop } from '../../shared/ui/useFileDrop'
import { ATTACHMENT_ACCEPT, inspectAttachment } from '../attachments/attachmentFiles'
import { projectFilesClient, type ProjectFileRemoveInput } from './projectFilesClient'
import { useProjectFileRemove, useProjectFilesQuery, useProjectFileUpload } from './projectFilesQueries'
import './projectFiles.css'

export interface ProjectFilesSectionProps { workspaceId: string }

/** Mount with the route's workspaceId. No settings draft, selection store, or new provider is required. */
export function ProjectFilesSection({ workspaceId }: ProjectFilesSectionProps) {
  return <WorkspaceProjectFiles key={JSON.stringify([sessionGeneration(), workspaceId])} workspaceId={workspaceId} />
}

interface SectionUi { removing: FileRow | null; selectionIssue: string | null }
function WorkspaceProjectFiles({ workspaceId }: ProjectFilesSectionProps) {
  // A view-owned Zustand store holds only local interactions; a key change discards the old dialog/picker.
  const [uiStore] = useState(() => createStore<SectionUi>(() => ({ removing: null, selectionIssue: null })))
  const ui = useStore(uiStore)
  const input = useRef<HTMLInputElement>(null)
  const uploadButton = useRef<HTMLButtonElement>(null)
  const heading = useId()
  const query = useProjectFilesQuery(workspaceId)
  const upload = useProjectFileUpload(workspaceId)
  function selectFile(file: File | undefined) {
    if (!file || upload.isPending || ui.removing) return
    const result = inspectAttachment(file)
    uiStore.setState({ selectionIssue: result.ok ? null : `${result.issue.label}. ${result.issue.message}` })
    // Picker and drop both retain this workspace's upload and validation flow.
    if (result.ok) upload.start(file)
  }
  const drop = useFileDrop({ disabled: upload.isPending || Boolean(ui.removing), maxFiles: 1,
    onFiles: (files) => selectFile(files[0]) })
  const rows = new Map<string, FileRow>()
  for (const page of query.data?.pages ?? []) for (const row of page.items) rows.set(row.file.fileId, row)
  const visibleRows = Array.from(rows.values()).filter((row) => row.file.state !== 'removed')

  return <section className="project-files" aria-labelledby={heading} {...drop.dropTargetProps}>
    <header className="project-files-header">
      <div className="n-field-label"><h2 id={heading}>Project files</h2>
        <InfoHint label="Project files">Drop a file here or use Upload.</InfoHint></div>
      <TextField ref={input} type="file" label="Choose project file" className="project-files-picker"
        accept={ATTACHMENT_ACCEPT} tabIndex={-1} disabled={upload.isPending || Boolean(ui.removing)}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          drop.clearDropError(); selectFile(file)
        }} />
      <Button ref={uploadButton} size="sm" disabled={upload.isPending || Boolean(ui.removing)} onClick={() => input.current?.click()}
        leading={<Upload size={16} aria-hidden="true" />}>Upload</Button>
    </header>
    {drop.isDragging && <p className="project-files-message">Drop to upload</p>}
    {drop.dropError && <p className="project-files-message" role="alert">{drop.dropError}</p>}
    {ui.selectionIssue && <p className="project-files-message" role="alert">{ui.selectionIssue}</p>}
    {upload.isPending && <p className="project-files-message" role="status" aria-label={`Uploading ${upload.filename ?? 'file'}`}>Uploading…</p>}
    {upload.isError && <div className="project-files-notice">
      <p className="project-files-message" role="alert">{upload.contentGuidance ?? 'Upload failed.'}</p>
      {upload.canRetry && <IconButton label={`Retry upload ${upload.filename ?? 'file'}`} variant="ghost" size="sm" onClick={upload.retry}>
        <RotateCcw size={16} aria-hidden="true" />
      </IconButton>}
    </div>}
    {query.isPending && <p className="project-files-message" role="status">Loading…</p>}
    {query.isError && <div className="project-files-notice">
      <p className="project-files-message" role="alert">Couldn’t load files.</p>
      <IconButton label="Retry loading project files" variant="ghost" size="sm" disabled={query.isFetching}
        onClick={() => { void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch()) }}>
        <RotateCcw size={16} aria-hidden="true" />
      </IconButton>
    </div>}
    {visibleRows.length > 0 && <ul className="project-files-list" aria-label="Project files">
      <li className="project-files-columns" aria-hidden="true"><span>Name</span><span>Type</span><span>Size</span><span>Actions</span></li>
      {visibleRows.map((row) => <ProjectFileItem key={`${row.file.fileId}:${row.revision.revisionId}`}
        workspaceId={workspaceId} row={row} onRemove={() => uiStore.setState({ removing: row })} />)}
    </ul>}
    {!query.isPending && !query.isError && visibleRows.length === 0 && <p className="project-files-message">No files.</p>}
    {query.hasNextPage && <Button size="sm" variant="ghost" disabled={query.isFetching}
      onClick={() => { void query.fetchNextPage() }}>More</Button>}
    {ui.removing && <ProjectFileRemoval workspaceId={workspaceId} row={ui.removing} returnFocusRef={uploadButton}
      onClose={() => uiStore.setState({ removing: null })} />}
  </section>
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function ProjectFileItem({ workspaceId, row, onRemove }: ProjectFilesSectionProps & { row: FileRow; onRemove: () => void }) {
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    // Construct inside the effect so StrictMode's cleanup/setup gets a fresh, live signal.
    const current = new AbortController()
    controller.current = current
    return () => { current.abort() }
  }, [])
  const generation = sessionGeneration()
  const download = useMutation({
    retry: false, networkMode: 'always',
    mutationFn: async (signal: AbortSignal) => {
      assertSession(generation)
      const blob = await projectFilesClient.download(workspaceId, row, signal)
      assertSession(generation)
      signal.throwIfAborted() // A late download from a previous workspace cannot open under this view.
      const url = URL.createObjectURL(blob)
      const revoke = URL.revokeObjectURL.bind(URL)
      const link = document.createElement('a')
      try {
        link.href = url
        link.download = row.revision.filename
        document.body.append(link)
        link.click()
      } finally {
        link.remove()
        // Revoke after the browser has handled the download click, including when the row unmounts.
        setTimeout(() => revoke(url), 0)
      }
    },
  })
  const name = row.revision.filename
  return <li className="project-file">
    <FileIcon size={18} aria-hidden="true" className="project-file-icon" />
    <span className="project-file-details">
      <span className="project-file-name" title={name}>{name}</span>
    </span>
    <span className="project-file-type" title={row.revision.mediaType}>{row.revision.filename.split('.').at(-1)?.toUpperCase()}</span>
    <span className="project-file-size" title={`${row.revision.byteSize} bytes`}>{fileSize(row.revision.byteSize)}</span>
    {row.file.state === 'ready' ? <IconButton label={`Download ${name}`} size="sm" variant="ghost"
      disabled={download.isPending} onClick={() => {
        const signal = controller.current?.signal
        if (signal && !download.isPending) download.mutate(signal)
      }}><Download size={16} aria-hidden="true" /></IconButton>
      : <span className="project-file-pending">{row.file.state === 'pending' ? 'Upload pending' : 'Unavailable'}</span>}
    <IconButton label={`Remove ${name}`} size="sm" variant="ghost" onClick={onRemove}>
      <Trash2 size={16} aria-hidden="true" />
    </IconButton>
    {download.isError && <p className="project-file-error" role="alert">Download failed.</p>}
  </li>
}

function ProjectFileRemoval({ workspaceId, row, onClose, returnFocusRef }: ProjectFilesSectionProps & {
  row: FileRow; onClose: () => void; returnFocusRef: RefObject<HTMLButtonElement | null>
}) {
  const mutation = useProjectFileRemove(workspaceId)
  const attempt = useRef(new CommandAttempt<Omit<ProjectFileRemoveInput, 'commandId'>>())
  const inFlight = useRef(false)
  const cancel = useRef<HTMLButtonElement>(null)
  const locked = mutation.isPending || attempt.current.unresolved
  const close = () => { if (!locked) onClose() }
  const remove = async () => {
    if (inFlight.current) return
    inFlight.current = true
    const generation = sessionGeneration()
    try {
      await mutation.mutateAsync({ ...attempt.current.input({ workspaceId, row }), generation })
      assertSession(generation)
      attempt.current.succeeded()
      onClose()
    } catch (error) {
      attempt.current.failed(error)
    } finally { inFlight.current = false }
  }
  return <Dialog open title="Remove file?" size="sm" role="alertdialog" busy={locked}
    initialFocusRef={cancel} returnFocusRef={returnFocusRef} className="project-files-confirm"
    onOpenChange={(open) => { if (!open) close() }}
    footer={<>
      <Button ref={cancel} size="sm" disabled={locked} onClick={close}>Cancel</Button>
      <Button size="sm" variant="danger" disabled={mutation.isPending} onClick={() => { void remove() }}>
        {mutation.isPending ? 'Removing…' : mutation.isError ? 'Retry removal' : 'Remove'}
      </Button>
    </>}>
    <p className="project-files-confirm-name">{row.revision.filename}</p>
    {mutation.isError && <p className="project-files-message" role="alert">Couldn’t remove file.</p>}
  </Dialog>
}
