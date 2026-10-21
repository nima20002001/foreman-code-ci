import { ApiErrorResponseSchema } from '@foreman-code/contracts'
import { FileWithRevisionSchema, MAX_FILE_BYTES, fileStateAt, type FileWithRevision, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import { ApiError } from '../../shared/api/client'
import { assertSession, sessionGeneration, sessionIsSwitching, sessionSignal, SessionChangedError } from '../../shared/api/sessionBoundary'
import { hasRasterSignature, isRasterImage } from './fileCardPresentation'

export interface FileCardClient {
  /** Implementations must return only these pinned bytes, never a latest-revision fallback. */
  download(file: FileWithRevision, options: { signal: AbortSignal }): Promise<Blob>
}

export interface FileCardHttpPaths {
  /** Same-origin operator or agent conversation file route, with pinned ID segments. */
  download: string
}

function failure(code: string, message: string, status = 0): ApiError {
  return new ApiError({ code, message }, status)
}

export function fileDownloadPath(template: string, pin: MessageAttachmentRef): string {
  const segments = template.split('/')
  if (!/^\/api\/[A-Za-z0-9_{}%/-]+$/.test(template)
    || !/^\/api\/(?:operator\/conversations\/[^/]+|workspaces\/[^/]+\/agent-chat\/conversations\/[^/]+)\/files\/\{fileId\}\/revisions\/\{revisionId\}\/content$/.test(template)
    || segments.filter((part) => part === '{fileId}').length !== 1
    || segments.filter((part) => part === '{revisionId}').length !== 1
    || segments.some((part) => /[{}]/.test(part) && part !== '{fileId}' && part !== '{revisionId}')) {
    throw failure('INVALID_REQUEST', 'Provide an operator or agent conversation file content path.')
  }
  const encode = (value: string) => {
    // URL parsers normalize dot-only segments even when percent-encoded.
    if (!value || value === '.' || value === '..') throw failure('INVALID_REQUEST', 'Invalid file identity.')
    return encodeURIComponent(value)
  }
  return template.replace('{fileId}', encode(pin.fileId)).replace('{revisionId}', encode(pin.revisionId))
}

function assertReady(file: FileWithRevision): void {
  const state = fileStateAt(file.file, new Date().toISOString())
  if (state !== 'ready') throw failure(state === 'pending' ? 'FILE_NOT_READY' : `FILE_${state.toUpperCase()}`, 'File is not available for download.')
}

/** A bounded response reader, including when Content-Length is absent or dishonest. */
async function readBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const announced = response.headers.get('Content-Length')
  if (announced !== null && (!/^\d+$/.test(announced) || Number(announced) > limit)) {
    // Cancellation is best effort; some streamed responses never settle its promise.
    void response.body?.cancel().catch(() => undefined)
    throw failure('INVALID_RESPONSE', 'The file response exceeds its expected size.')
  }
  if (!response.body) {
    if (limit === 0) return new Uint8Array(0)
    throw failure('INVALID_RESPONSE', 'The file response has no body.')
  }
  const reader = response.body.getReader()
  const bytes = new Uint8Array(limit)
  let length = 0
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      length += value.byteLength
      if (length > limit) {
        void reader.cancel().catch(() => undefined)
        throw failure('INVALID_RESPONSE', 'The file response exceeds its expected size.')
      }
      bytes.set(value, length - value.byteLength)
    }
    return bytes.subarray(0, length)
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

/** Binary sibling to the shared JSON-only ApiClient, following FIL-11's scoped boundary.
 * All networking is here (never in components), with the same API error and app-instance cancellation behavior.
 * Global fetch is resolved at call time so MSW intercepts the real HTTP boundary. */
export function createFileCardHttpClient(paths: FileCardHttpPaths): FileCardClient {
  fileDownloadPath(paths.download, { fileId: 'validate-file', revisionId: 'validate-revision' })
  const template = paths.download
  return {
    async download(input, { signal }) {
      const parsed = FileWithRevisionSchema.safeParse(input)
      if (!parsed.success) throw failure('INVALID_REQUEST', 'Invalid file metadata.')
      const file = parsed.data
      assertReady(file)
      const generation = sessionGeneration()
      if (sessionIsSwitching()) throw new SessionChangedError()
      const requestSignal = AbortSignal.any([signal, sessionSignal()])
      const verify = () => { assertSession(generation); requestSignal.throwIfAborted(); assertReady(file) }
      verify()
      const origin = globalThis.location?.origin ?? 'http://localhost'
      const url = new URL(fileDownloadPath(template, file.revision), origin)
      let response: Response
      try {
        response = await globalThis.fetch(url, {
          method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error',
          headers: { Accept: file.revision.mediaType }, signal: requestSignal,
        })
      } catch (error) {
        verify()
        if (error instanceof Error && error.name === 'AbortError') throw error
        throw failure('NETWORK_ERROR', 'The download could not be completed.')
      }
      verify()
      if (!response.ok) {
        // Do not buffer arbitrarily large error pages or expose raw server HTML/messages.
        let payload: unknown
        try {
          const bytes = await readBytes(response, 64 * 1024, requestSignal)
          payload = JSON.parse(new TextDecoder().decode(bytes))
        } catch { payload = undefined }
        verify()
        const error = ApiErrorResponseSchema.safeParse(payload)
        if (error.success) throw new ApiError(error.data.error, response.status)
        throw failure('HTTP_ERROR', 'The download could not be completed.', response.status)
      }
      const mediaType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (response.status !== 200 || mediaType !== file.revision.mediaType) {
        void response.body?.cancel().catch(() => undefined)
        throw failure('INVALID_RESPONSE', 'The file response has an unexpected type or status.')
      }
      const bytes = await readBytes(response, Math.min(file.revision.byteSize, MAX_FILE_BYTES), requestSignal)
      verify()
      if (bytes.byteLength !== file.revision.byteSize) throw failure('INVALID_RESPONSE', 'The file response is incomplete.')
      if (isRasterImage(mediaType) && !hasRasterSignature(bytes, mediaType)) {
        throw failure('INVALID_RESPONSE', 'The image response has an invalid signature.')
      }
      // Never trust a successful response to have delivered the requested immutable revision.
      if (!globalThis.crypto?.subtle) throw failure('INVALID_RESPONSE', 'Secure download verification is unavailable.')
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
      verify()
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      if (sha256 !== file.revision.sha256) throw failure('INVALID_RESPONSE', 'The file response does not match its revision.')
      return new Blob([bytes], { type: file.revision.mediaType })
    },
  }
}
