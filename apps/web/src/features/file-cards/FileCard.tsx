import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileWithRevisionSchema, fileStateAt, type FileWithRevision, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import { Button, Icon } from '../../shared/ui/nocturne'
import { assertSession, sessionGeneration, sessionIsSwitching, sessionSignal, SessionChangedError } from '../../shared/api/sessionBoundary'
import { attachmentLifecycleQueryKey, readAttachmentLifecycle } from '../attachments/attachmentLifecycle'
import type { FileCardClient } from './fileCardClient'
import { fileCardKey, fileTypeLabel, formatFileSize, isRasterImage, MAX_THUMBNAIL_BYTES } from './fileCardPresentation'
import { fileErrorStatus, saveBlob, useAborted, useEffectiveFileState, useObjectUrl, type FileCardStatus } from './fileCardResources'
import './fileCards.css'

const clientIds = new WeakMap<FileCardClient, number>()
let nextClientId = 0
function clientId(client: FileCardClient): number {
  const existing = clientIds.get(client)
  if (existing !== undefined) return existing
  const id = ++nextClientId
  clientIds.set(client, id)
  return id
}

export interface FileCardProps {
  /** Historical DTO resolved for the message's pin, not a current-head list row. */
  file: FileWithRevision
  client: FileCardClient
  /** Optional additional guard when the caller already has the message's attachment reference. */
  attachment?: MessageAttachmentRef
}

function FileGlyph({ mediaType }: { mediaType: FileWithRevision['revision']['mediaType'] }) {
  return <Icon name={isRasterImage(mediaType) ? 'eye' : mediaType === 'application/zip' ? 'folder' : 'code'} size={20} />
}

function Thumbnail({ blob, mediaType }: { blob?: Blob; mediaType: FileWithRevision['revision']['mediaType'] }) {
  const [failedBlob, setFailedBlob] = useState<Blob>()
  const url = useObjectUrl(blob === failedBlob ? undefined : blob)
  return url ? <img className="file-card__image" src={url} alt="" decoding="async"
    onError={() => setFailedBlob(blob)} /> : <FileGlyph mediaType={mediaType} />
}

const statusLabels = { pending: 'Pending', expired: 'Expired', removed: 'Removed', unavailable: 'Unavailable' } as const

function CardLayout({ file, status, graphic, action, error }: {
  file: FileWithRevision; status: FileCardStatus; graphic?: ReactNode; action?: ReactNode; error?: boolean
}) {
  const nameId = useId()
  const detailsId = useId()
  const { revision } = file
  const expiresAt = 'expiresAt' in file.file ? file.file.expiresAt : undefined
  const expiryDetails = expiresAt ? new Intl.DateTimeFormat(undefined, {
    dateStyle: 'full', timeStyle: 'long',
  }).format(new Date(expiresAt)) : undefined
  const date = expiresAt ? new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  }).format(new Date(expiresAt)) : undefined
  const details = `${fileTypeLabel(revision.mediaType)} · ${revision.byteSize.toLocaleString()} bytes · ${revision.fileId} / ${revision.revisionId}`
  return <div className="file-card" role="group" aria-labelledby={nameId} aria-describedby={detailsId} data-state={status}>
    <span className="file-card__graphic" aria-hidden="true">{graphic ?? <FileGlyph mediaType={revision.mediaType} />}</span>
    <div className="file-card__body">
      <bdi className="file-card__name" id={nameId} title={revision.filename}>{revision.filename}</bdi>
      <div className="file-card__meta" id={detailsId}>
        <span title={details}>{formatFileSize(revision.byteSize)}</span>
        {status !== 'ready' ? <span role="status" title={status === 'expired' ? expiryDetails : undefined}>{statusLabels[status]}</span> : null}
        {expiresAt ? <time dateTime={expiresAt}
          title={`Expiry: ${expiryDetails}`} aria-label={`Expires ${expiryDetails}`}>{status !== 'expired' && status !== 'removed' ? 'Expires ' : ''}{date}</time> : null}
        {error ? <span role="status">Download failed</span> : null}
        <span className="file-card__sr-only">{fileTypeLabel(revision.mediaType)}</span>
      </div>
    </div>
    {action ? <div className="file-card__action">{action}</div> : null}
  </div>
}

