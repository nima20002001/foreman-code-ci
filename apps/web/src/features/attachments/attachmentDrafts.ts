import { type Mutation, type QueryClient } from '@tanstack/react-query'
import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  MAX_MESSAGE_ATTACHMENTS, MessageAttachmentRefsSchema, TemporaryFileScopeSchema, fileStateAt,
  type File as FileMetadata, type FileMediaType, type FileWithRevision, type MessageAttachmentRef, type TemporaryFileScope,
} from '@foreman-code/contracts/files'
import { assertSession, sessionGeneration, sessionIsSwitching, SessionChangedError } from '../../shared/api/sessionBoundary'
import { sessionControllerSignal } from '../../shared/api/sessionController'
import { attachmentDraftKey, inspectAttachment, type SelectionIssue } from './attachmentFiles'
import { attachmentLifecycleQueryKey, readAttachmentLifecycle } from './attachmentLifecycle'
import { parseAttachmentUpload, type AttachmentClient, type AttachmentProgress, type AttachmentUploadInput } from './attachmentClient'

export interface AttachmentSelection {
  id: string
  requestId: string
  file: File
  filename: string
  mediaType?: FileMediaType
  issue?: SelectionIssue
}
export interface AttachmentDraft {
  scope: TemporaryFileScope
  selections: readonly AttachmentSelection[]
  pickerIssue?: string
}
export interface AttachmentDraftState {
  available: boolean
  drafts: Readonly<Record<string, AttachmentDraft>>
}
export interface UploadVariables {
  draftKey: string
  selectionId: string
  input: AttachmentUploadInput
}
export type AttachmentProgressMap = Readonly<Record<string, AttachmentProgress>>
export interface AttachmentSendSnapshot {
  readonly attachments: readonly MessageAttachmentRef[]
}
interface SnapshotPins {
  draftKey: string
  pins: readonly { selectionId: string; fileId: string; revisionId: string }[]
}
interface ActiveUpload {
  controller: AbortController
  mutation: Mutation<FileWithRevision, Error, UploadVariables>
}

/**
 * Non-persisted File selections live in Zustand. All remote data, errors and
 * request lifecycle live in TanStack mutations, not copied into the draft store.
 * Progress-only telemetry lives in Query cache because mutation state has no
 * progress field. Both caches are explicitly released with the owning draft.
 */
