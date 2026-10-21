import { http, type HttpHandler } from 'msw'

/** C0 fixtures provide canonical responses. Tests exercise real clients over HTTP. */
export function browserMswHandlers(resolve: (request: Request, params: Record<string, string | readonly string[] | undefined>) => Promise<Response> | Response): HttpHandler[] {
  const routes = ['/api/browser/profiles', '/api/browser/profiles/:profileId',
    '/api/browser/profiles/:profileId/replicas/:computerId', '/api/browser/profiles/sync', '/api/browser/profile-sync/:id',
    '/api/browser/sessions', '/api/browser/sessions/open', '/api/browser/sessions/:id', '/api/browser/sessions/:id/close',
    '/api/browser/sessions/:id/tabs', '/api/browser/sessions/:id/tabs/:tabId', '/api/browser/sessions/:id/tabs/:tabId/select',
    '/api/browser/sessions/:id/control/:intent', '/api/browser/sessions/:id/input', '/api/browser/sessions/:id/actions',
    '/api/browser/sessions/:id/views', '/api/browser/sessions/:id/views/:viewId', '/api/browser/sessions/:id/uploads',
    '/api/browser/sessions/:id/uploads/:uploadId', '/api/browser/sessions/:id/uploads/:uploadId/bytes',
    '/api/browser/sessions/:id/uploads/:uploadId/finish', '/api/browser/sessions/:id/files/:fileId',
    '/api/browser/sessions/:id/files/:fileId/bytes']
  return routes.map(path => http.all(`*${path}`, ({ request, params }) => resolve(request, params)))
}