function ReadyFileCard({ file, client, generation }: FileCardProps & { generation: number }) {
  // View-local key avoids retaining private blobs across consumers/auth transitions. gcTime=0.
  const viewId = useId()
  const queryClient = useQueryClient()
  const { fileId, revisionId, sha256 } = file.revision
  const queryKey = useMemo(() => ['message-file-preview', clientId(client), generation, fileId, revisionId, sha256, viewId],
    [client, generation, fileId, revisionId, sha256, viewId])
  const lifecycle = useRef<{ controller: AbortController; dispose?: () => void } | null>(null)
  const download = useMutation({
    mutationKey: ['message-file-download', clientId(client), generation, file.revision.fileId, file.revision.revisionId, viewId],
    gcTime: 0, retry: false, meta: { persist: false },
    mutationFn: async () => {
      const current = lifecycle.current
      if (!current || current.controller.signal.aborted) throw new SessionChangedError()
      const blob = await client.download(file, { signal: current.controller.signal })
      // A client which ignores AbortSignal still cannot save under another pin or session.
      assertSession(generation)
      current.controller.signal.throwIfAborted()
      if (current !== lifecycle.current || sessionIsSwitching()
        || fileStateAt(file.file, new Date().toISOString()) !== 'ready') throw new SessionChangedError()
      current.dispose?.()
      current.dispose = saveBlob(blob, file.revision.filename)
      // Do not return/cache the download Blob as mutation data.
    },
  })
  const downloadTerminal = fileErrorStatus(download.error)
  const preview = useQuery({
    queryKey,
    queryFn: ({ signal }) => client.download(file, { signal }),
    enabled: !downloadTerminal && isRasterImage(file.revision.mediaType) && file.revision.byteSize <= MAX_THUMBNAIL_BYTES,
    gcTime: 0, staleTime: Infinity, retry: false,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
    meta: { persist: false },
  })
  useEffect(() => {
    if (!downloadTerminal) return
    void queryClient.cancelQueries({ queryKey, exact: true })
    queryClient.removeQueries({ queryKey, exact: true })
  }, [downloadTerminal, queryClient, queryKey])
  const terminal = downloadTerminal ?? fileErrorStatus(preview.error)
  useEffect(() => {
    const current = { controller: new AbortController() } as { controller: AbortController; dispose?: () => void }
    lifecycle.current = current
    return () => {
      if (lifecycle.current === current) lifecycle.current = null
      current.controller.abort()
      current.dispose?.()
    }
  }, [client, generation, terminal])
  if (terminal) return <CardLayout file={file} status={terminal} />
  return <CardLayout file={file} status="ready" error={download.isError && download.error?.name !== 'AbortError'}
    graphic={<Thumbnail blob={preview.data} mediaType={file.revision.mediaType} />}
    action={<Button size="sm" variant="ghost" className="file-card__download" loading={download.isPending}
      loadingLabel="Downloading" aria-label={`Download ${file.revision.filename}`}
      title={`Download ${file.revision.filename} (${fileTypeLabel(file.revision.mediaType)})`}
      onClick={() => { if (!download.isPending) download.mutate() }}>Download</Button>} />
}

function ValidatedFileCard({ file, client }: FileCardProps) {
  // Bind this mounted view to its original session, not the next principal's new signal.
  const [session] = useState(() => ({ generation: sessionGeneration(), signal: sessionSignal() }))
  const aborted = useAborted(session.signal)
  const unavailable = aborted || sessionIsSwitching() || session.generation !== sessionGeneration()
  const viewId = useId()
  const scope = file.file.scope
  const { data: metadata, dataUpdatedAt, errorUpdatedAt, isFetching, refetch } = useQuery({
    // Share retention-save invalidation with drafts, not their cache or mutable discovery heads.
    queryKey: [...attachmentLifecycleQueryKey, 'message', clientId(client), session.generation, viewId],
    initialData: file.file, initialDataUpdatedAt: Date.parse(file.file.createdAt),
    staleTime: Infinity, gcTime: 0, retry: false, meta: { persist: false },
    enabled: (query) => !unavailable && scope.kind === 'temporary'
      && (query.state.data ?? file.file).state === 'ready',
    queryFn: async ({ signal }) => {
      assertSession(session.generation)
      if (scope.kind !== 'temporary') throw new SessionChangedError()
      const requestSignal = AbortSignal.any([signal, session.signal])
      requestSignal.throwIfAborted()
      const current = await readAttachmentLifecycle(scope, file.file, requestSignal)
      assertSession(session.generation)
      requestSignal.throwIfAborted()
      return current
    },
  })
  const state = useEffectiveFileState(metadata)
  useEffect(() => {
    // History pages need not refetch when retention changes in MCP/another tab. Check each
    // elapsed deadline once; a failed check must not spin, nor may a tombstone be revived.
    if (!unavailable && !isFetching && metadata.state === 'ready' && state === 'expired'
      && 'expiresAt' in metadata && Math.max(dataUpdatedAt, errorUpdatedAt) < Date.parse(metadata.expiresAt)) {
      void refetch()
    }
  }, [unavailable, isFetching, metadata, state, dataUpdatedAt, errorUpdatedAt, refetch])
  // Refresh only lifecycle metadata. The filename, digest and downloaded revision stay pinned.
  const current = { ...file, file: metadata }
  return state === 'ready' && !unavailable
    ? <ReadyFileCard key={'expiresAt' in metadata ? metadata.expiresAt : undefined}
      file={current} client={client} generation={session.generation} />
    : <CardLayout file={current} status={unavailable ? 'unavailable' : state} />
}

export function FileCard({ file, client, attachment }: FileCardProps) {
  const parsed = FileWithRevisionSchema.safeParse(file)
  if (!parsed.success || attachment && fileCardKey(attachment) !== fileCardKey(parsed.data.revision)) {
    return <span className="file-card__unavailable" role="status">Unavailable</span>
  }
  // Reset byte resources for a real DTO lifecycle/revision change, not a newly allocated DTO.
  // currentRevisionId is intentionally excluded: a new head does not replace this pinned card.
  const { currentRevisionId: _head, ...identity } = parsed.data.file
  void _head
  const key = JSON.stringify([identity, parsed.data.revision])
  return <ValidatedFileCard key={key} file={parsed.data} client={client} />
}
