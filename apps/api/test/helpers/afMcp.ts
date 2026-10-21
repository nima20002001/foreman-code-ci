import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildApp } from '../../src/app.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import type { afPublicationFixture } from './afPublicationFixture.js'

/** Real authenticated Operator MCP transport, not a direct tool-handler invocation. */
export async function withAfMcp<T>(f: Awaited<ReturnType<typeof afPublicationFixture>>,
  run: (writer: Client, reader: Client) => Promise<T>): Promise<T> {
  const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: f.access, services: { agentChat: f.chat,
      commands: new PostgresCommandCoordinator(f.database.pool) } as unknown as OperatorServices } })
  const clients: Client[] = []
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'af-regressions', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    return await run(await connect(f.owner.token), await connect(f.reader.token))
  } finally { await Promise.allSettled(clients.map((client) => client.close())); await app.close() }
}
