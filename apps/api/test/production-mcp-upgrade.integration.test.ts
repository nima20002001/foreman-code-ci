import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { AppMcpRoutes } from '../src/modules/harnesses/appMcpRoutes.js'
import { installManagedLauncher, isAppLauncher } from '../src/modules/harnesses/appMcpLauncher.js'
import { upgradeProductionMcpLauncher } from '../src/modules/harnesses/productionMcpUpgrade.js'
import { nativeConnection } from '../src/modules/harnesses/nativeMcpCommon.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { runLauncherProcess } from './helpers/launcherInstallationProcess.js'
import { ownedTestDatabaseUrl } from './helpers/testResources.js'

const cleanup: Array<() => Promise<unknown>> = []
let runtimeFixtureDirectory: string | undefined
let runtimeFixtureBinary: string
beforeAll(async () => {
  // Aliases share a private copy so linking them cannot change installed Node metadata.
  runtimeFixtureDirectory = await mkdtemp(join(tmpdir(), 'production-mcp-runtime-'))
  runtimeFixtureBinary = join(runtimeFixtureDirectory, 'node')
  await copyFile(process.execPath, runtimeFixtureBinary, constants.COPYFILE_FICLONE)
})
afterAll(async () => {
  if (runtimeFixtureDirectory) await rm(runtimeFixtureDirectory, { recursive: true, force: true })
})
afterEach(async () => {
  try {
    while (cleanup.length) await cleanup.pop()!()
  } finally {
    vi.unstubAllEnvs()
  }
})

const changes = ['older-writer', 'concurrent-writers', 'retained-recovery', 'unused-directory'] as const
const cases = (['codex'] as const).flatMap(harness => changes.map(change => ({ harness, change })))

