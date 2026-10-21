import { localHumanProxyRequest } from '@foreman-code/contracts/local-client-node'
import type { Plugin } from 'vite'

export function localHumanProxy(): Plugin {
  return {
    name: 'foreman-code-local-human-proxy',
    configureServer(server) {
      server.middlewares.use(localHumanProxyRequest)
    },
  }
}
