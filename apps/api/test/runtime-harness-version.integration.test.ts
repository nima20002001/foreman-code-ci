import { join } from 'node:path'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HarnessCompatibilityListSchema } from '@foreman-code/contracts'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { FileCompatibilityCache } from '../src/modules/harnesses/compatibility/cache.js'
import { HarnessCompatibilityService } from '../src/modules/harnesses/compatibility/service.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

it('reads a persisted runtime version and verification result through MCP without release paperwork', async () => {
  const database = await migratedDatabase()
  const access = new PostgresAccessService(database.pool)
  const schemaSha256 = 'a'.repeat(64)
  const probe = {
    inspect: async () => ({ executable: '/fixture/codex', identity: 'fixture-installation', version: '99.0.0' }),
    probe: vi.fn(async () => schemaSha256),
    assertUnchanged: async () => undefined,
  }
  const options = { probe, cache: new FileCompatibilityCache(join(database.directory, 'compatibility')) }
  const initial = new HarnessCompatibilityService(options)
  const restored = new HarnessCompatibilityService(options)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access, services: { harnessCompatibility: restored,
      commands: new PostgresCommandCoordinator(database.pool) } as unknown as OperatorServices },
  })
  const clients: Client[] = []
  try {
    const [checked] = await initial.checkAll()
    await initial.close()
    await restored.checkAll()
    const reader = await access.issue({ name: 'Runtime diagnostics reader', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const denied = await access.issue({ name: 'Unrelated reader', audience: 'operator',
      grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'runtime-version-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(reader.token)
    const result = await client.callTool({ name: 'harness_compatibility_list', arguments: {} })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    const status = HarnessCompatibilityListSchema.parse(decodeMcpToolResult(result))
    expect(status.canRetry).toBe(false)
    expect(status.harnesses[0]).toMatchObject({ installedVersion: '99.0.0', status: 'probe-passed',
      schemaSha256, source: 'cache', checkedAt: checked?.checkedAt })
    expect(status.harnesses[0]).not.toHaveProperty('qualifiedRelease')
    expect(status.harnesses[0]).not.toHaveProperty('knownRelease')
    expect(status.harnesses[0]).not.toHaveProperty('matchesQualifiedVersion')
    expect(probe.probe).toHaveBeenCalledTimes(1)
    await expectMcpAccessDenied(client.callTool({ name: 'harness_compatibility_retry', arguments: { harness: 'codex' } }))
    const deniedClient = await connect(denied.token)
    await expectMcpAccessDenied(deniedClient.callTool({ name: 'harness_compatibility_list', arguments: {} }))
    expect(probe.probe).toHaveBeenCalledTimes(1)
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await initial.close()
    await restored.close()
    await app.close()
    await database.close()
  }
}, 30_000)
