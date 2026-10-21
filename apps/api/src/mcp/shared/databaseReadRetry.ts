import type { McpServer } from '@modelcontextprotocol/server'
import { withDatabaseReadRetry } from '../../infrastructure/databaseReadRetry.js'

/** The registered tool's annotation is the retry boundary; writes never enter it. */
export function retryReadOnlyToolConnections(server: McpServer): void {
  server.registerTool = new Proxy(server.registerTool, {
    apply(register, target, [name, config, callback]) {
      if (config.annotations?.readOnlyHint !== true) {
        return Reflect.apply(register, target, [name, config, callback])
      }
      const read = new Proxy(callback, {
        apply(handler, receiver, arguments_) {
          const extra = arguments_[1] as { mcpReq?: { signal?: AbortSignal } } | undefined
          return withDatabaseReadRetry(async () => Reflect.apply(handler, receiver, arguments_), extra?.mcpReq?.signal)
        },
      })
      return Reflect.apply(register, target, [name, config, read])
    },
  })
}
