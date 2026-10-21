import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { PostgresSourceService } from '../src/modules/sources/service.js'
import type { RegisteredSourceRootPort } from '../src/modules/sources/admissionPorts.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { qualifiedGit } from '../src/modules/sources/capture.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

// Passive timings around the actual Git calls; no output consumer, process, pipe or deadline is substituted.
const metrics = vi.hoisted(() => ({ active: false, gitMs: {} as Record<string, number>, gitCalls: {} as Record<string, number>, batchReadWaitMs: 0, hashMs: 0, sqlMs: 0, sqlCalls: 0, snapshotInsertMs: 0, snapshotInserts: 0 }))
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, createHash: (...args: Parameters<typeof actual.createHash>) => {
    const hash = actual.createHash(...args)
    for (const name of ['update', 'digest'] as const) {
      const method = hash[name]
      Reflect.set(hash, name, (...input: unknown[]) => { const start = performance.now(); try { return Reflect.apply(method, hash, input) } finally { if (metrics.active) metrics.hashMs += performance.now() - start } })
    }
    return hash
  } }
})
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>(), { promisify } = await import('node:util')
  const execute = promisify(actual.execFile)
  const execFile = (...args: unknown[]) => Reflect.apply(actual.execFile, undefined, args)
  Reflect.set(execFile, promisify.custom, async (...args: Parameters<typeof execute>) => {
    const start = performance.now(), command = (args[1] as string[]).find(value => ['rev-parse', 'cat-file', 'ls-tree'].includes(value)) ?? 'other'
    const key = command === 'cat-file' ? `cat-file-${(args[1] as string[])[(args[1] as string[]).indexOf(command) + 1]}` : command
    try { return await execute(...args) }
    finally { if (metrics.active) { metrics.gitMs[key] = (metrics.gitMs[key] ?? 0) + performance.now() - start; metrics.gitCalls[key] = (metrics.gitCalls[key] ?? 0) + 1 } }
  })
  const spawn = (...args: unknown[]) => {
    const child = Reflect.apply(actual.spawn, undefined, args) as ReturnType<typeof actual.spawn>
    if (Array.isArray(args[1]) && args[1].includes('--batch') && child.stdout) {
      const stream = child.stdout, iterator = stream[Symbol.asyncIterator].bind(stream)
      stream[Symbol.asyncIterator] = () => {
        const result = iterator(), next = result.next.bind(result)
        result.next = async (...input) => { const start = performance.now(); try { return await next(...input) } finally { if (metrics.active) metrics.batchReadWaitMs += performance.now() - start } }
        return result
      }
    }
    return child
  }
  return { ...actual, execFile, spawn }
})

