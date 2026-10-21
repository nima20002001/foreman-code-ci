import type { FastifyInstance } from 'fastify'
import { requirePrincipal } from '../modules/access/http.js'
import { bindBrowserOperation, type BrowserCanonicalCodecs, type BrowserOperationHandlers, type BrowserOperationName } from '../modules/browser-runtime/operations.js'

export const browserProfileRoutes = [
  ['GET', '/api/browser/profiles', 'browser_profiles_list'],
  ['GET', '/api/browser/profiles/:profileId', 'browser_profile_get'],
  ['POST', '/api/browser/profiles', 'browser_profile_create'],
  ['PATCH', '/api/browser/profiles/:profileId', 'browser_profile_update'],
  ['DELETE', '/api/browser/profiles/:profileId/replicas/:computerId', 'browser_profile_remove'],
  ['POST', '/api/browser/profiles/sync', 'browser_profiles_sync'],
  ['GET', '/api/browser/profile-sync/:id', 'browser_profile_sync_get'],
] as const

export function registerBrowserProfileRoutes(app: FastifyInstance, handlers: BrowserOperationHandlers, codecs: BrowserCanonicalCodecs): void {
  for (const [method, url, name] of browserProfileRoutes) app.route({ method, url,
    handler: request => bindBrowserOperation(name as BrowserOperationName, handlers, codecs).http(requirePrincipal(request), request) })
}
