import type { FastifyInstance } from 'fastify'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { BrowserViewerHelloSchema, type RuntimeIdentity } from '@foreman-code/contracts'
import type { OperatorServices } from '../mcp/operator/types.js'
import type { PostgresAccessService } from '../modules/access/postgres.js'
import type { LocalHumanAccess } from '../modules/access/localHuman.js'
import { operatorRequestIdentity, requirePrincipal } from '../modules/access/http.js'
import { createBrowserViewerUpgrade } from '../modules/browser-runtime/mediaSocket.js'
import { browserViewerCodec } from '../modules/collaboration/browserMediaCodecs.js'
import { DomainError } from '../modules/errors.js'
import { registerBrowserProfileRoutes } from './browserProfiles.js'
import { registerBrowserSessionRoutes } from './browserSessions.js'

export function registerProductionBrowserRoutes(app: FastifyInstance, browser: NonNullable<OperatorServices['browser']>,
  options: { access: PostgresAccessService; localHuman?: LocalHumanAccess | undefined; browserOrigin?: string | undefined;
    runtimeIdentity?: (() => Promise<RuntimeIdentity>) | undefined }) {
  app.get('/api/browser/target', request => {
    const query = request.query as { input?: string }
    let input: unknown = request.query
    if (query.input) {
      try { input = JSON.parse(query.input) }
      catch { throw new DomainError('BROWSER_INPUT_INVALID', 'The browser selection could not be decoded.', 400) }
    }
    return browser.target(requirePrincipal(request), input)
  })
  // Views remain bound to their URL session, including the read/close routes whose canonical input uses viewId.
  app.addHook('preHandler', async request => {
    const match = /^\/api\/browser\/sessions\/([^/]+)\/views\/([^/?]+)(?:\?|$)/.exec(request.url)
    if (match && await browser.locations.view(decodeURIComponent(match[2]!)) !== decodeURIComponent(match[1]!)) {
      throw new DomainError('BROWSER_VIEW_SCOPE', 'The view belongs to another browser session.', 403)
    }
  })
  registerBrowserProfileRoutes(app, browser.handlers, browser.codecs)
  registerBrowserSessionRoutes(app, browser.handlers, browser.codecs, browser.sessions)
  const viewer = createBrowserViewerUpgrade({ source: browser.media, codec: browserViewerCodec,
    reportFailure: error => app.log.warn({ err: error }, 'Browser viewer closed'),
    authenticate: async (request, rawHello) => {
      const hello = BrowserViewerHelloSchema.parse(rawHello)
      const hostname = new URL(`http://${request.headers.host ?? ''}`).hostname
      const identity = await operatorRequestIdentity({ hostname, ip: request.socket.remoteAddress ?? '',
        headers: request.headers, socket: request.socket }, options.access, options.localHuman, options.browserOrigin)
      const installation = options.runtimeIdentity ? (await options.runtimeIdentity()).installationId : undefined
      if (hello.installationId !== undefined && hello.installationId !== installation
        || identity.authentication === 'local-human' && installation !== hello.installationId) {
        throw new DomainError('INSTALLATION_CHANGED', 'Reload the app before reconnecting the browser.', 409)
      }
      return { principal: identity.principal, assertCurrent: async () => {
        const current = await identity.authenticate()
        if (current.id !== identity.principal.id || options.runtimeIdentity && (await options.runtimeIdentity()).installationId !== installation) {
          throw new DomainError('INSTALLATION_CHANGED', 'The browser authentication changed.', 409)
        }
      } }
    } })
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!viewer.handle(request, socket, head)) socket.destroy()
  }
  app.server.on('upgrade', upgrade)
  app.addHook('onClose', async () => { app.server.off('upgrade', upgrade); viewer.close() })
}