it.each(cases)(
  '$harness launcher survives $change through authenticated MCP and two API restarts', async ({ harness, change }) => {
    const home = await mkdtemp(join(tmpdir(), 'production-mcp-restart-'))
    cleanup.push(() => rm(home, { recursive: true, force: true }))
    const previous = join(home, '.local/state/graphql-production/mcp/launcher.mjs')
    const shared = join(home, '.local/share/graphql/mcp/launcher.mjs')
    const installedRuntime = join(home, 'production-node')
    const developmentRuntime = join(home, 'development-node')
    const concurrentRuntime = join(home, 'concurrent-node')
    await Promise.all([installedRuntime, developmentRuntime, concurrentRuntime]
      .map(async runtime => {
        try {
          await link(runtimeFixtureBinary, runtime)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'EXDEV' && code !== 'EPERM') throw error
          await copyFile(runtimeFixtureBinary, runtime, constants.COPYFILE_FICLONE)
        }
      }))
    vi.stubEnv('GRAPHQL_APP_MCP_DIRECTORY', undefined)
    const savedLauncher = change === 'unused-directory' ? shared : previous
    vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', dirname(savedLauncher))
    await runLauncherProcess({ kind: 'older-install', launcher: shared }, developmentRuntime)
    if (change === 'unused-directory') {
      await mkdir(join(dirname(previous), 'routes'), { recursive: true })
    } else {
      await installManagedLauncher(new URL('../../../scripts/graphql-mcp.mjs', import.meta.url), previous)
    }
    await runLauncherProcess({ kind: 'older-install', launcher: savedLauncher }, installedRuntime)
    const tokenVariable = harness === 'codex' ? 'GRAPHQL_MCP_TOKEN' : 'FOREMAN_CODE_MCP_TOKEN'
    const connection = {
      transport: 'stdio' as const, executable: installedRuntime, arguments: [savedLauncher],
      environmentVariables: [tokenVariable],
    }
    const entry = nativeConnection(connection)
    expect(isAppLauncher(entry)).toBe(true)
    const database = createDatabase({
      connectionString: ownedTestDatabaseUrl(),
      maxConnections: 4, connectionTimeoutMs: 5000, queryTimeoutMs: 5000,
    })
    cleanup.push(() => database.close())
    await database.migrate()
    const access = new PostgresAccessService(database.pool)
    const issue = (role: 'owner' | 'reader') => access.issue({
      name: 'production-upgrade', audience: 'operator',
      grants: [{ actions: role === 'owner' ? ['settings:read', 'settings:update'] : ['settings:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000),
    })
    const owner = await issue('owner')
    const reader = await issue('reader')
    cleanup.push(async () => {
      for (const { principal } of [owner, reader]) {
        await database.pool.query('delete from management_audit where principal_id=$1', [principal.id])
        await database.pool.query('delete from management_command_receipts where principal_id=$1', [principal.id])
        await database.pool.query('delete from management_principals where id=$1', [principal.id])
      }
    })
    const start = async () => {
      const commands = new PostgresCommandCoordinator(database.pool)
      const settings = new FoundationSettingsManagementService(
        new PostgresFoundationSettingsRepository(database.pool), commands,
      )
      const app = buildApp({
        readiness: { database, checkpoints: { ping: async () => undefined } },
        operator: { access: new PostgresAccessService(database.pool), services: { settings, commands } as OperatorServices },
      })
      let requests = 0
      app.addHook('onRequest', async () => { requests += 1 })
      const endpoint = `${await app.listen({ host: '127.0.0.1', port: 0 })}/mcp`
      const routes = new AppMcpRoutes(database.pool, endpoint)
      const close = async () => {
        await routes.close()
        await app.close()
      }
      cleanup.push(close)
      await routes.refresh()
      return { close, routes, settings, requests: () => requests }
    }
    const connect = async (token: string) => {
      const client = new Client({ name: 'production-upgrade', version: '1' })
      cleanup.push(() => client.close())
      const command = harness === 'codex'
        ? [entry.command as string, ...(entry.args as string[])] : entry.command as string[]
      await client.connect(new StdioClientTransport({
        command: command[0]!, args: command.slice(1), env: { [tokenVariable]: token }, stderr: 'pipe',
      }))
      return client
    }
    const first = await start()
    const ownerClient = await connect(owner.token)
    const readerClient = await connect(reader.token)
    const initial = decodeMcpToolResult((await ownerClient.callTool({ name: 'workspace_defaults_get', arguments: {} }))) as { revision: number; value: Record<string, unknown> }
    const value = { ...initial.value, description: `production upgrade ${randomUUID()}` }
    const saved = await ownerClient.callTool({ name: 'workspace_defaults_update', arguments: {
      commandId: randomUUID(), expectedRevision: initial.revision, value,
    } })
    expect(saved.isError).not.toBe(true)
    const assertDeniedUpdate = async (client: Client) => {
      const denied = await client.callTool({ name: 'workspace_defaults_update', arguments: {
        commandId: randomUUID(), expectedRevision: initial.revision + 1, value: initial.value,
      } })
      expect(denied.isError).toBe(true)
      const body = denied.content.find((item) => item.type === 'text')
      expect(JSON.parse(body!.text as string)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    }
    const assertReadback = async (settings: FoundationSettingsManagementService) => {
      expect(decodeMcpToolResult((await ownerClient.callTool({ name: 'workspace_defaults_get', arguments: {} }))))
        .toMatchObject({ value })
      expect(decodeMcpToolResult((await readerClient.callTool({ name: 'workspace_defaults_get', arguments: {} }))))
        .toMatchObject({ value })
      await assertDeniedUpdate(readerClient)
      expect(await settings.getWorkspaceDefaults(owner.principal)).toMatchObject({ value })
    }
    await assertReadback(first.settings)
    await first.close()
    const runtimeModule = new URL('../../../scripts/local-production-runtime.mjs', import.meta.url).href
    const { localProductionEnvironment } = await import(runtimeModule)
    const environment = localProductionEnvironment(home, 'a'.repeat(64))
    vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', environment.FOREMAN_CODE_APP_MCP_DIRECTORY)
    expect(isAppLauncher(entry)).toBe(change === 'unused-directory')
    await upgradeProductionMcpLauncher(home)
    expect(isAppLauncher(entry)).toBe(true)
    const upgraded = await start()
    await assertReadback(upgraded.settings)
    expect(upgraded.requests()).toBeGreaterThan(0)
    const renewedOwnerClient = await connect(owner.token)
    expect(decodeMcpToolResult((await renewedOwnerClient.callTool({ name: 'workspace_defaults_get', arguments: {} }))))
      .toMatchObject({ value })
    if (change === 'older-writer') {
      await runLauncherProcess({ kind: 'older-install', launcher: shared }, developmentRuntime)
    } else if (change === 'concurrent-writers') {
      await Promise.all([
        runLauncherProcess({ kind: 'older-install', launcher: shared }, developmentRuntime),
        runLauncherProcess({ kind: 'install', launcher: shared }),
        runLauncherProcess({ kind: 'install', launcher: previous }, concurrentRuntime),
        runLauncherProcess({ kind: 'register', launcher: shared, installation: {
          version: 1, executables: [], launcherAliases: [previous],
        } }),
      ])
    } else if (change === 'retained-recovery') {
      // Recreate a transition overwritten before its registration was preserved separately.
      await rm(`${shared}.registration.json`)
      await runLauncherProcess({ kind: 'older-install', launcher: shared, snapshot: {
        version: 1, executables: [{ path: developmentRuntime, realpath: developmentRuntime }],
      } }, developmentRuntime)
    }
    expect(isAppLauncher(entry)).toBe(change !== 'retained-recovery')
    await assertReadback(upgraded.settings)
    await upgraded.close()
    await runLauncherProcess({ kind: 'upgrade', home })
    expect(isAppLauncher(entry)).toBe(true)
    await installManagedLauncher(new URL('../../../scripts/graphql-mcp.mjs', import.meta.url), shared)
    const restarted = await start()
    await assertReadback(restarted.settings)
    expect(restarted.requests()).toBeGreaterThan(0)
    expect(isAppLauncher(entry)).toBe(true)
    if (change === 'concurrent-writers') {
      for (const executable of [developmentRuntime, concurrentRuntime]) {
        const installedEntry = nativeConnection({ ...connection, executable })
        expect(await runLauncherProcess({ kind: 'recognize', launcher: shared,  entry: installedEntry }))
          .toBe('true')
      }
    }
    const restartedOwnerClient = await connect(owner.token)
    const restartedReaderClient = await connect(reader.token)
    expect(decodeMcpToolResult((await restartedOwnerClient.callTool({ name: 'workspace_defaults_get', arguments: {} }))))
      .toMatchObject({ value })
    await assertDeniedUpdate(restartedReaderClient)
    const digest = createHash('sha256').update(owner.token).digest('hex')
    const route = await readFile(join(dirname(savedLauncher), 'routes', `${digest}.json`), 'utf8')
    expect(route).not.toContain(owner.token)
    expect(route).not.toContain(reader.token)
    await access.revoke(reader.principal.id)
    await restarted.routes.refresh()
    await expect(readerClient.callTool({ name: 'workspace_defaults_get', arguments: {} }))
      .rejects.toThrow('route is unavailable')
    expect(await restarted.settings.getWorkspaceDefaults(owner.principal)).toMatchObject({ value })
  }, 30_000,
)
