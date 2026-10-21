import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './testResources.js'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { expect } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { AgentConfigurationVersionSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { ManagementActionSchema, ManagedAgentDefaultsSchema, WorkspaceLocationSetResultSchema } from '@foreman-code/contracts/management'
import { ManualRunStartResultSchema, SavedRunDetailsSchema, WorkflowVersionV3Schema, makeCurrentWorkflowFixture, type CurrentFixtureForm } from '@foreman-code/contracts/wave25'
import { LOCAL_RUNNER_ID } from '../../src/modules/workspaces/location.js'
import { loadConfig } from '../../src/config.js'
import { createCheckpointStore } from '../../src/infrastructure/checkpoints.js'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { buildProductionApp } from '../../src/production.js'
import { ActivityProductionReplay } from './activityProductionReplay.js'
import { createActivityReplayFileStorage, createActivityReplayWorkspace, startActivityReplayProduction } from './activityReplayLifecycle.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { agent3Database, seedAgent3 } from './wave25Agent3.js'
import { agentWorkflowVersion } from './agentWorkflowFixture.js'

const closes: Array<() => Promise<void>> = []
export async function eventStream(url: string, token: string) {
  const controller = new AbortController()
  const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: controller.signal })
  if (!response.ok || !response.body) throw new Error('Authorized production SSE did not open.')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffered = ''
  const queued: Array<Record<string, unknown>> = []
  const close = async () => {
    controller.abort()
    await reader.cancel().catch(() => {
      // ignore: aborting the fetch can already have errored the stream being canceled.
    })
  }
  closes.push(close)
  const next = async (accept: (event: Record<string, unknown>) => boolean) => {
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      for (;;) {
        while (queued.length) { const event = queued.shift()!; if (accept(event)) return event }
        const part = await reader.read()
        if (part.done) throw new Error('Production SSE ended before the expected committed projection.')
        buffered += decoder.decode(part.value, { stream: true })
        let end: number
        while ((end = buffered.indexOf('\n\n')) >= 0) {
          const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2)
          const data = frame.split('\n').find((line) => line.startsWith('data: '))
          if (data) queued.push(JSON.parse(data.slice(6)) as Record<string, unknown>)
        }
      }
    } finally { clearTimeout(timer) }
  }
  return { next, close }
}
export async function closeActivityReplay() {
  while (closes.length) await closes.pop()!()
}
export async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = await read()
    if (accepts(value)) return value
    if (Date.now() >= deadline) throw new Error('Production persisted readback did not reach the recorded fixture state.')
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback replay port.')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}
export async function setup(options: { operatorSandbox?: 'read-only' | 'workspace-write'; form?: CurrentFixtureForm; handoffs?: boolean; approvalPolicy?: 'on-request' } = {}) {
  const db = await agent3Database(); closes.push(db.close)
  const directory = await privateFixtureDirectory('activity-replay-workspace-')
  closes.push(() => removeFixtureDirectory(directory))
  const workspace = await createActivityReplayWorkspace(directory)
  const databaseUrl = new URL(db.databaseUrl)
  databaseUrl.searchParams.set('options', `-c search_path=${db.schema}`)
  const config = loadConfig({ DATABASE_URL: databaseUrl.toString(), HARNESS_WORKSPACE_ROOT: workspace.harnessWorkspaceRoot,
    PORT: String(await freePort()), CODEX_BINARY: '/recorded-no-native-codex',  })
  config.workspaceStorageRoot = workspace.workspaceStorageRoot
  config.fileStorageRoot = await createActivityReplayFileStorage()
  closes.push(() => removeFixtureDirectory(config.fileStorageRoot!))
  const cpSchema = `${db.schema}_cp`
  await createFixtureSchema(db.pool, cpSchema)
  const checkpoints = createCheckpointStore(config.database.connectionString, cpSchema, config.database)
  await checkpoints.setup()
  closes.push(async () => { await checkpoints.close(); await dropFixtureSchema(db.pool, cpSchema) })
  const seed = makeCurrentWorkflowFixture(randomUUID(), options.form ?? 'single')
  if (options.handoffs) seed.version = agentWorkflowVersion(WorkflowVersionV3Schema.parse({ ...seed.version,
    definition: { ...seed.version.definition, handoffs: { contractVersion: 1 } } }))
  seed.configurations = seed.configurations.map((configuration) => AgentConfigurationVersionSchema.parse({ ...configuration,
    harness: { harness: 'codex', model: 'test-model', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard',
      ...(options.approvalPolicy ? { advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: options.approvalPolicy } } : {}),
    } }))
  const saved = await seedAgent3(db.pool, workspace.workingDirectory, seed, { run: false })
  const access = new PostgresAccessService(db.pool)
  const writer = await access.issue({ name: 'W05 production fixture writer', audience: 'operator',
    expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
  const denied = await access.issue({ name: 'W05 denied scope', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
    grants: [{ actions: ['agent_chat:read', 'agent_chat:respond', 'runs:read'], scope: { workspaceIds: ['different-workspace'] } }] })
  const replay = new ActivityProductionReplay()
  const database = { pool: db.pool, ping: async () => { await db.pool.query('select 1') },
    migrate: () => applyApplicationMigrations(db.pool), close: async () => {} }
  const infrastructure = replay.infrastructure(join(workspace.harnessWorkspaceRoot, 'native-process-registry'))
  let production = buildProductionApp(config, database, checkpoints, false, undefined, undefined, undefined, infrastructure)
  let origin = await startActivityReplayProduction(production, replay, closes, config.port)
  const headers = { authorization: `Bearer ${writer.token}` }
  async function http(method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>, token = writer.token) {
    const response = await production.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload !== undefined ? { payload } : {}) })
    return response
  }
  async function call(name: string, args: Record<string, unknown>, token = writer.token) {
    const client = new Client({ name: 'W05 actual production replay', version: '1' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), { authProvider: { token: async () => token } }))
      return await client.callTool({ name, arguments: args })
    } finally { await client.close() }
  }
  // Replace the seed's synthetic location with the real producer's canonical identity.
  const located = await http('PUT', `/api/management/workspaces/${saved.scope.workspaceId}/location`, {
    commandId: randomUUID(), expectedLocationRevision: 1, runnerId: LOCAL_RUNNER_ID, rootPath: workspace.workingDirectory,
  })
  expect(located.statusCode, located.body).toBe(200)
  const location = WorkspaceLocationSetResultSchema.parse(located.json()).value
  const defaults = ManagedAgentDefaultsSchema.parse((await http('GET', '/api/management/settings/agents')).json())
  const changed = await http('PUT', '/api/management/settings/agents', { commandId: randomUUID(), expectedRevision: defaults.revision,
    value: { ...defaults.value, operator: { ...defaults.value.operator,
      harness: { harness: 'codex', model: 'test-model', reasoningEffort: 'low', sandbox: options.operatorSandbox ?? 'read-only', serviceTier: 'standard' } } } })
  expect(changed.statusCode, changed.body).toBe(200)
  async function restart() {
    await production.shutdown()
    production = buildProductionApp(config, database, checkpoints, false, undefined, undefined, undefined, infrastructure)
    origin = await startActivityReplayProduction(production, replay, closes, config.port)
  }
  return { db, saved, location, access, writer, denied, replay, headers, http, call, restart, reconcile: () => production.reconcile((error) => { throw error }), get origin() { return origin } }
}