export function createAttachmentDrafts(queryClient: QueryClient, client: AttachmentClient) {
  const id = crypto.randomUUID()
  const cachePrefix = ['chat-attachments', id] as const
  const uploadKey = [...cachePrefix, 'upload'] as const
  const progressKey = (key: string) => [...cachePrefix, 'progress', key] as const
  const lifecyclePrefix = [...attachmentLifecycleQueryKey, id] as const
  const lifecycleKey = (key: string, selectionId: string) => [...lifecyclePrefix, key, selectionId] as const
  const generation = sessionGeneration()
  const boundarySignal = sessionControllerSignal()
  const store = createStore<AttachmentDraftState>(() => ({ available: !sessionIsSwitching(), drafts: {} }))
  const active = new Map<string, ActiveUpload>()
  let disposed = false
  let mounts = 0
  let lifetime = 0

  function assertAvailable() {
    assertSession(generation)
    if (disposed || boundarySignal.aborted || !store.getState().available || sessionIsSwitching()) throw new SessionChangedError()
  }

  function lifecycleOptions(key: string, selectionId: string, upload: FileWithRevision) {
    return {
      queryKey: lifecycleKey(key, selectionId),
      initialData: upload.file,
      initialDataUpdatedAt: Date.parse(upload.file.createdAt),
      staleTime: Infinity, gcTime: Infinity, retry: false as const,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        assertAvailable()
        const scope = upload.file.scope
        if (scope.kind !== 'temporary' || attachmentDraftKey(scope) !== key) throw new SessionChangedError()
        const file = await readAttachmentLifecycle(scope, upload.file, AbortSignal.any([signal, boundarySignal]))
        assertAvailable()
        return file
      },
    }
  }

  // Recheck the elapsed deadline once, including drafts reopened after it passed.
  // A server-confirmed tombstone is never locally extended or re-uploaded.
  function refreshExpired(key: string, selectionId: string, upload: FileWithRevision) {
    if (!selected(key, selectionId) || !store.getState().available) return
    const state = queryClient.getQueryState<FileMetadata>(lifecycleKey(key, selectionId))
    const file = state?.data ?? upload.file
    if (file.state !== 'ready' || !('expiresAt' in file) || Date.parse(file.expiresAt) > Date.now()
      || (state?.dataUpdatedAt ?? 0) >= Date.parse(file.expiresAt) || state?.status === 'error') return
    void queryClient.fetchQuery({ ...lifecycleOptions(key, selectionId, upload), staleTime: 0 }).catch(() => undefined)
  }

  function selected(key: string, selectionId: string): AttachmentSelection | undefined {
    return store.getState().drafts[key]?.selections.find((selection) => selection.id === selectionId)
  }

  const clearProgress = (key: string, selectionId: string) =>
    clearAttachmentProgress(queryClient, progressKey(key), selectionId)

  function start(key: string, selection: AttachmentSelection) {
    assertAvailable()
    const draft = store.getState().drafts[key]
    if (!draft || !selection.mediaType || selection.issue) return
    const old = active.get(selection.id)
    if (old?.mutation.state.status === 'pending' || old?.mutation.state.status === 'success') return
    if (old) {
      old.controller.abort()
      queryClient.getMutationCache().remove(old.mutation)
    }
    clearProgress(key, selection.id)
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, boundarySignal])
    const input: AttachmentUploadInput = {
      requestId: selection.requestId, scope: draft.scope, file: selection.file,
      filename: selection.filename, mediaType: selection.mediaType, signal,
      onProgress(progress) {
        if (signal.aborted || !selected(key, selection.id) || active.get(selection.id)?.controller !== controller) return
        const percent = progress.percent === null || !Number.isFinite(progress.percent)
          ? null : Math.min(100, Math.max(0, Math.floor(progress.percent)))
        queryClient.setQueryData<AttachmentProgressMap>(progressKey(key), (previous) => ({
          ...previous, [selection.id]: { phase: progress.phase, percent },
        }))
      },
    }
    const mutation = queryClient.getMutationCache().build<FileWithRevision, Error, UploadVariables, unknown>(queryClient, {
      mutationKey: uploadKey,
      gcTime: Infinity,
      retry: false,
      networkMode: 'always',
      mutationFn: async (variables) => {
        const result = await client.upload(variables.input)
        assertAvailable()
        signal.throwIfAborted()
        if (!selected(key, selection.id)) throw new DOMException('Attachment removed.', 'AbortError')
        return parseAttachmentUpload(variables.input, result)
      },
    })
    active.set(selection.id, { controller, mutation })
    // Mutation state, including failures, is the readback. No unhandled rejection.
    void mutation.execute({ draftKey: key, selectionId: selection.id, input }).catch(() => undefined)
  }

  function add(scopeInput: TemporaryFileScope, files: readonly File[]) {
    assertAvailable()
    if (files.length === 0) return
    const scope = TemporaryFileScopeSchema.parse(scopeInput)
    const key = attachmentDraftKey(scope)
    const current = store.getState().drafts[key]?.selections ?? []
    const capacity = Math.max(0, MAX_MESSAGE_ATTACHMENTS - current.length)
    const additions: AttachmentSelection[] = files.slice(0, capacity).map((file) => {
      const inspected = inspectAttachment(file)
      return {
        id: crypto.randomUUID(), requestId: crypto.randomUUID(), file,
        ...(inspected.ok ? { filename: inspected.filename, mediaType: inspected.mediaType }
          : { filename: file.name, issue: inspected.issue }),
      }
    })
    store.setState((state) => ({ drafts: { ...state.drafts, [key]: {
      scope, selections: [...current, ...additions],
      pickerIssue: files.length > capacity ? `Up to ${MAX_MESSAGE_ATTACHMENTS} files` : undefined,
    } } }))
    for (const selection of additions) start(key, selection)
  }

  function forget(key: string, selectionId: string, cancel: boolean) {
    const draft = store.getState().drafts[key]
    const selection = selected(key, selectionId)
    if (!draft || !selection) return
    // Fence local membership before aborting: synchronous/late callbacks cannot resurrect it.
    const selections = draft.selections.filter((entry) => entry.id !== selectionId)
    store.setState((state) => {
      const drafts = { ...state.drafts }
      if (selections.length) drafts[key] = { ...draft, selections, pickerIssue: undefined }
      else delete drafts[key]
      return { drafts }
    })
    const running = active.get(selectionId)
    active.delete(selectionId)
    running?.controller.abort()
    if (running) queryClient.getMutationCache().remove(running.mutation)
    queryClient.removeQueries({ queryKey: lifecycleKey(key, selectionId), exact: true })
    clearProgress(key, selectionId)
    if (!selections.length) queryClient.removeQueries({ queryKey: progressKey(key), exact: true })
    if (cancel && running && !disposed && !boundarySignal.aborted && sessionGeneration() === generation && !sessionIsSwitching()) {
      // Best-effort remote cleanup, NOT proof of remote deletion. Failures remain
      // inspectable in MutationCache. FIL-03 must fence cancel/upload races by requestId.
      const cancelInput = { scope: draft.scope, requestId: selection.requestId }
      const cleanup = queryClient.getMutationCache().build<void, Error, void, unknown>(queryClient, {
        mutationKey: [...cachePrefix, 'cancel', selection.requestId], gcTime: 60_000,
        retry: false, networkMode: 'always',
        mutationFn: () => client.cancel(cancelInput),
      })
      void cleanup.execute(undefined).catch(() => undefined)
    }
  }

  const { prepareSend, acknowledgeSent } = createAttachmentSendSnapshots({ queryClient, store, active,
    assertAvailable, lifecycleKey, forget, boundarySignal, generation, isDisposed: () => disposed })

  function reset() {
    store.setState({ available: false, drafts: {} })
    for (const { controller, mutation } of active.values()) {
      controller.abort()
      queryClient.getMutationCache().remove(mutation)
    }
    active.clear()
    queryClient.removeQueries({ queryKey: cachePrefix })
    queryClient.removeQueries({ queryKey: lifecyclePrefix })
    for (const mutation of queryClient.getMutationCache().findAll({ mutationKey: cachePrefix })) {
      queryClient.getMutationCache().remove(mutation)
    }
  }

  function retain() {
    ++mounts
    ++lifetime
    boundarySignal.addEventListener('abort', reset)
    if (boundarySignal.aborted || sessionGeneration() !== generation) reset()
    return () => {
      --mounts
      boundarySignal.removeEventListener('abort', reset)
      const ticket = ++lifetime
      // StrictMode's setup/cleanup/setup must not destroy an otherwise live manager.
      queueMicrotask(() => {
        if (mounts !== 0 || ticket !== lifetime) return
        disposed = true
        reset()
      })
    }
  }

  return {
    store, uploadKey, progressKey, lifecycleOptions, refreshExpired, retain, add, prepareSend, acknowledgeSent,
    remove: (key: string, selectionId: string) => forget(key, selectionId, true),
    retry(key: string, selectionId: string) {
      const selection = selected(key, selectionId)
      const upload = active.get(selectionId)?.mutation.state
      if (selection && upload?.status === 'success' && upload.data) {
        void queryClient.fetchQuery({ ...lifecycleOptions(key, selectionId, upload.data), staleTime: 0 }).catch(() => undefined)
      } else if (selection) start(key, selection)
    },
  }
}

