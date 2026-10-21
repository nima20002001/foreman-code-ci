import { z } from 'zod'
import { ApiErrorResponseSchema } from '@foreman-code/contracts'
import {
  FileWithRevisionSchema, TemporaryFileScopeSchema, fileStateAt,
  type FileMediaType, type FileWithRevision, type TemporaryFileScope,
} from '@foreman-code/contracts/files'
import { apiClient, ApiError } from '../../shared/api/client'
import { assertSession, sessionGeneration, sessionIsSwitching, sessionSignal, SessionChangedError } from '../../shared/api/sessionBoundary'
import { attachmentDraftKey, inspectAttachment } from './attachmentFiles'

export interface AttachmentProgress { phase: 'uploading' | 'finalizing'; percent: number | null }
export interface AttachmentUploadInput {
  requestId: string
  scope: TemporaryFileScope
  file: File
  filename: string
  mediaType: FileMediaType
  signal: AbortSignal
  onProgress: (progress: AttachmentProgress) => void
}
export interface AttachmentCancelInput { requestId: string; scope: TemporaryFileScope }
export interface AttachmentClient {
  /** Must resolve only after durable finalization, not merely after the bytes arrive. */
  upload(input: AttachmentUploadInput): Promise<FileWithRevision>
  /** Cancel an unsent allocation by its original request identity; never delete a sent file. */
  cancel(input: AttachmentCancelInput): Promise<void>
}

function invalidResponse(): ApiError {
  return new ApiError({ code: 'INVALID_RESPONSE', message: 'The upload response does not match this attachment.' })
}

/** Apply even to injected clients: never admit a foreign scope or silently follow a revision head. */
export function parseAttachmentUpload(input: AttachmentUploadInput, value: unknown, ready = true): FileWithRevision {
  const parsed = FileWithRevisionSchema.safeParse(value)
  if (!parsed.success) throw invalidResponse()
  const { file, revision } = parsed.data
  if (file.scope.kind !== 'temporary' || attachmentDraftKey(file.scope) !== attachmentDraftKey(input.scope)
    || file.currentRevisionId !== revision.revisionId || revision.filename !== input.filename
    || revision.mediaType !== input.mediaType || revision.byteSize !== input.file.size || revision.origin !== 'upload') throw invalidResponse()
  const state = fileStateAt(file, new Date().toISOString())
  if (ready ? state !== 'ready' : state !== 'pending' && state !== 'ready') throw invalidResponse()
  return parsed.data
}

const UploadResultSchema = z.object({ value: FileWithRevisionSchema, replayed: z.boolean() })

function uploadRoot(scope: TemporaryFileScope): string {
  const chat = TemporaryFileScopeSchema.parse(scope).chat
  const conversation = encodeURIComponent(chat.conversationId)
  return chat.kind === 'operator' ? `/api/operator/conversations/${conversation}/files`
    : `/api/workspaces/${encodeURIComponent(chat.workspaceId)}/agent-chat/conversations/${conversation}/files`
}

function fileBytes(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

/** JSON commands use apiClient; XHR carries raw bytes and reports upload progress. */
export function createAttachmentHttpClient(): AttachmentClient {
  return {
    async upload(input) {
      const generation = sessionGeneration()
      if (sessionIsSwitching()) throw new SessionChangedError()
      const signal = AbortSignal.any([input.signal, sessionSignal()])
      signal.throwIfAborted()
      const inspected = inspectAttachment(input.file)
      if (!inspected.ok || inspected.filename !== input.filename || inspected.mediaType !== input.mediaType) {
        throw new ApiError({ code: 'INVALID_REQUEST', message: 'The selected file is not an allowed attachment.' })
      }
      const root = uploadRoot(input.scope)
      const digest = await crypto.subtle.digest('SHA-256', await fileBytes(input.file))
      assertSession(generation)
      signal.throwIfAborted()
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      const path = `${root}/uploads/${encodeURIComponent(input.requestId)}`
      const allocated = await apiClient.request(`${root}/uploads`, UploadResultSchema, {
        method: 'POST', signal,
        body: { requestId: input.requestId, filename: input.filename, mediaType: input.mediaType, byteSize: input.file.size, sha256 },
      })
      assertSession(generation)
      signal.throwIfAborted()
      const allocation = parseAttachmentUpload(input, allocated.value, false)
      if (allocation.revision.sha256 !== sha256) throw invalidResponse()
      const uploaded = await uploadBytes(path, input.file, signal, input.onProgress)
      assertSession(generation)
      signal.throwIfAborted()
      const staged = parseAttachmentUpload(input, UploadResultSchema.parse(uploaded).value, false)
      if (staged.revision.fileId !== allocation.revision.fileId || staged.revision.revisionId !== allocation.revision.revisionId
        || staged.revision.sha256 !== sha256) throw invalidResponse()
      if (staged.file.state === 'ready') return staged
      input.onProgress({ phase: 'finalizing', percent: 100 })
      const finalized = await apiClient.request(`${path}/finalize`, UploadResultSchema, { method: 'POST', signal, body: {} })
      assertSession(generation)
      signal.throwIfAborted()
      const result = parseAttachmentUpload(input, finalized.value)
      if (result.revision.fileId !== staged.revision.fileId || result.revision.revisionId !== staged.revision.revisionId) throw invalidResponse()
      return result
    },
    async cancel(input) {
      await apiClient.request(`${uploadRoot(input.scope)}/uploads/${encodeURIComponent(input.requestId)}`, UploadResultSchema, {
        method: 'DELETE', body: {},
      })
    },
  }
}

function uploadBytes(path: string, body: File, signal: AbortSignal,
  onProgress: AttachmentUploadInput['onProgress']): Promise<unknown> {
  signal.throwIfAborted()
  const generation = sessionGeneration()
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null
      xhr.upload.onprogress = null
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const abort = () => {
      finish(new DOMException('Attachment upload canceled.', 'AbortError'))
      xhr.abort()
    }
    xhr.open('PUT', new URL(path, globalThis.location?.origin ?? 'http://localhost').toString())
    // XHR sends same-origin cookies without enabling cross-origin credentials.
    xhr.withCredentials = false
    xhr.timeout = 120_000
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (!settled && !signal.aborted) onProgress({
        phase: 'uploading',
        percent: event.lengthComputable && event.total > 0 ? Math.min(100, Math.max(0, Math.floor(event.loaded / event.total * 100))) : null,
      })
    }
    xhr.onerror = () => finish(new ApiError({ code: 'NETWORK_ERROR', message: 'The attachment could not be uploaded.' }))
    xhr.ontimeout = () => finish(new ApiError({ code: 'UPLOAD_TIMEOUT', message: 'The attachment upload timed out. Retry to check the same upload.' }))
    xhr.onabort = () => finish(new DOMException('Attachment upload canceled.', 'AbortError'))
    xhr.onload = () => {
      try {
        assertSession(generation)
        signal.throwIfAborted()
        let payload: unknown
        try { payload = JSON.parse(xhr.responseText) } catch { payload = undefined }
        if (xhr.status < 200 || xhr.status >= 300) {
          const parsed = ApiErrorResponseSchema.safeParse(payload)
          throw new ApiError(parsed.success ? parsed.data.error : { code: 'HTTP_ERROR', message: 'The attachment could not be uploaded.' }, xhr.status)
        }
        finish(undefined, payload)
      } catch (error) { finish(error) }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try {
      onProgress({ phase: 'uploading', percent: null })
      xhr.send(body)
    } catch (error) { finish(error) }
  })
}
