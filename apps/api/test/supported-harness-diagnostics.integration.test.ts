import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { HarnessCompatibilityListSchema } from '@foreman-code/contracts'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HarnessCompatibilityService } from '../src/modules/harnesses/compatibility/service.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

it('reads only supported (Codex and Claude) diagnostics through authenticated MCP and denies callers without harness access', async () => {
  const database = await migratedDatabase()
  const access = new PostgresAccessService(database.pool)
  const inspect = vi.fn()
  const compatibility = new HarnessCompatibilityService({
    probe: { inspect, probe: vi.fn(), assertUnchanged: vi.fn() },
    cache: { load: async () => null, save: async () => {} },
  })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { harnessCompatibility: compatibility,
      commands: new PostgresCommandCoordinator(database.pool) } as unknown as OperatorServices },
  })
  const clients: Client[] = []
  try {
    const owner = await access.issue({ name: 'Diagnostics reader', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const denied = await access.issue({ name: 'Unrelated reader', audience: 'operator',
      grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'supported-diagnostics-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(owner.token)
    const expected = HarnessCompatibilityListSchema.parse(compatibility.read(owner.principal))
    expect(expected.harnesses.map(report => report.harness)).toEqual(['codex'])
    const result = await client.callTool({ name: 'harness_compatibility_list', arguments: {} })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    expect(HarnessCompatibilityListSchema.parse(decodeMcpToolResult(result))).toEqual(expected)
    const deniedClient = await connect(denied.token)
    await expectMcpAccessDenied(deniedClient.callTool({ name: 'harness_compatibility_list', arguments: {} }))
    expect(inspect).not.toHaveBeenCalled()
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await compatibility.close()
    await app.close()
    await database.close()
  }
}, 30_000)
