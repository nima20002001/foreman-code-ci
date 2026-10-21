import { execFile } from 'node:child_process'
import { chmod, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { DEFAULT_REMOTE_EXECUTION_SETTINGS, ManagedRemoteExecutionSettingsSchema,
  RemoteExecutionSettingsUpdateResultSchema, type RemoteExecutionSettings } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { ProductionDeviceRuntime } from '../src/modules/devices/productionRuntime.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { RemoteExecutionSettingsService } from '../src/modules/settings/remoteExecution.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

const execute = promisify(execFile)
async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No listener port was allocated.')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}
async function identity(port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body: Record<string, unknown> | undefined
    const request = httpsRequest({ host: '127.0.0.1', port, path: '/device/identity', rejectUnauthorized: false, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.once('error', reject)
      response.once('end', () => { body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> })
    })
    request.once('error', reject)
    request.once('socket', socket => socket.once('close', () => {
      if (body) resolve(body)
      else reject(new Error('Listener identity request closed before a response.'))
    }))
    request.end()
  })
}
async function holdConnection(port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => resolve(socket))
    socket.once('error', reject)
  })
}

it('saves listener settings through MCP, applies startup and idle restarts, and defers connected changes', async () => {
  const database = await currentDatabase()
  const runtime = new ProductionDeviceRuntime(database.pool)
  const restartedRuntime = new ProductionDeviceRuntime(database.pool)
  const clients: Client[] = []
  let held: TLSSocket | undefined
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const certificateFile = join(database.directory, 'cert.pem')
    const privateKeyFile = join(database.directory, 'key.pem')
    await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', privateKeyFile, '-out', certificateFile])
    await chmod(certificateFile, 0o600)
    await chmod(privateKeyFile, 0o600)
    const firstPort = await unusedPort()
    const secondPort = await unusedPort()
    const commands = new PostgresCommandCoordinator(database.pool)
    const repository = new PostgresFoundationSettingsRepository(database.pool)
    const access = new PostgresAccessService(database.pool)
    const workerExecution = new WorkerExecutionPolicy()
    const reported: unknown[] = []
    const remoteExecution = new RemoteExecutionSettingsService(repository, commands, workerExecution, runtime,
      {}, 3000, error => reported.push(error))
    const mainId = (await database.pool.query('select id from application_installation')).rows[0].id as string
    await remoteExecution.initialize()
    await runtime.initialize(mainId)
    await runtime.startListener()
    const services = { remoteExecution, workerExecution, commands } as unknown as OperatorServices
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const owner = await access.issue({ name: 'Listener owner', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
    const reader = await access.issue({ name: 'Listener reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['settings:read'], scope: {} }] })
    const connect = async (token: string) => {
      const client = new Client({ name: 'Listener settings', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(owner.token)
    const denied = await connect(reader.token)
    const value: RemoteExecutionSettings = { enabled: true, listener: {
      enabled: true, host: '127.0.0.1', port: firstPort, certificateFile, privateKeyFile,
      advertisedEndpoint: `wss://127.0.0.1:${firstPort}/device/connect`, trustCertificateFile: null,
    } }
    const input = { value, expectedRevision: 0, commandId: randomUUID() }
    expect((await denied.callTool({ name: 'remote_execution_settings_update', arguments: input })).isError).toBe(true)
    const save = async (settings: RemoteExecutionSettings, expectedRevision: number) =>
      RemoteExecutionSettingsUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({
        name: 'remote_execution_settings_update', arguments: { value: settings, expectedRevision, commandId: randomUUID() },
      })))
    const saved = await save(value, 0)
    expect(saved).toMatchObject({ value: { value, revision: 1 }, runtime: { listenerEnabled: true, restartRequired: false } })
    expect(await identity(firstPort)).toMatchObject({ mainId })
    const endpoint = runtime.endpointForDomains()
    const next = { ...value, listener: { ...value.listener, port: secondPort,
      advertisedEndpoint: `wss://127.0.0.1:${secondPort}/device/connect` } }
    const moveInput = { value: next, expectedRevision: 1, commandId: randomUUID() }
    // Reuse the command while the preceding identity request's socket finishes closing.
    await expect.poll(async () => RemoteExecutionSettingsUpdateResultSchema.parse(decodeMcpToolResult(
      await client.callTool({ name: 'remote_execution_settings_update', arguments: moveInput }),
    )).runtime.restartRequired).toBe(false)
    expect(await identity(secondPort)).toMatchObject({ mainId })
    expect(runtime.endpointForDomains()).toBe(endpoint)
    held = await holdConnection(secondPort)
    const revision = (await repository.getRemoteExecutionSettings()).revision
    const disabled = { ...next, listener: { ...next.listener, enabled: false } }
    const deferred = await save(disabled, revision)
    expect(deferred.runtime).toMatchObject({ listenerEnabled: true, restartRequired: true, reason: 'computers-connected' })
    const readback = ManagedRemoteExecutionSettingsSchema.parse(decodeMcpToolResult(await denied.callTool({
      name: 'remote_execution_settings_get', arguments: {},
    })))
    expect(readback).toMatchObject({ value: disabled, effective: disabled,
      runtime: { listenerEndpoint: next.listener.advertisedEndpoint, restartRequired: true } })
    held.destroy()
    held = undefined
    await runtime.drain()
    const restartedPolicy = new WorkerExecutionPolicy()
    const restartedSettings = new RemoteExecutionSettingsService(repository, commands, restartedPolicy, restartedRuntime,
      {}, 3000, error => reported.push(error))
    await restartedSettings.initialize()
    await restartedRuntime.initialize(mainId)
    await restartedRuntime.startListener()
    expect(await restartedSettings.read(reader.principal)).toMatchObject({ value: disabled,
      runtime: { listenerEnabled: false, restartRequired: false } })
    expect(restartedPolicy.read(reader.principal)).toEqual({ enabled: true, managedBy: 'settings' })
    expect(reported).toEqual([])
  } finally {
    held?.destroy()
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    await Promise.all([runtime.drain(), restartedRuntime.drain()])
    await database.close()
  }
}, 30_000)

it('rejects shared or symlinked TLS paths before persisting an Operator update', async () => {
  const database = await currentDatabase()
  try {
    const access = new PostgresAccessService(database.pool)
    const owner = await access.issue({ name: 'TLS owner', audience: 'operator', expiresAt: new Date(Date.now() + 300000),
      grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
    const settings = new RemoteExecutionSettingsService(new PostgresFoundationSettingsRepository(database.pool),
      new PostgresCommandCoordinator(database.pool), new WorkerExecutionPolicy(), {
        configureListener: async () => true,
        listenerStatus: () => ({ listenerEnabled: false, listenerEndpoint: null, restartRequired: false, reason: null }),
      }, {}, 3000, error => { throw error })
    const key = join(database.directory, 'private.key')
    const alias = join(database.directory, 'alias.key')
    await writeFile(key, 'private test bytes', { mode: 0o644 })
    await symlink(key, alias)
    for (const path of [key, alias]) {
      await expect(settings.update(owner.principal, 'mcp', {
        value: { ...DEFAULT_REMOTE_EXECUTION_SETTINGS,
          listener: { ...DEFAULT_REMOTE_EXECUTION_SETTINGS.listener, privateKeyFile: path } },
        expectedRevision: 0, commandId: randomUUID(),
      })).rejects.toMatchObject({ code: 'REMOTE_EXECUTION_SETTINGS_INVALID' })
    }
    expect(await settings.read(owner.principal)).toMatchObject({ revision: 0, value: DEFAULT_REMOTE_EXECUTION_SETTINGS })
  } finally { await database.close() }
}, 30_000)

it('keeps committed settings and reports a live listener failure for correction or retry', async () => {
  const database = await currentDatabase()
  try {
    const access = new PostgresAccessService(database.pool)
    const owner = await access.issue({ name: 'Listener recovery owner', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
    const failure = new Error('Listener restart failed.')
    let fail = true
    const errors: unknown[] = []
    const settings = new RemoteExecutionSettingsService(new PostgresFoundationSettingsRepository(database.pool),
      new PostgresCommandCoordinator(database.pool), new WorkerExecutionPolicy(), {
        configureListener: async () => {
          if (fail) throw failure
          return true
        },
        listenerStatus: () => ({ listenerEnabled: false, listenerEndpoint: null, restartRequired: false, reason: null }),
      }, {}, 3000, error => errors.push(error))
    const input = { value: { ...DEFAULT_REMOTE_EXECUTION_SETTINGS, enabled: true },
      expectedRevision: 0, commandId: randomUUID() }
    const saved = await settings.update(owner.principal, 'mcp', input)
    expect(saved).toMatchObject({ value: { revision: 1, value: input.value },
      runtime: { restartRequired: true, reason: 'listener-start-failed' } })
    expect(await settings.read(owner.principal)).toMatchObject({ value: input.value, revision: 1,
      runtime: { restartRequired: true, reason: 'listener-start-failed' } })
    expect(errors).toEqual([failure])
    fail = false
    expect(await settings.update(owner.principal, 'mcp', input)).toMatchObject({ replayed: true,
      value: { revision: 1 }, runtime: { restartRequired: false, reason: null } })
  } finally { await database.close() }
}, 30_000)
