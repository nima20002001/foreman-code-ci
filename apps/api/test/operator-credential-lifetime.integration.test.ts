import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { describe, expect, it, vi } from 'vitest'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('Operator credential lifetime', () => {
  it('keeps default credentials usable through MCP after a month, with persisted scope and revocation', async () => {
    const db = await migratedDatabase()
    const access = new PostgresAccessService(db.pool)
    const commands = new PostgresCommandCoordinator(db.pool)
    const settings = new PostgresFoundationSettingsRepository(db.pool)
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { settings: new FoundationSettingsManagementService(settings, commands), commands } as unknown as OperatorServices },
    })
    const clients: Client[] = []
    let restoreClock: (() => void) | undefined
    try {
      const reader = await access.issue({ name: 'Settings reader', audience: 'operator',
        grants: [{ actions: ['settings:read'], scope: {} }] })
      const denied = await access.issue({ name: 'Run reader', audience: 'operator',
        grants: [{ actions: ['runs:read'], scope: {} }] })
      const persisted = await access.currentOperator(reader.principal.id)
      expect(persisted.expiresAt).toBe('9999-12-31T23:59:59.999Z')
      expect(persisted.grants).toEqual(reader.principal.grants)
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 86_400_000)
      restoreClock = () => clock.mockRestore()
      const connect = async (token: string) => {
        const client = new Client({ name: 'credential-lifetime', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { authProvider: { token: async () => token } }))
        return client
      }
      const client = await connect(reader.token)
      const response = decodeMcpToolResult(await client.callTool({ name: 'workspace_defaults_get', arguments: {} }))
      expect(response).toEqual(await settings.getWorkspaceDefaults())
      const deniedClient = await connect(denied.token)
      await expectMcpAccessDenied(deniedClient.callTool({ name: 'workspace_defaults_get', arguments: {} }))
      expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('workspace_defaults_update')
      await access.revoke(reader.principal.id)
      await expect(access.authenticate(reader.token)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      const revoked = await fetch(`${address}/mcp`, { method: 'POST',
        headers: { Authorization: `Bearer ${reader.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect(revoked.status).toBe(401)
    } finally {
      restoreClock?.()
      for (const client of clients) await client.close()
      await app.close()
      await db.close()
    }
  })
})
