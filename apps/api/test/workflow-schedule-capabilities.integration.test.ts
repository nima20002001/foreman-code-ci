import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ScheduleGetResultSchema } from '@foreman-code/contracts/schedules'
import { buildApp } from '../src/app.js'
import type { ApiConfig } from '../src/config.js'
import { createCheckpointStore, type CheckpointStore } from '../src/infrastructure/checkpoints.js'
import { ScheduleOperatorCapabilitiesSchema } from '../src/mcp/operator/tools/workflowSchedules.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { buildProductionApp } from '../src/production.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { sch11Once } from './helpers/sch11ClockCases.js'
import { sch11DomainState, sch11Fixture, type Sch11Database, type Sch11Fixture } from './helpers/sch11Fixture.js'

// Discovery must use the actual production Run service and schedule lifecycle,
// not a boolean capability stub or a SQL fixture posing as a native binding.
// Do not initialize native ownership or launch providers: the genuine production
// composition must report timed admission as configured but currently paused.
describe.skipIf(!postgresEnabled)('SCH-03 authenticated schedule capability composition', () => {
  let database: Sch11Database
  let f: Sch11Fixture
  let app: ReturnType<typeof buildApp> | undefined
  let checkpoints: CheckpointStore | undefined
  let clients: Client[] = []
  beforeAll(async () => { database = await agent3Database() }, 60_000)
  afterAll(async () => { await database?.close() })
  beforeEach(async () => {
    clients = []; app = undefined; checkpoints = undefined
    f = await sch11Fixture(database)
  }, 60_000)
  afterEach(async () => {
    await Promise.allSettled(clients.map((client) => client.close()))
    try { await app?.close() } finally { await checkpoints?.close() }
  }, 30_000)

  it.each(['production', 'persistence-only'] as const)('SCH-03: %s discovery matches its composition and preserves grants/readback', async (composition) => {
    const saved = await f.save({ ...sch11Once, localDate: '2099-01-01' })
    if (composition === 'production') {
      const config: ApiConfig = {
        host: '127.0.0.1', port: 3000, readinessTimeoutMs: 2_000,
        workspaceStorageRoot: f.projectRoot,
        database: { connectionString: process.env.TEST_DATABASE_URL!, maxConnections: 2,
          connectionTimeoutMs: 5_000, queryTimeoutMs: 1_000 },
        checkpoints: { schema: database.schema },
        harnesses: { workspaceRoot: f.runtimeRoot, timeoutMs: 1_000,
          codexBinary: join(database.directory, 'unavailable-codex'),
           },
      }
      checkpoints = createCheckpointStore(config.database.connectionString, config.checkpoints.schema, config.database)
      // agent3Database already ran the registered migrations on its guarded,
      // isolated schema. Its pool remains owned by the shared fixture.
      app = buildProductionApp(config, {
        pool: database.pool, ping: async () => { await database.pool.query('select 1') },
        migrate: async () => {}, close: async () => {},
      }, checkpoints, false).app
    } else {
      app = buildApp({ readiness: { database: { ping: async () => { await database.pool.query('select 1') } },
        checkpoints: { ping: async () => {} } },
      operator: { access: f.access, services: { workflows: f.workflows, commands: f.commands } as unknown as OperatorServices } })
    }
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'schedule-capability-review', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }))
      return client
    }
    const owner = await connect(f.writer.token), reader = await connect(f.reader.token)
    const before = await sch11DomainState(f)
    for (const [client, principal] of [[owner, f.writer.principal], [reader, f.reader.principal]] as const) {
      const result = await client.callTool({ name: 'operator_get_capabilities', arguments: { ...f.scope, detail: 'full' } })
      expect(result.isError).not.toBe(true)
      const capabilities = ScheduleOperatorCapabilitiesSchema.parse(decodeMcpToolResult(result))
      expect(capabilities.grants).toEqual(principal.grants)
      expect(capabilities.tools).toContain('workflow_schedule_get')
      expect(capabilities.tools.includes('workflow_schedule_save')).toBe(client === owner)
      const limits = capabilities.runtimeLimits ?? []
      const delivery = limits.find((limit) => limit.feature === 'schedule_delivery')
      const persistence = limits.find((limit) => limit.feature === 'schedule_persistence')
      expect(persistence?.state).toBe('limited')
      if (composition === 'production') {
        expect(delivery).toMatchObject({ state: 'limited' })
        expect(delivery?.detail).toContain('same pinned Start and engine')
        expect(delivery?.detail).toContain('latest due occurrence within five minutes')
        expect(delivery?.detail).toContain('skips overlapping scheduled Runs')
        expect(delivery?.detail).toContain('pins the latest saved workflow')
        expect(delivery?.detail).toContain('paused until native runtime readiness returns')
        expect(persistence?.detail).toContain('Timed Run admission is composed')
        const details = limits.map((limit) => limit.detail).join('\n')
        expect(details).not.toContain('No dispatcher or timed Run admission is included')
        expect(details).not.toContain('no scheduled or event Start is promised')
      } else {
        expect(delivery).toMatchObject({ state: 'unsupported' })
        expect(persistence?.detail).toContain('persistence-only composition has no dispatcher or timed Run admission')
      }
      const readback = await client.callTool({ name: 'workflow_schedule_get', arguments: f.scope })
      expect(readback.isError).not.toBe(true)
      expect(ScheduleGetResultSchema.parse(decodeMcpToolResult(readback))).toEqual({ schedule: saved })
    }
    const denied = await reader.callTool({ name: 'workflow_schedule_disable', arguments: f.command() })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await sch11DomainState(f)).toEqual(before)
    expect(await f.countRuns()).toBe(0)
  }, 60_000)
})
