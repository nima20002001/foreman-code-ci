import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildApp } from '../../src/app.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { migratedDatabase } from './migratedDatabase.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { authorizeDeviceHost } from '../../src/modules/devices/hostAuthorization.js'
import { HarnessInstanceSettingsRepository } from '../../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessOverrideService } from '../../src/modules/harnesses/instanceSettings/service.js'
import { PostgresFoundationSettingsRepository } from '../../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../../src/modules/settings/management.js'
import { PostgresOperatorRepository } from '../../src/modules/operators/postgres.js'

export async function reviewAuthMcpDatabase(options: { hostProfiles?: boolean } = {}) {
  const database = await migratedDatabase()
  const { pool } = database
  let app: ReturnType<typeof buildApp> | undefined
  const clients: Client[] = []
  const close = async () => {
    await Promise.all(clients.map(client => client.close())); await app?.close()
    await database.close()
  }
  try {
    const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
    const profiles = new HostHarnessOverrideService(new HarnessInstanceSettingsRepository(pool), commands, {
      authorize: async (principal, action, host, installation, client) => {
        if (!client) throw new Error('Host authorization requires the settings transaction')
        await authorizeDeviceHost(client, principal, action, host, installation)
      },
    }, async () => null)
    const repository = new PostgresFoundationSettingsRepository(pool), operators = new PostgresOperatorRepository(pool)
    const settings = new FoundationSettingsManagementService(repository, commands, undefined, operators, profiles)
    const services = { commands, settings, ...(options.hostProfiles === false ? {} : { harnessInstances: profiles }) } as unknown as OperatorServices
    app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } }, operator: { access, services } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'review-auth-mcp', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const mainId = (await pool.query('select id from application_installation')).rows[0].id as string
    return { pool, access, commands, profiles, repository, operators, settings, connect, mainId, services, close }
  } catch (error) { await close(); throw error }
}
