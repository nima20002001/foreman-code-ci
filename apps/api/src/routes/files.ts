import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'

import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { FileConversation } from '../modules/files/authorization.js'
import { EmptyFileCommandSchema } from '../modules/files/requests.js'
import type { FileStorageService, TemporaryFileService } from '../modules/files/service.js'

export interface FileRouteParams {
  conversationId: string; workspaceId?: string; workflowId?: string; requestId: string; fileId: string; revisionId: string
}
export interface FileScopeRoute<Target> { root: string; target(params: FileRouteParams): Target }
type Params = FileRouteParams
const RequestIdSchema = z.string().trim().min(1).max(200)
const UPLOAD_TIMEOUT_MS = 120_000

export function fileDownloadHeaders(filename: string, mediaType: string, byteSize: number): Record<string, string> {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\;]/g, '_') || 'download'
  // UTF-8 round-trip replaces lone surrogates without requiring ES2024 String APIs.
  const encoded = encodeURIComponent(Buffer.from(filename, 'utf8').toString('utf8')).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return {
    'content-type': mediaType, 'content-length': String(byteSize),
    'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'", 'cross-origin-resource-policy': 'same-origin',
    'accept-ranges': 'none',
  }
}

/** Shared FIL-03 raw-upload parsing, deadlines, finalize/cancel and download headers. */
export function registerFileScopeRoutes<Target>(app: FastifyInstance, service: FileStorageService<Target>,
  routes: readonly FileScopeRoute<Target>[]): void {
  // Encapsulation prevents the raw-byte parser from changing unrelated API routes.
  void app.register(async (files) => {
    files.addHook('onRequest', async (request, reply) => {
      if (request.method !== 'PUT') return
      // Reject before Fastify's JSON/text parsers could buffer an upload or mask a 415 as a 500.
      if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/octet-stream'
        || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
        reply.header('connection', 'close'); request.raw.resume()
        throw new DomainError('FILE_CONTENT_TYPE_INVALID', 'Upload raw application/octet-stream bytes without content encoding.', 415)
      }
      const length = request.headers['content-length']
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_FILE_BYTES)) {
        reply.header('connection', 'close'); request.raw.resume()
        throw new DomainError('FILE_TOO_LARGE', 'The upload exceeds the permitted byte limit.', 413)
      }
    })
    files.addHook('onError', async (request, reply) => {
      if (request.body instanceof Readable) { reply.header('connection', 'close'); request.body.resume() }
    })
    files.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload))
    for (const { root, target } of routes) {
      files.get<{ Params: Params; Querystring: unknown }>(root, async (request) =>
        service.list(requirePrincipal(request), target(request.params), request.query))
      files.post<{ Params: Params; Body: unknown }>(`${root}/uploads`, async (request, reply) => {
        const result = await service.allocate(requirePrincipal(request), target(request.params), request.body)
        reply.code(result.replayed ? 200 : 201)
        return result
      })
      files.put<{ Params: Params; Body: Readable }>(`${root}/uploads/:requestId`, { bodyLimit: MAX_FILE_BYTES }, async (request, reply) => {
        if (!(request.body instanceof Readable)) throw new DomainError('FILE_UPLOAD_INCOMPLETE', 'A raw upload stream is required.', 400)
        try {
          return await service.upload(requirePrincipal(request), target(request.params), RequestIdSchema.parse(request.params.requestId), request.body,
            { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS), ...(request.reauthorizeOperator ? { reauthorize: request.reauthorizeOperator } : {}) })
        } catch (error) {
          // The body parser does not buffer. Do not leave an unread keep-alive request after rejection.
          reply.header('connection', 'close'); request.body.resume()
          throw error
        }
      })
      files.post<{ Params: Params; Body: unknown }>(`${root}/uploads/:requestId/finalize`, async (request) => {
        EmptyFileCommandSchema.parse(request.body ?? {})
        return service.finalize(requirePrincipal(request), target(request.params), RequestIdSchema.parse(request.params.requestId))
      })
      files.delete<{ Params: Params; Body: unknown }>(`${root}/uploads/:requestId`, async (request) => {
        EmptyFileCommandSchema.parse(request.body ?? {})
        return service.cancel(requirePrincipal(request), target(request.params), RequestIdSchema.parse(request.params.requestId))
      })
      files.get<{ Params: Params }>(`${root}/:fileId/revisions/:revisionId/content`, async (request, reply) => {
        const result = await service.download(requirePrincipal(request), target(request.params), {
          fileId: request.params.fileId, revisionId: request.params.revisionId,
        })
        reply.headers(fileDownloadHeaders(result.revision.filename, result.revision.mediaType, result.revision.byteSize))
        return reply.send(result.stream)
      })
    }
  })
}

export function registerFileRoutes(app: FastifyInstance, service: TemporaryFileService): void {
  registerFileScopeRoutes(app, service, (['operator', 'agent'] as const).map((kind) => ({
    root: kind === 'operator' ? '/api/operator/conversations/:conversationId/files'
      : '/api/workspaces/:workspaceId/agent-chat/conversations/:conversationId/files',
    target: (params: Params): FileConversation => kind === 'operator'
      ? { kind, conversationId: params.conversationId }
      : { kind, workspaceId: params.workspaceId!, conversationId: params.conversationId },
  })))
}