export type AttachmentDrafts = ReturnType<typeof createAttachmentDrafts>

function createAttachmentSendSnapshots({ queryClient, store, active, assertAvailable, lifecycleKey,
  forget, boundarySignal, generation, isDisposed }: {
  queryClient: QueryClient
  store: StoreApi<AttachmentDraftState>
  active: Map<string, ActiveUpload>
  assertAvailable: () => void
  lifecycleKey: (key: string, selectionId: string) => readonly string[]
  forget: (key: string, selectionId: string, cancel: boolean) => void
  boundarySignal: AbortSignal
  generation: number
  isDisposed: () => boolean
}) {
  const snapshots = new WeakMap<AttachmentSendSnapshot, SnapshotPins>()
  function prepareSend(key: string): AttachmentSendSnapshot | null {
    assertAvailable()
    const selections = store.getState().drafts[key]?.selections ?? []
    const pins: SnapshotPins['pins'][number][] = []
    for (const selection of selections) {
      const state = active.get(selection.id)?.mutation.state
      if (selection.issue || state?.status !== 'success' || !state.data) return null
      const file = queryClient.getQueryData<FileMetadata>(lifecycleKey(key, selection.id)) ?? state.data.file
      if (fileStateAt(file, new Date().toISOString()) !== 'ready') return null
      pins.push({ selectionId: selection.id, fileId: state.data.revision.fileId, revisionId: state.data.revision.revisionId })
    }
    const parsed = MessageAttachmentRefsSchema.safeParse(pins.map(({ fileId, revisionId }) => ({ fileId, revisionId })))
    if (!parsed.success) return null
    const snapshot: AttachmentSendSnapshot = Object.freeze({
      attachments: Object.freeze(parsed.data.map((ref) => Object.freeze(ref))),
    })
    snapshots.set(snapshot, { draftKey: key, pins })
    return snapshot
  }

  function acknowledgeSent(snapshot: AttachmentSendSnapshot) {
    const saved = snapshots.get(snapshot)
    snapshots.delete(snapshot)
    if (!saved || isDisposed() || boundarySignal.aborted || sessionGeneration() !== generation) return
    for (const pin of saved.pins) {
      const revision = active.get(pin.selectionId)?.mutation.state.data?.revision
      if (revision?.fileId === pin.fileId && revision.revisionId === pin.revisionId) {
        // Only the accepted snapshot is removed. Never cancel now-sent server files.
        forget(saved.draftKey, pin.selectionId, false)
      }
    }
  }

  return { prepareSend, acknowledgeSent }
}

function clearAttachmentProgress(queryClient: QueryClient, queryKey: readonly string[], selectionId: string) {
  // Avoid creating a new cache record while disposing an already-removed draft.
  if (!queryClient.getQueryData(queryKey)) return
  queryClient.setQueryData<AttachmentProgressMap>(queryKey, (old) => {
    const next = { ...old }
    delete next[selectionId]
    return next
  })
}
