import { AsyncLocalStorage } from 'node:async_hooks'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { McpServer } from '@modelcontextprotocol/server'

export interface BoundTool<Context> {
  name: string
  description: string
  register(server: McpServer, context: Context): void
}

/** Builds schemas once; each registered callback runs with its own request's context. */
export function collectBoundTools<Context extends { principal: ManagementPrincipal }>(
  initial: Context,
  register: (server: McpServer, context: Context) => void,
): BoundTool<Context>[] {
  const requests = new AsyncLocalStorage<Context>()
  const current = () => {
    const context = requests.getStore()
    if (!context) throw new Error('MCP tool callback requires a request context')
    return context
  }
  const context = new Proxy({} as Context, {
    get: (_target, key) => Reflect.get(current(), key),
  })
  const tools: BoundTool<Context>[] = []
  const collector = { registerTool(name: string, config: { description?: string }, callback: (...args: unknown[]) => unknown) {
    tools.push({ name, description: config.description ?? '', register(server, request) {
      Reflect.apply(server.registerTool, server, [name, config,
        (...args: unknown[]) => requests.run(request, () => callback(...args))])
    } })
  } } as unknown as McpServer
  requests.run(initial, () => register(collector, context))
  return tools
}

/** Optional services can be composed after startup; replace their catalog when composition changes. */
export function sameCatalogDependencies(previous: readonly unknown[], dependencies: readonly unknown[]): boolean {
  return previous.length === dependencies.length && previous.every((value, index) => value === dependencies[index])
}
