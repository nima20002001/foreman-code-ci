import type { Readable } from 'node:stream'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../modules/errors.js'
import type { BrowserSessionPort } from '../modules/browser-runtime/service.js'
import type { FastifyInstance } from 'fastify'
import { requirePrincipal } from '../modules/access/http.js'
import { bindBrowserOperation, type BrowserCanonicalCodecs, type BrowserOperationHandlers } from '../modules/browser-runtime/operations.js'

export const browserSessionRoutes = [
  ['POST', '/api/browser/sessions/open', 'browser_session_open'], ['GET', '/api/browser/sessions', 'browser_sessions_list'],
  ['GET', '/api/browser/sessions/:id', 'browser_session_get'], ['POST', '/api/browser/sessions/:id/close', 'browser_session_close'],
  ['GET', '/api/browser/sessions/:id/tabs', 'browser_tabs_list'], ['POST', '/api/browser/sessions/:id/tabs', 'browser_tab_create'],
  ['POST', '/api/browser/sessions/:id/tabs/:tabId/select', 'browser_tab_select'], ['DELETE', '/api/browser/sessions/:id/tabs/:tabId', 'browser_tab_close'],
  ['POST', '/api/browser/sessions/:id/state', 'browser_state_read'], ['POST', '/api/browser/sessions/:id/screenshot', 'browser_screenshot'],
  ['POST', '/api/browser/sessions/:id/actions', 'browser_action'], ['POST', '/api/browser/sessions/:id/views', 'browser_view_open'],
  ['GET', '/api/browser/sessions/:id/views/:viewId', 'browser_view_read'], ['DELETE', '/api/browser/sessions/:id/views/:viewId', 'browser_view_close'],
  ['POST', '/api/browser/sessions/:id/control/acquire', 'browser_control_acquire'], ['POST', '/api/browser/sessions/:id/control/release', 'browser_control_release'],
  ['POST', '/api/browser/sessions/:id/input', 'browser_input'],
  ['POST', '/api/browser/sessions/:id/uploads', 'browser_action'],
  ['PUT', '/api/browser/sessions/:id/uploads/:fileId/bytes', 'browser_action'],
  ['POST', '/api/browser/sessions/:id/uploads/:fileId/finish', 'browser_action'],
  ['DELETE', '/api/browser/sessions/:id/uploads/:fileId', 'browser_action'],
  ['GET', '/api/browser/sessions/:id/files/:fileId/bytes', 'browser_action'],
  ['DELETE', '/api/browser/sessions/:id/files/:fileId', 'browser_action'],
] as const

export function registerBrowserSessionRoutes(app: FastifyInstance, handlers: BrowserOperationHandlers, codecs: BrowserCanonicalCodecs,
  access: Pick<BrowserSessionPort<ManagementPrincipal>, 'authorizeUpload'>): void {
  void app.register(async scoped => {
    // Return the bounded stream untouched: the existing preHandler authenticates before we read byte payloads.
    scoped.addContentTypeParser('application/octet-stream', (request, payload, done) => done(null, payload))
    for (const [method, url, name] of browserSessionRoutes) scoped.route({ method, url, bodyLimit: 262_144,
      handler: async (request, reply) => {
        const principal = requirePrincipal(request)
        if (method === 'PUT') {
          const params = request.params as { id: string; fileId: string }
          await access.authorizeUpload(principal, params.id, params.fileId)
          const body = request.body as Readable
          if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new DomainError('BROWSER_FILE_BYTES', 'Upload bytes require application/octet-stream.', 415)
          const chunks: Buffer[] = []; let length = 0
          for await (const chunk of body) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            length += bytes.length
            if (length > 262_144) throw new DomainError('BROWSER_FILE_CHUNK_INVALID', 'Upload chunks are limited to 256 KiB.', 413)
            chunks.push(bytes)
          }
          request.body = Buffer.concat(chunks, length)
        }
        const result = await bindBrowserOperation(name, handlers, codecs).http(principal, request, method === 'GET' && url.endsWith('/bytes'))
        return result instanceof Uint8Array ? reply.type('application/octet-stream').send(Buffer.from(result)) : result
      } })
  })
}
