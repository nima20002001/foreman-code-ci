import { installationHeaders, reloadChangedInstallation } from '../../shared/api/sessionBoundary'
import { ApiErrorResponseSchema } from '@foreman-code/contracts'
import {
  FileReferenceMutationResultSchema, FilePageSchema, FileWithRevisionSchema, MessageAttachmentRefSchema,
  PermanentFileScopeSchema, WorkflowReferenceFileScopeSchema,
  type FilePage, type FileWithRevision, type MessageAttachmentRef,
  type PermanentFileScope, type WorkflowReferenceFileScope,
} from '@foreman-code/contracts/files'
import { apiClient, ApiError } from '../../shared/api/client'
import {
  assertSession, sessionGeneration, sessionIsSwitching, sessionSignal, SessionChangedError,
} from '../../shared/api/sessionBoundary'
import { inspectAttachment } from '../attachments/attachmentFiles'
import { referenceFilesRoot, referenceScopeKey } from './workflowFilesModel'

export interface ReferenceUpload {
  scope: WorkflowReferenceFileScope
  requestId: string
  file: File
  signal: AbortSignal
}
export interface ReferenceRemoval {
  scope: WorkflowReferenceFileScope
  ref: MessageAttachmentRef
  commandId: string
  signal: AbortSignal
}
export interface ReferenceDownload {
  scope: PermanentFileScope
  row: FileWithRevision
  signal: AbortSignal
}
export interface WorkflowFilesClient {
  list(scope: PermanentFileScope, cursor: string | undefined, signal: AbortSignal): Promise<FilePage>
  upload(input: ReferenceUpload): Promise<FileWithRevision>
  remove(input: ReferenceRemoval): Promise<FileWithRevision>
  download(input: ReferenceDownload): Promise<Blob>
}

function invalidResponse(): ApiError {
  return new ApiError({ code: 'INVALID_RESPONSE', message: 'The file response does not match the requested reference.' })
}

function parseRow(value: unknown, scope: PermanentFileScope, ref?: MessageAttachmentRef): FileWithRevision {
  const parsed = FileWithRevisionSchema.safeParse(value)
  if (!parsed.success) throw invalidResponse()
  const row = parsed.data
  if (row.file.scope.kind === 'temporary' || row.file.scope.kind==='job_execution' || referenceScopeKey(row.file.scope) !== referenceScopeKey(scope)
    || row.file.currentRevisionId !== row.revision.revisionId
    || (ref && (row.file.fileId !== ref.fileId || row.revision.revisionId !== ref.revisionId))) throw invalidResponse()
  return row
}

function resultRow(value: unknown, scope: PermanentFileScope, ref?: MessageAttachmentRef) {
  const parsed = FileReferenceMutationResultSchema.safeParse(value)
  if (!parsed.success) throw invalidResponse()
  return parseRow(parsed.data.value, scope, ref)
}

function requestContext(signal: AbortSignal) {
  if (sessionIsSwitching()) throw new SessionChangedError()
  const generation = sessionGeneration()
  const combined = AbortSignal.any([signal, sessionSignal(), AbortSignal.timeout(120_000)])
  const check = () => { assertSession(generation); combined.throwIfAborted() }
  check()
  return { signal: combined, check }
}

function fileBytes(file: File, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const abort = () => { reader.abort(); reject(signal.reason) }
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.onabort = () => reject(signal.reason ?? new DOMException('Upload canceled.', 'AbortError'))
    reader.onloadend = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    reader.readAsArrayBuffer(file)
  })
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** apiClient is JSON-only. Raw PUT/download stay inside this same-origin,
 * session-fenced feature boundary (as in attachmentClient), interceptable by MSW. */
async function rawRequest(path: string, context: ReturnType<typeof requestContext>, init: RequestInit): Promise<Response> {
  context.check()
  let response: Response
  try {
    response = await fetch(new URL(path, globalThis.location?.origin ?? 'http://localhost'), {
      ...init, headers: installationHeaders(init.headers), credentials: 'omit', cache: 'no-store', redirect: 'error', signal: context.signal,
    })
  } catch (error) {
    context.check()
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new ApiError({ code: 'NETWORK_ERROR', message: 'The file request could not be completed.' }, undefined, { cause: error })
  }
  context.check()
  if (!response.ok) {
    const parsed = ApiErrorResponseSchema.safeParse(await response.json().catch(() => /* ignore: a body that is not JSON fails the schema */ undefined))
    context.check()
    if (parsed.success) reloadChangedInstallation(parsed.data.error.code)
    throw new ApiError(parsed.success ? parsed.data.error
      : { code: 'HTTP_ERROR', message: 'The file request failed.' }, response.status)
  }
  return response
}

function pinnedPath(scope: PermanentFileScope, input: MessageAttachmentRef): string {
  const ref = MessageAttachmentRefSchema.parse(input)
  return `${referenceFilesRoot(scope)}/${encodeURIComponent(ref.fileId)}/revisions/${encodeURIComponent(ref.revisionId)}`
}

