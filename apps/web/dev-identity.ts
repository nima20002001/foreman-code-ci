import { createRuntimeBuildIdentity } from '@foreman-code/contracts/runtime-build-identity-node'
import { fileURLToPath } from 'node:url'
import { checkoutIdentity } from '@foreman-code/contracts/runtime-identity-node'
import type { Plugin } from 'vite'

export function devIdentity(apiUrl: string): Plugin {
  const checkoutId = checkoutIdentity(fileURLToPath(new URL('../../', import.meta.url)))
  return {
    name: 'graphql-dev-identity',
    transformIndexHtml() {
      // Fresh navigation gets fresh metadata; an already loaded document keeps its original build.
      return [{ tag: 'meta', attrs: { name: 'foreman-runtime-build',
        content: JSON.stringify(createRuntimeBuildIdentity(fileURLToPath(new URL('../../', import.meta.url)))) } }]
    },
    configureServer(server) {
      server.middlewares.use('/__graphql_dev_identity', (_request, response) => {
        response.setHeader('Content-Type', 'application/json')
        response.setHeader('Cache-Control', 'no-store')
        response.end(JSON.stringify({ checkoutId, apiUrl }))
      })
    },
  }
}
