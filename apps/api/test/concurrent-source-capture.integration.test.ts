import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
// eslint-disable-next-line no-restricted-imports -- Holding the capture past both SQL deadlines proves waiters do not use them.
import { setTimeout as delay } from 'node:timers/promises'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ApprovedSourceSchema, SourceApproveInputSchema, SourceApproveResultSchema,
  type ApprovedSource } from '@foreman-code/contracts/source-admission'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { qualifiedGit } from '../src/modules/sources/capture.js'
import { PostgresSourceService } from '../src/modules/sources/service.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { deferred } from './helpers/deferred.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'
import { createTestPool } from './helpers/testPool.mjs'

it('captures one workspace commit concurrently beyond the SQL deadline and reads the shared snapshot through MCP', async () => {
  const database = await migratedDatabase()
  const pool = createTestPool({ ...database.pool.options,
    options: `${database.pool.options.options} -c statement_timeout=1000 -c lock_timeout=1000` })
  const resume = deferred()
  const entered = deferred()
  const clients: Client[] = []
  const captures: Promise<PromiseSettledResult<ApprovedSource>[]>[] = []
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const project = join(database.directory, 'project')
    const canonical = join(database.directory, 'snapshots')
    const runtime = join(database.directory, 'runtime')
    for (const path of [project, canonical, runtime]) await mkdir(path, { mode: 0o700 })
    await qualifiedGit(project, ['init', '--template='])
    await writeFile(join(project, 'source.ts'), 'export const value = 1\n')
    await qualifiedGit(project, ['add', '.'])
    await qualifiedGit(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-m', 'Fixture source'])
    const commit = (await qualifiedGit(project, ['rev-parse', 'HEAD'])).toString().trim()
    const commands = new PostgresCommandCoordinator(pool)
    const access = new PostgresAccessService(pool)
    const owner = await access.issue({ name: 'Capture fixture', audience: 'operator',
      grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] })
    const locations = new WorkspaceLocationService(pool, commands, runtime, 'runner-local')
    const workspaces = new WorkspaceManagementService(pool, commands, locations)
    const created = await workspaces.create(owner.principal, 'http', {
      name: 'Concurrent capture', commandId: randomUUID(),
    })
    const workspaceId = created.value.workspace.id
    await workspaces.update(owner.principal, 'http', { workspaceId,
      commandId: randomUUID(), expectedRevision: created.value.revision,
      repository: { provider: 'github', owner: 'fixture', name: 'project', defaultBranch: 'main' } })
    const mainId = (await pool.query<{ id: string }>(
      'select id from application_installation where singleton=true')).rows[0]!.id
    const store = new PrivateSourceSnapshotStore(canonical)
    vi.spyOn(store, 'storageCapacity').mockImplementation(async () =>
      sourceStorageCapacityFixture({ filesystem: await store.storageIdentity() }))
    const write = store.write.bind(store)
    vi.spyOn(store, 'write').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await resume.promise
      await write(...args)
    })
    const notInvoked = async (): Promise<never> => { throw new Error('No native execution in source capture.') }
    const sources = new PostgresSourceService(pool, commands, locations, store, mainId,
      { authorize: notInvoked, attest: notInvoked, fence: notInvoked },
      { authorize: notInvoked, prepare: notInvoked, verify: notInvoked,
        verifyWorkingDirectory: notInvoked, releaseClaim: notInvoked, authorizeFinal: notInvoked },
      { confirmedClosed: notInvoked })
    // Local Git objects replace network fetches; capture, storage and database services stay real.
    sources.git = { cloneDirectory: () => project, git: async (args, options) => ({ code: 0,
      stdout: (await qualifiedGit(options.cwd ?? project, args)).toString(), stderr: '' }) }
    const approve = vi.spyOn(sources, 'approve')
    const input = { workspaceId, commit, executablePolicy: 'strip' as const }
    captures.push(Promise.allSettled([
      sources.approveProject(owner.principal, { ...input, commandId: randomUUID() }),
    ]))
    await entered.promise
    captures.push(Promise.allSettled(Array.from({ length: 3 }, () =>
      sources.approveProject(owner.principal, { ...input, commandId: randomUUID() }))))
    await expect.poll(() => approve.mock.calls.length, { timeout: 10_000 }).toBe(4)
    // Every waiter has entered approval before the first capture exceeds both SQL timeouts.
    // eslint-disable-next-line no-restricted-syntax -- Hold the first capture past both SQL deadlines.
    await delay(2500)
    resume.resolve()
    const outcomes = (await Promise.all(captures)).flat()
    expect(outcomes.map(result => result.status)).toEqual(Array(4).fill('fulfilled'))
    const approved = outcomes.map(result => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
    expect(new Set(approved.map(source => source.manifest.snapshotId)).size).toBe(1)
    expect(approved.every(source => source.manifest.git?.commit === commit)).toBe(true)
    expect((await sources.list(owner.principal, 'mcp', { workspaceId })).items).toEqual([approved[0]])
    expect((await pool.query('select result from management_command_receipts where operation=$1',
      ['source.approve'])).rows).toHaveLength(4)
    expect((await pool.query('select outcome from management_audit where action=$1',
      ['source.approve'])).rows).toEqual(Array(4).fill({ outcome: 'succeeded' }))

    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { sources, commands, workspaces, locations } as unknown as OperatorServices } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'capture-fixture', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(owner.token)
    const manifest = approved[0]!.manifest
    const read = { workspaceId, approvedSourceId: manifest.approvedSourceId,
      snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
    const response = await client.callTool({ name: 'source_get', arguments: read })
    expect(response.isError).not.toBe(true)
    expect(ApprovedSourceSchema.parse(decodeMcpToolResult(response))).toEqual(approved[0])
    const original = SourceApproveInputSchema.parse(approve.mock.calls[0]![2])
    const replay = await client.callTool({ name: 'source_approve', arguments: original })
    expect(replay.isError).not.toBe(true)
    expect(SourceApproveResultSchema.parse(decodeMcpToolResult(replay)))
      .toEqual({ value: approved[0], replayed: true })
    const denied = await access.issue({ name: 'Out of scope capture fixture', audience: 'operator',
      grants: [{ actions: ['sources:read', 'source_roots:bind', 'workspace_locations:read'],
        scope: { workspaceIds: [randomUUID()] } }] })
    const deniedClient = await connect(denied.token)
    const rejected = await deniedClient.callTool({ name: 'source_approve', arguments: {
      ...original, commandId: randomUUID(),
    } })
    expect(rejected.isError).toBe(true)
    expect(JSON.parse((rejected.content[0] as { text: string }).text).error.code).toBe('ACCESS_DENIED')
    expect((await sources.list(owner.principal, 'mcp', { workspaceId })).items).toEqual([approved[0]])
  } finally {
    resume.resolve()
    await Promise.all(captures)
    vi.restoreAllMocks()
    for (const client of clients) await client.close()
    await app?.close()
    await pool.end()
    await database.close()
  }
}, 60_000)

