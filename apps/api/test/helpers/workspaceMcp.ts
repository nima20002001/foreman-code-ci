import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import * as contracts from '@foreman-code/contracts/management'
import pg from 'pg'
import type { z } from 'zod'

import { buildApp, type BuildAppOptions } from '../../src/app.js'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../../src/modules/settings/foundation.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../../src/modules/workspaces/management.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { closeTestResources } from '../support/cleanup.js'
import { migratedDatabase } from './migratedDatabase.js'
import { createTestPool } from './testPool.mjs'
import { assertTestDatabase, requireTestServerUrl } from '../../../../scripts/test-resources.mjs'

type WorkspaceFixtureServices = {
  pool: pg.Pool
  access: PostgresAccessService
  commands: PostgresCommandCoordinator
  parentPath: string
  services: OperatorServices
}

export async function workspaceMcpFixture(options: {
  connectionString?: string
  /** A caller-owned migrated fixture avoids rebuilding the schema. */
  database?: Awaited<ReturnType<typeof migratedDatabase>>
  port?: number
  runtimeIdentity?: BuildAppOptions['runtimeIdentity']
  configureServices?(fixture: WorkspaceFixtureServices): Promise<void>
  configure?(fixture: WorkspaceFixtureServices & {
    app: ReturnType<typeof buildApp>
  }): Promise<void>
} = {}) {
  const database = options.database ?? (options.connectionString ? undefined : await migratedDatabase())
  const connectionString = database?.databaseUrl ?? options.connectionString ?? process.env.TEST_DATABASE_URL
  if (!connectionString) throw new Error('A disposable test database is required')
  const databaseUrl = requireTestServerUrl(connectionString)
  const schema = 'workspace_mcp_' + randomUUID().replaceAll('-', '')
  const parentPath = database?.directory ?? await mkdtemp(join(tmpdir(), 'workspace-mcp-'))
  const admin = createTestPool({ connectionString })
  const pool = database?.pool
    ?? new pg.Pool({ connectionString, options: `-c search_path=${schema}`, application_name: schema })
  const clients: Client[] = []
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const locations = new WorkspaceLocationService(pool, commands, undefined, 'runner-local')
  const defaults = new PostgresFoundationSettingsRepository(pool, parentPath)
  const workspaces = new WorkspaceManagementService(pool, commands, locations, defaults, parentPath)
  const services = { commands, locations, workspaces } as unknown as OperatorServices
  let app: ReturnType<typeof buildApp> | undefined

  const databaseCleanup: Array<() => Promise<void>> = []
  if (database) {
    databaseCleanup.push(() => admin.end())
    if (!options.database) databaseCleanup.push(() => database.close())
  } else {
    databaseCleanup.push(
      () => pool.end(),
      () => dropFixtureSchema(admin, schema),
      () => removeFixtureDirectory(parentPath),
      () => admin.end(),
    )
  }

  let closing: Promise<void> | undefined
  function close() {
    return closing ??= closeTestResources([
      ...clients.map(client => () => client.close()),
      async () => { await app?.close() },
      ...databaseCleanup,
    ])
  }
  try {
    await assertTestDatabase(admin, {
      directory: process.env.FOREMAN_CODE_TEST_ROOT!,
      token: process.env.FOREMAN_CODE_TEST_OWNER!,
      name: decodeURIComponent(databaseUrl.pathname.slice(1)),
      databaseUrl: connectionString,
    })
    if (!database) {
      await createFixtureSchema(admin, schema)
      await applyApplicationMigrations(pool)
    }
    await options.configureServices?.({ pool, access, commands, parentPath, services })
    app = buildApp({ logger: false, readiness: {
      database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
    }, operator: { access, services }, ...(options.runtimeIdentity ? { runtimeIdentity: options.runtimeIdentity } : {}) })
    await options.configure?.({ app, pool, access, commands, parentPath, services })
    const address = await app.listen({ host: '127.0.0.1', port: options.port ?? 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'workspace-regression', version: '1.0.0' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    async function issue(grants: contracts.ManagementGrant[] = [{
      actions: [...contracts.ManagementActionSchema.options], scope: {},
    }]) {
      const issued = await access.issue({ name: 'Workspace caller', audience: 'operator', grants,
        expiresAt: new Date(Date.now() + 120_000) })
      return { ...issued, client: await connect(issued.token) }
    }
    const owner = await issue()
    return { app, pool, access, commands, defaults, parentPath, owner, connect, issue, close, services, address }
  } catch (error) {
    try { await close() }
    catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Workspace fixture setup and cleanup failed.', { cause: cleanup })
    }
    throw error
  }
}

export async function callWorkspaceTool<T>(
  client: Client, name: string, schema: z.ZodType<T>, args: Record<string, unknown> = {},
): Promise<T> {
  const response = await client.callTool({ name, arguments: args })
  if (response.isError) throw new Error(`MCP tool ${name} failed: ${JSON.stringify(response)}`)
  return schema.parse(decodeMcpToolResult(response))
}

export async function waitForWorkspaceBlocker(pool: pg.Pool, blockerPid: number) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await pool.query<{ waiting: boolean }>(
      `select exists(select 1 from pg_stat_activity
       where application_name = current_setting('application_name')
         and $1::int = any(pg_blocking_pids(pid))) as waiting`, [blockerPid],
    )
    if (result.rows[0]?.waiting) return
    await new Promise<void>(done => setTimeout(done, 10))
  }
  throw new Error('The MCP mutation did not wait for the held workspace lock')
}
