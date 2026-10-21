import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import { access } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'

/** Serve the compiled shell on the API origin, preserving API/MCP error responses. */
export async function registerBuiltWeb(app: FastifyInstance, root: string): Promise<void> {
  if (!isAbsolute(root)) throw new Error('FOREMAN_CODE_WEB_DIST requires an absolute directory.')
  await access(join(root, 'index.html'))
  void app.register(fastifyStatic, {
    root,
    // Resolve files per request so directory discovery cannot exhaust pluginTimeout under load.
    wildcard: true,
    index: false,
    cacheControl: false,
    setHeaders(response, path) {
      const cache = path.includes(`${sep}assets${sep}`)
        ? 'public, max-age=31536000, immutable' : 'no-cache'
      response.setHeader('cache-control', cache)
      response.setHeader('x-content-type-options', 'nosniff')
    },
  })
  const shellRoutes = [
    '/', '/workspaces', '/workspaces/*', '/settings', '/settings/*',
    '/account', '/terminal', '/approvals',
  ]
  for (const path of shellRoutes) {
    app.get(path, async (_request, reply) => reply.sendFile('index.html'))
  }
}