export function createWorkflowFilesHttpClient(): WorkflowFilesClient {
  return {
    async list(input, cursor, signal) {
      const scope = PermanentFileScopeSchema.parse(input)
      const query = new URLSearchParams({ limit: '25' })
      if (cursor) query.set('cursor', cursor)
      const page = await apiClient.request(`${referenceFilesRoot(scope)}?${query}`, FilePageSchema, { signal })
      for (const row of page.items) parseRow(row, scope)
      if (cursor && page.pageInfo.nextCursor === cursor) throw invalidResponse()
      return page
    },
    async upload(input) {
      // Even a cast/misbehaving caller cannot use this Board client to write the inherited group.
      const scope = WorkflowReferenceFileScopeSchema.parse(input.scope)
      const context = requestContext(input.signal)
      const inspected = inspectAttachment(input.file)
      if (!inspected.ok) throw new ApiError({ code: 'INVALID_REQUEST', message: inspected.issue.message })
      const bytes = await fileBytes(input.file, context.signal)
      context.check()
      const hash = await sha256(bytes)
      context.check()
      const metadata = { requestId: input.requestId, filename: inspected.filename, mediaType: inspected.mediaType,
        byteSize: input.file.size, sha256: hash }
      const root = referenceFilesRoot(scope)
      const path = `${root}/uploads/${encodeURIComponent(input.requestId)}`
      function validate(value: unknown, ref?: MessageAttachmentRef) {
        const row = resultRow(value, scope, ref)
        if ((row.file.state !== 'pending' && row.file.state !== 'ready') || row.revision.origin !== 'upload'
          || row.revision.filename !== metadata.filename || row.revision.mediaType !== metadata.mediaType
          || row.revision.byteSize !== metadata.byteSize || row.revision.sha256 !== hash) throw invalidResponse()
        return row
      }
      const allocation = await apiClient.request(`${root}/uploads`, FileReferenceMutationResultSchema,
        { method: 'POST', body: metadata, signal: context.signal })
      context.check()
      const allocated = validate(allocation)
      // A lost finalize acknowledgement can replay an already-ready immutable allocation.
      if (allocated.file.state === 'ready') return allocated
      const ref = { fileId: allocated.file.fileId, revisionId: allocated.revision.revisionId }
      const response = await rawRequest(path, context, { method: 'PUT', body: bytes,
        headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream' } })
      const payload: unknown = await response.json().catch(() => /* ignore: a body that is not JSON fails validation below */ undefined)
      context.check()
      const staged = validate(payload, ref)
      if (staged.file.state === 'ready') return staged
      const finalized = await apiClient.request(`${path}/finalize`, FileReferenceMutationResultSchema,
        { method: 'POST', body: {}, signal: context.signal })
      context.check()
      const ready = validate(finalized, ref)
      if (ready.file.state !== 'ready') throw invalidResponse()
      return ready
    },
    async remove(input) {
      const scope = WorkflowReferenceFileScopeSchema.parse(input.scope)
      const context = requestContext(input.signal)
      const result = await apiClient.request(pinnedPath(scope, input.ref), FileReferenceMutationResultSchema,
        { method: 'DELETE', body: { commandId: input.commandId }, signal: context.signal })
      context.check()
      const row = resultRow(result, scope, input.ref)
      if (row.file.state !== 'removed') throw invalidResponse()
      return row
    },
    async download(input) {
      const scope = PermanentFileScopeSchema.parse(input.scope)
      const row = parseRow(input.row, scope)
      if (row.file.state !== 'ready') throw new ApiError({ code: 'FILE_UNAVAILABLE', message: 'This file is not ready.' })
      const context = requestContext(input.signal)
      const response = await rawRequest(`${pinnedPath(scope, { fileId: row.file.fileId, revisionId: row.revision.revisionId })}/content`, context,
        { headers: { Accept: row.revision.mediaType } })
      const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()
      const length = response.headers.get('Content-Length')
      if (type !== row.revision.mediaType || (length !== null && Number(length) !== row.revision.byteSize)) {
        await response.body?.cancel()
        throw invalidResponse()
      }
      if (!response.body) throw invalidResponse()
      // The shared metadata bounds allocation to 25 MiB. Do not buffer an unbounded blob().
      const bytes = new Uint8Array(row.revision.byteSize)
      const reader = response.body.getReader()
      let received = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          context.check()
          if (done) break
          if (received + value.byteLength > bytes.byteLength) throw invalidResponse()
          bytes.set(value, received)
          received += value.byteLength
        }
      } finally {
        await reader.cancel().catch(() => /* ignore: the stream is already closed or failed */ undefined)
        reader.releaseLock()
      }
      if (received !== bytes.byteLength || await sha256(bytes.buffer) !== row.revision.sha256) throw invalidResponse()
      context.check()
      return new Blob([bytes], { type: row.revision.mediaType })
    },
  }
}

/** Never navigate to, preview, or interpret downloaded content. */
export function saveReferenceDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  try {
    anchor.href = url
    anchor.download = filename
    anchor.hidden = true
    document.body.append(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
