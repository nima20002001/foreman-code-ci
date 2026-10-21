import type { SyncedMcpServer } from '@foreman-code/contracts/computer-maintenance'

/** Compare the fields fleet sync owns; native tools may include additional status fields. */
export function matchesMcpDefinition(server: SyncedMcpServer, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const definition = raw as Record<string, unknown>
  if (server.transport === 'http') {
    return definition.url === server.url
      && (definition.bearer_token_env_var ?? null) === server.bearerTokenEnvVar
      && definition.command === undefined
  }
  const args = definition.args ?? []
  return definition.command === server.command && definition.url === undefined
    && Array.isArray(args) && args.length === server.args.length
    && args.every((value, index) => value === server.args[index])
}