it.skipIf(!postgresEnabled)('profiles complete repository approval through real HTTP/MCP with constant SQL publication and persisted readback', async () => {
  const db = await currentDatabase(), clients: Client[] = []
  const directory = await mkdtemp(`${process.env.FOREMAN_CODE_TEST_ROOT}/entrypoints-source-profile-`)
  const storage = join(directory, 'state', 'runtime', 'main', 'canonical', 'source-snapshots')
  await mkdir(storage, { recursive: true, mode: 0o700 })
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  const root = join(await realpath(directory), 'repository')
  const excluded = new Set(['.git', 'node_modules', 'dist', '.logs', '.cache', '.vite'])
  await cp(repository, root, { recursive: true,
    filter: path => !relative(repository, path).split(sep).some(part => excluded.has(part)) })
  await qualifiedGit(root, ['init', '-q'])
  await qualifiedGit(root, ['add', '.'])
  await qualifiedGit(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-qm', 'Source approval fixture'])
  const commit = (await qualifiedGit(root, ['rev-parse', 'HEAD'])).toString().trim()
  const lsTreeStart = performance.now()
  const approvedPaths = (await qualifiedGit(root, ['ls-tree', '-r', '--name-only', '-z', commit])).toString().split('\0').filter(Boolean)
  const lsTreeMs = performance.now() - lsTreeStart
  const commands = new PostgresCommandCoordinator(db.pool), access = new PostgresAccessService(db.pool)
  const locations = new WorkspaceLocationService(db.pool, commands, join(directory, 'runtime'), 'runner-local')
  const workspaces = new WorkspaceManagementService(db.pool, commands, locations)
  const owner = await access.issue({ name: 'Profile owner', audience: 'operator', grants: [{ actions: ManagementActionSchema.options, scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
  const created = await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Actual repository approval' })
  const workspaceId = created.value.workspace.id
  const located = await locations.set(owner.principal, 'http', { workspaceId, commandId: randomUUID(), expectedLocationRevision: created.value.locationRevision, runnerId: locations.runnerId, rootPath: root })
  const mainId = (await db.pool.query('select id from application_installation')).rows[0].id
  const store = new PrivateSourceSnapshotStore(storage), write = store.write.bind(store), publish = store.commit.bind(store)
  const stages = { privateWriteMs: 0, privateCommitMs: 0, entriesWritten: 0, bytesWritten: 0, totalMs: 0 }
  vi.spyOn(store, 'write').mockImplementation(async (...args) => { const start = performance.now(); try { await write(...args); stages.entriesWritten++; stages.bytesWritten += args[2].byteLength } finally { stages.privateWriteMs += performance.now() - start } })
  vi.spyOn(store, 'commit').mockImplementation(async manifest => { const start = performance.now(); try { await publish(manifest) } finally { stages.privateCommitMs += performance.now() - start } })
  const unavailable = async (): Promise<never> => { throw new Error('Root binding and native execution are outside source approval.') }
  const service = new PostgresSourceService(db.pool, commands, locations, store, mainId, {} as RegisteredSourceRootPort,
    { authorize: unavailable, prepare: unavailable, verifyWorkingDirectory: unavailable, verify: unavailable, releaseClaim: unavailable, authorizeFinal: unavailable }, { confirmedClosed: unavailable })
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, workspaces, locations, sources: service } as unknown as OperatorServices } })
  const query = pg.Client.prototype.query
  vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
    const active = metrics.active, start = performance.now(), snapshot = typeof args[0] === 'string' && args[0].startsWith('insert into source_snapshots')
    const finished = () => { if (active) { metrics.sqlCalls++; metrics.sqlMs += performance.now() - start; if (snapshot) { metrics.snapshotInserts++; metrics.snapshotInsertMs += performance.now() - start } } }
    const last = args.at(-1)
    if (typeof last === 'function') args[args.length - 1] = (...values: unknown[]) => { finished(); Reflect.apply(last, undefined, values) }
    const result = Reflect.apply(query, this, args)
    if (result instanceof Promise) void result.then(finished, finished)
    return result
  } as typeof query)
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 }), headers = { authorization: `Bearer ${owner.token}` }
    const input = { workspaceId, commandId: randomUUID(), expectedLocationRevision: located.value.locationRevision, commit, executablePolicy: 'preserve-approved' }
    metrics.active = true; const start = performance.now()
    const response = await app.inject({ method: 'POST', url: `/api/management/workspaces/${workspaceId}/sources/approve`, headers, payload: input })
    stages.totalMs = performance.now() - start; metrics.active = false
    process.stdout.write(`${JSON.stringify({ sourceApprovalProfile: { commit, paths: approvedPaths.length, lsTreeMs, ...stages, ...metrics, status: response.statusCode } })}\n`)
    expect(response.statusCode, response.body).toBe(200)
    const result = response.json()
    expect(result.value.manifest.entries.map((entry: { path: string }) => entry.path)).toEqual([...approvedPaths].sort())
    const client = new Client({ name: 'Source approval profile', version: '1' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => owner.token } }))
    const retry = await client.callTool({ name: 'source_approve', arguments: input })
    expect(retry.isError, JSON.stringify(retry.content)).not.toBe(true); expect(decodeMcpToolResult(retry)).toEqual({ ...result, replayed: true })
    expect((await db.pool.query('select record from source_snapshots')).rows).toEqual([{ record: result.value }])
    expect(metrics.snapshotInserts).toBe(1); expect(metrics.sqlCalls).toBeLessThan(75)
    const denied = await access.issue({ name: 'Denied profile caller', audience: 'operator', grants: [{ actions: ['sources:read', 'source_roots:bind', 'workspace_locations:read'], scope: { workspaceIds: ['foreign'] } }], expiresAt: new Date(Date.now() + 600_000) })
    const deniedClient = new Client({ name: 'Denied source profile', version: '1' }); clients.push(deniedClient)
    await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => denied.token } }))
    expect((await deniedClient.callTool({ name: 'source_approve', arguments: { ...input, commandId: randomUUID() } })).isError).toBe(true)
    expect(stages.totalMs).toBeLessThan(20_000)
    for (const transport of ['http', 'mcp'] as const) {
      const controller = new AbortController(), timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal)
      const fault = vi.spyOn(store, 'write').mockImplementation(async (...args) => {
        await write(...args); controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      })
      const interrupted = { ...input, commandId: randomUUID() }
      try {
        if (transport === 'http') {
          const failed = await app.inject({ method: 'POST', url: `/api/management/workspaces/${workspaceId}/sources/approve`, headers, payload: interrupted })
          expect(failed.statusCode, failed.body).toBe(503)
          expect(failed.json().error).toMatchObject({ code: 'SOURCE_CAPTURE_TIMEOUT', details: { retryable: true, newCommandRequired: true } })
        } else {
          const failed = await client.callTool({ name: 'source_approve', arguments: interrupted })
          expect(failed.isError).toBe(true)
          expect(JSON.parse((failed.content[0] as { text: string }).text)).toMatchObject({ error: { code: 'SOURCE_CAPTURE_TIMEOUT', details: { retryable: true, newCommandRequired: true } } })
        }
        expect(timeout).toHaveBeenCalledWith(300_000)
        const row = (await db.pool.query('select state from source_approvals where command_id=$1', [interrupted.commandId])).rows[0]
        expect(row.state).toBe('failed')
        expect((await db.pool.query('select count(*)::int as count from source_snapshots')).rows[0].count).toBe(1)
        const replay = await client.callTool({ name: 'source_approve', arguments: interrupted })
        expect(replay.isError).toBe(true); expect(JSON.parse((replay.content[0] as { text: string }).text)).toMatchObject({ error: { code: 'SOURCE_CAPTURE_FAILED' } })
      } finally { fault.mockRestore(); timeout.mockRestore() }
    }
  } finally { metrics.active = false; await Promise.allSettled(clients.map(client => client.close())); await app.close(); vi.restoreAllMocks(); await db.close(); await removeFixtureDirectory(directory) }
}, 60_000)