export async function admittedRun(f: Awaited<ReturnType<typeof setup>>, mode: 'complete' | 'approval' = 'complete') {
  const row = (await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [f.saved.scope.workflowId])).rows[0]!
  f.replay.nextStart = mode
  const response = await f.http('POST', `/api/management/workspaces/${f.saved.scope.workspaceId}/workflows/${f.saved.scope.workflowId}/runs`, {
    workflowVersionId: f.saved.version.id, commandId: randomUUID(), executionSemanticsVersion: 3,
    expectedWorkflowRevision: Number(row.revision), expectedAgentConfigurationVersionIds: f.saved.version.agentConfigurationVersionIds,
    expectedLocationRevision: f.location.locationRevision, input: {},
  })
  expect(response.statusCode, response.body).toBe(202)
  return ManualRunStartResultSchema.parse(response.json())
}
export async function completedRun(f: Awaited<ReturnType<typeof setup>>) {
  const starts = f.replay.starts.length
  const started = await admittedRun(f)
  let nextReconciliation = Date.now() + 5_000
  const detail = await eventually(async () => {
    // The server retries pending native settlement every five seconds; GET is a passive snapshot read.
    if (Date.now() >= nextReconciliation) {
      nextReconciliation = Date.now() + 5_000
      await f.reconcile()
    }
    const response = await f.http('GET',
      `/api/management/workspaces/${f.saved.scope.workspaceId}/runs/${started.run.id}`)
    expect(response.statusCode, response.body).toBe(200)
    const result = SavedRunDetailsSchema.parse(response.json())
    expect(result.run.outcome, JSON.stringify(result.executions.map(execution => execution.result))).not.toBe('failed')
    return result
  }, (result) => result.run.outcome === 'succeeded' && result.cleanupPending === false
    && result.activity.some((event) => event.kind === 'run_cleanup_checked' && event.payload.failed === false))
  expect(detail.executions).toHaveLength(f.saved.version.definition.nodes.length)
  expect(f.replay.starts.slice(starts)).toHaveLength(detail.executions.length)
  return detail
}