it('reports a canceled command query as retryable, audits its domain code and accepts the original retry', async () => {
  const database = await migratedDatabase()
  const pool = createTestPool({ ...database.pool.options,
    options: `${database.pool.options.options} -c statement_timeout=100` })
  try {
    const caller = await new PostgresAccessService(database.pool).issue({
      name: 'Timeout fixture', audience: 'operator', grants: [],
    })
    const coordinator = new PostgresCommandCoordinator(pool)
    const input = { principal: caller.principal, source: 'mcp' as const,
      operation: 'fixture.capture', commandId: randomUUID(), targetKey: 'fixture', payload: {} }
    await expect(coordinator.execute({ ...input, perform: async sql => {
      await sql.query('select pg_sleep(1)')
      return { captured: true }
    } })).rejects.toMatchObject({ code: 'COMMAND_DATABASE_TIMEOUT', status: 503,
      details: { retryable: true, newCommandRequired: false, sqlState: '57014' } })
    expect((await database.pool.query('select outcome,details from management_audit where principal_id=$1',
      [caller.principal.id])).rows).toEqual([{
      outcome: 'failed', details: { commandId: input.commandId, code: 'COMMAND_DATABASE_TIMEOUT' },
    }])
    expect((await database.pool.query('select result from management_command_receipts where principal_id=$1',
      [caller.principal.id])).rows).toEqual([])
    await expect(coordinator.execute({ ...input, perform: async () => ({ captured: true }) }))
      .resolves.toEqual({ value: { captured: true }, replayed: false })
  } finally {
    await pool.end()
    await database.close()
  }
}, 60_000)
