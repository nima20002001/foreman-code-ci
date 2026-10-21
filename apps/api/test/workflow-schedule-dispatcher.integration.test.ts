import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ManagementGrant } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { ScheduleSaveResultSchema, type ScheduleConfiguration } from '@foreman-code/contracts/schedules'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { PostgresScheduleDispatcher, type ScheduledStart } from '../src/modules/schedules/postgresDispatcher.js'
import { WorkflowScheduleService } from '../src/modules/schedules/service.js'
import { ScheduleOccurrencePageSchema } from '../src/modules/schedules/transportSchemas.js'
import { LOCAL_RUNNER_ID, WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { rejectableDeferred } from './helpers/deferred.js'

const settings = { timezone: 'UTC', enabled: true, policy: 'latest_saved' as const }
const once: ScheduleConfiguration = { ...settings, mode: 'once', localDate: '2030-01-07', time: '10:00' }
const weekly: ScheduleConfiguration = { ...settings, mode: 'weekly', weekdays: [1], time: '10:00' }
const interval: ScheduleConfiguration = { ...settings, mode: 'interval', every: 1, unit: 'minute', anchorAt: '2030-01-07T09:00:00.000Z' }
const actions: ManagementGrant['actions'] = ['workflows:create', 'workflows:read', 'workflows:update',
  'graph:read', 'graph:edit', 'graph:save', 'agents:read', 'workspace_locations:read',
  'skills:read', 'harnesses:update', 'runs:start', 'runs:read', 'capabilities:read']

/** Independent real SQL sessions + the REAL manual durable admission and G1
 * publisher. No fake Run inserts, native harness, model calls, wall-clock sleeps,
 * public/shared database, or production authentication bypass. */
describe.skipIf(!postgresEnabled)('SCH-04 PostgreSQL dispatcher / common Start', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let access: PostgresAccessService
  let commands: PostgresCommandCoordinator
  let service: WorkflowScheduleService
  let workflows: WorkflowManagementService
  let locations: WorkspaceLocationService
  let writer: Awaited<ReturnType<PostgresAccessService['issue']>>
  let reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  let fixture: Awaited<ReturnType<typeof seedAgent3>>
  let scope: { workspaceId: string; workflowId: string }
  let now: string
  let realStart: ScheduledStart

  beforeAll(async () => {
    database = await agent3Database() // includes registered migrations 270203 + 270204
    access = new PostgresAccessService(database.pool)
    commands = new PostgresCommandCoordinator(database.pool)
    workflows = new WorkflowManagementService(database.pool, commands)
  }, 60_000)
  afterAll(async () => { await database?.close() })
  beforeEach(async () => {
    now = '2030-01-07T09:00:00.000Z'
    const projectRoot = join(database.directory, 'projects'), runtimeRoot = join(database.directory, 'runtime')
    const directory = join(projectRoot, randomUUID())
    await Promise.all([mkdir(directory, { recursive: true }), mkdir(runtimeRoot, { recursive: true })])
    fixture = await seedAgent3(database.pool, directory, makeCurrentWorkflowFixture(randomUUID()), { run: false })
    scope = { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId }
    // Upgrade the helper's explicitly synthetic directory identity to real
    // filesystem evidence; common Start's real location validation is retained.
    const identity = await stat(directory, { bigint: true })
    await database.pool.query('update workspaces set execution_location_identity=$2::jsonb where id=$1',
      [scope.workspaceId, JSON.stringify({ device: String(identity.dev), inode: String(identity.ino) })])
    locations = new WorkspaceLocationService(database.pool, commands, runtimeRoot, LOCAL_RUNNER_ID)
    writer = await issue(actions)
    reader = await issue(['workflows:read', 'capabilities:read'])
    service = new WorkflowScheduleService(database.pool, commands, () => new Date(now))
    realStart = startUsing(database.pool)
  }, 60_000)
  function issue(granted: ManagementGrant['actions']) {
    return access.issue({ name: 'SCH-04 synthetic human', audience: 'operator', expiresAt: new Date(Date.now() + 3_600_000),
      grants: [{ actions: granted, scope: { workspaceIds: [scope.workspaceId] } }] })
  }
  function startUsing(pool: pg.Pool): ScheduledStart {
    return async (principal, input, schedule) => {
      await admitRepeatRun(pool, locations, principal, 'schedule', input, repeatStartPublication, { schedule })
    }
  }
  async function reached(signal: Promise<void>, work: Promise<unknown>): Promise<void> {
    await Promise.race([signal, work.then(() => { throw new Error('Admission ended before the expected barrier.') })])
  }
  function dispatcher(start = realStart, pool = database.pool) {
    return new PostgresScheduleDispatcher(pool, start, () => new Date(now))
  }
  async function save(schedule: ScheduleConfiguration = once) {
    return (await service.save(writer.principal, 'http', { ...scope, schedule, commandId: randomUUID(), expectedRevision: 0 })).value
  }
  async function countRuns() {
    return Number((await database.pool.query<{ count: string }>('select count(*)::text from runs where workflow_id=$1', [scope.workflowId])).rows[0]!.count)
  }
  async function history() { return (await service.recentOccurrences(reader.principal, scope)).items }
  const command = (expectedRevision = 1) => ({ ...scope, commandId: randomUUID(), expectedRevision })

  it.each([once, weekly, { ...interval, every: 60 }])('fires $mode through manual Start and reads exact immutable pins', async (configuration) => {
    const saved = await save(configuration)
    expect(await countRuns()).toBe(0)
    now = saved.nextOccurrenceAt!
    await dispatcher().dispatch(saved)
    const facts = await history()
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ status: 'accepted', workflowVersionId: fixture.version.id, scheduleRevision: 1 })
    expect(await countRuns()).toBe(1)
    const rows = await database.pool.query(`select r.id,r.workflow_version_id,h.run_id as published,
      b.owner_principal_id,c.command_id,s.admission_trigger from runs r join run_graph_heads h on h.run_id=r.id
      join run_board_snapshots s on s.run_id=r.id
      join run_authority_principals b on b.run_id=r.id
      join management_command_receipts c on c.operation='run.start' and c.result->>'id'=r.id
      where r.workflow_id=$1`, [scope.workflowId])
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ workflow_version_id: fixture.version.id,
      owner_principal_id: writer.principal.id, admission_trigger: 'schedule' })
    await dispatcher().dispatch(saved) // stale scan + fresh process object
    expect(await countRuns()).toBe(1)
    expect(await history()).toEqual(facts)
    const current = (await service.get(reader.principal, scope)).schedule!
    expect(current.revision).toBe(1)
    expect(current.nextOccurrenceAt).toBe(configuration.mode === 'once' ? null
      : configuration.mode === 'weekly' ? '2030-01-14T10:00:00.000Z' : '2030-01-07T11:00:00.000Z')
  }, 60_000)

  it('recovers downtime: records older due times as missed and accepts only the latest', async () => {
    const saved = await save(interval)
    now = '2030-01-07T09:08:30.000Z'
    await dispatcher().dispatch(saved)
    const facts = await history()
    expect(facts).toHaveLength(8)
    expect(facts[0]).toMatchObject({ dueAt: '2030-01-07T09:08:00.000Z', status: 'accepted' })
    expect(facts.slice(1).every((fact) => fact.status === 'missed')).toBe(true)
    expect(facts.filter((fact) => fact.status === 'missed' && fact.reason === 'outside_grace')).toHaveLength(3)
    expect(await countRuns()).toBe(1)
    expect((await service.get(reader.principal, scope)).schedule?.nextOccurrenceAt).toBe('2030-01-07T09:09:00.000Z')
  }, 60_000)

  it.each(['2030-01-07T10:05:00.000Z', '2030-01-07T10:05:00.001Z'])('enforces inclusive five-minute grace at %s', async (instant) => {
    const saved = await save(); now = instant
    await dispatcher().dispatch(saved)
    expect((await history())[0]?.status).toBe(instant.endsWith('001Z') ? 'missed' : 'accepted')
    expect(await countRuns()).toBe(instant.endsWith('001Z') ? 0 : 1)
  }, 60_000)

  it('admits once when two dispatchers with independent pools race after preparation', async () => {
    const saved = await save(); now = saved.nextOccurrenceAt!
    const otherPool = new pg.Pool({ connectionString: database.databaseUrl, max: 4,
      options: `-c search_path=${database.schema} -c statement_timeout=10000 -c lock_timeout=5000` })
    const ready = rejectableDeferred(), release = rejectableDeferred(); let arrivals = 0
    const gated = (start: ScheduledStart): ScheduledStart => async (...args) => {
      arrivals++; if (arrivals === 2) ready.resolve()
      await release.promise; await start(...args)
    }
    const work = Promise.all([dispatcher(gated(realStart)).dispatch(saved),
      dispatcher(gated(startUsing(otherPool)), otherPool).dispatch(saved)])
    try {
      await reached(ready.promise, work)
      const otherService = new WorkflowScheduleService(otherPool, new PostgresCommandCoordinator(otherPool), () => new Date(now))
      expect((await otherService.get(reader.principal, scope)).schedule).toEqual(saved)
      release.resolve()
      await work
    } finally {
      release.resolve()
      await work.catch(() => {
        // ignore: cleanup joins the dispatcher without replacing an earlier test failure.
      })
      await otherPool.end()
    }
    expect(await countRuns()).toBe(1)
    expect(await history()).toHaveLength(1)
  }, 60_000)

  it('recovers a lost positive acknowledgement without another logical Run', async () => {
    const saved = await save(); now = saved.nextOccurrenceAt!
    await expect(dispatcher(async (...args) => { await realStart(...args); throw new Error('simulated lost COMMIT reply') })
      .dispatch(saved)).rejects.toThrow('lost COMMIT')
    expect(await countRuns()).toBe(1)
    const before = await history()
    await dispatcher().dispatch(saved)
    expect(await countRuns()).toBe(1); expect(await history()).toEqual(before)
  }, 60_000)

  it('rolls back Run, outcome, cursor, authority and receipt after a pre-COMMIT crash', async () => {
    const saved = await save(); now = saved.nextOccurrenceAt!
    await expect(dispatcher(async (principal, input, guard) => {
      await realStart(principal, input, { ...guard, afterAcceptance: async (sql, run) => {
        await guard.afterAcceptance(sql, run); throw new Error('synthetic pre-COMMIT crash')
      } })
    }).dispatch(saved)).rejects.toThrow('pre-COMMIT')
    expect(await countRuns()).toBe(0); expect(await history()).toEqual([])
    expect((await service.get(reader.principal, scope)).schedule?.nextOccurrenceAt).toBe(saved.nextOccurrenceAt)
    const receipts = await database.pool.query("select 1 from management_command_receipts where principal_id=$1 and operation='run.start'", [writer.principal.id])
    expect(receipts.rows).toEqual([])
    await dispatcher().dispatch(saved)
    expect(await countRuns()).toBe(1)
  }, 60_000)

  it('skips an overlapping scheduled queued Run and never cancels it when disabled', async () => {
    const saved = await save(interval); now = saved.nextOccurrenceAt!
    await dispatcher().dispatch(saved)
    const next = (await service.get(reader.principal, scope)).schedule!
    now = next.nextOccurrenceAt!
    await dispatcher().dispatch(next)
    expect((await history())[0]).toMatchObject({ status: 'skipped', reason: 'overlap' })
    await service.disable(writer.principal, 'mcp', command())
    expect(await countRuns()).toBe(1)
    expect((await database.pool.query('select execution_state from runs where workflow_id=$1', [scope.workflowId])).rows)
      .toEqual([{ execution_state: 'queued' }])
  }, 60_000)

  it.each(['disable', 'clear'] as const)('rechecks a %s racing between preparation and common Start', async (operation) => {
    const saved = await save(); now = saved.nextOccurrenceAt!
    const prepared = rejectableDeferred(), release = rejectableDeferred()
    const work = dispatcher(async (...args) => { prepared.resolve(); await release.promise; await realStart(...args) }).dispatch(saved)
    try {
      await reached(prepared.promise, work)
      await service[operation](writer.principal, 'http', command())
      release.resolve(); await work
    } finally {
      release.resolve()
      await work.catch(() => {
        // ignore: cleanup joins the dispatcher without replacing an earlier test failure.
      })
    }
    expect(await countRuns()).toBe(0)
    expect((await history())[0]).toMatchObject({ status: 'skipped', reason: 'disabled' })
    expect((await service.get(reader.principal, scope)).schedule?.enabled ?? false).toBe(false)
  }, 60_000)

  it('rechecks permission loss after preparation and records only a safe rejection', async () => {
    const saved = await save(); now = saved.nextOccurrenceAt!
    const prepared = rejectableDeferred(), release = rejectableDeferred()
    const work = dispatcher(async (...args) => { prepared.resolve(); await release.promise; await realStart(...args) }).dispatch(saved)
    try {
      await reached(prepared.promise, work)
      await database.pool.query('update management_principals set revoked_at=now() where id=$1', [writer.principal.id])
      release.resolve(); await work
    } finally {
      release.resolve()
      await work.catch(() => {
        // ignore: cleanup joins the dispatcher without replacing an earlier test failure.
      })
    }
    expect(await countRuns()).toBe(0)
    expect((await history())[0]).toMatchObject({ status: 'rejected', reason: 'schedule_authorization_denied' })
  }, 60_000)

  it('pins the latest saved head when a workflow save races the prepared Start', async () => {
    const saved = await save(); now = saved.nextOccurrenceAt!
    let changed = false, latestId = ''
    await dispatcher(async (...args) => {
      if (!changed) {
        changed = true
        const row = (await database.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [scope.workflowId])).rows[0]!
        const latest = (await workflows.current.save(writer.principal, 'http', {
          ...scope, commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: Number(row.revision),
          expectedWorkflowVersionId: fixture.version.id,
          expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
          graph: { ...fixture.version.definition, name: 'A newer saved workflow' },
        })).value
        latestId = latest.version.id
      }
      await realStart(...args)
    }).dispatch(saved)
    expect(latestId).not.toBe(fixture.version.id)
    expect((await history())[0]).toMatchObject({ status: 'accepted', workflowVersionId: latestId })
    expect(await countRuns()).toBe(1)
  }, 60_000)

  it('re-evaluates the latest due at COMMIT after time advances during publication', async () => {
    const saved = await save(interval); now = saved.nextOccurrenceAt!
    let advanced = false
    await dispatcher(async (principal, input, guard) => {
      await realStart(principal, input, { ...guard, afterAcceptance: async (sql, run) => {
        await guard.afterAcceptance(sql, run)
        if (!advanced) { advanced = true; now = '2030-01-07T09:02:00.000Z' }
      } })
    }).dispatch(saved)
    const facts = await history()
    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({ status: 'accepted', dueAt: '2030-01-07T09:02:00.000Z' })
    expect(facts[1]).toMatchObject({ status: 'missed', reason: 'superseded', dueAt: saved.nextOccurrenceAt })
    expect(await countRuns()).toBe(1)
  }, 60_000)

  it('does not treat a concurrent manual Run as scheduled overlap', async () => {
    const saved = await save(); now = saved.nextOccurrenceAt!
    await dispatcher(async (principal, input, guard) => {
      await admitRepeatRun(database.pool, locations, principal, 'http', { ...input, commandId: randomUUID() }, repeatStartPublication)
      await realStart(principal, input, guard)
    }).dispatch(saved)
    expect(await countRuns()).toBe(2)
    expect(await history()).toHaveLength(1)
    expect((await history())[0]?.status).toBe('accepted')
  }, 60_000)

  it('does not reinterpret a transient error as a rejected occurrence', async () => {
    const saved = await save(); now = saved.nextOccurrenceAt!
    await expect(dispatcher(async () => { throw new Error('synthetic outage') }).dispatch(saved)).rejects.toThrow('outage')
    expect(await history()).toEqual([])
    expect((await service.get(reader.principal, scope)).schedule?.nextOccurrenceAt).toBe(saved.nextOccurrenceAt)
    await dispatcher().dispatch(saved); expect(await countRuns()).toBe(1)
  }, 60_000)

  it('requires explicit durable owner binding for a pre-upgrade schedule', async () => {
    const saved = await save()
    await database.pool.query('delete from workflow_schedule_authorities where workflow_id=$1', [scope.workflowId])
    now = saved.nextOccurrenceAt!
    await dispatcher().dispatch(saved)
    expect((await history())[0]).toMatchObject({ status: 'rejected', reason: 'schedule_authority_missing' })
    expect(await countRuns()).toBe(0)
  })

  it('never expands the captured writer ceiling after the owner later gains Run grants', async () => {
    writer = await issue(actions.filter((action) => action !== 'runs:start'))
    const saved = await save()
    await database.pool.query('update management_principals set grants=$2::jsonb where id=$1',
      [writer.principal.id, JSON.stringify([{ actions, scope: { workspaceIds: [scope.workspaceId] } }])])
    now = saved.nextOccurrenceAt!
    await dispatcher().dispatch(saved)
    expect((await history())[0]).toMatchObject({ status: 'rejected', reason: 'schedule_authorization_denied' })
    expect(await countRuns()).toBe(0)
  })

  it('keeps a new disabled/cleared slot authoritative over legacy schedule enables', async () => {
    await database.pool.query(`insert into workflow_triggers(workspace_id,workflow_id,principal_id,record,enabled,next_fire_at)
      values($1,$2,$3,$4::jsonb,true,$5)`, [scope.workspaceId, scope.workflowId, writer.principal.id,
      JSON.stringify({ kind: 'schedule', enabled: true, intervalSeconds: 60, startsAt: now, missed: 'skip' }), now])
    await save({ ...once, enabled: false })
    await service.clear(writer.principal, 'http', command())
    await database.pool.query('update workflow_triggers set enabled=true,next_fire_at=$2 where workflow_id=$1', [scope.workflowId, now])
    expect((await database.pool.query('select enabled,next_fire_at,last_error from workflow_triggers where workflow_id=$1', [scope.workflowId])).rows)
      .toEqual([{ enabled: false, next_fire_at: null, last_error: 'SCHEDULE_REPLACED' }])
    expect(await countRuns()).toBe(0)
  })

  it('MCP save drives the same dispatcher; HTTP/MCP readback and denied writes retain parity', async () => {
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { workflows, commands } as unknown as OperatorServices } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 }), clients: Client[] = []
    async function connect(token: string) {
      const client = new Client({ name: 'sch04-integration', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })); return client
    }
    try {
      const owner = await connect(writer.token), readOnly = await connect(reader.token)
      const body = { ...scope, schedule: once, commandId: randomUUID(), expectedRevision: 0 }
      const result = await owner.callTool({ name: 'workflow_schedule_save', arguments: body })
      expect(result.isError).not.toBe(true)
      const saved = ScheduleSaveResultSchema.parse(decodeMcpToolResult(result)).value
      expect(await countRuns()).toBe(0)
      now = saved.nextOccurrenceAt!
      await dispatcher().dispatch(saved)
      const page = await readOnly.callTool({ name: 'workflow_schedule_occurrences_list', arguments: scope })
      const facts = ScheduleOccurrencePageSchema.parse(decodeMcpToolResult(page))
      expect(facts.items[0]?.status).toBe('accepted')
      const root = `/api/management/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/schedule`
      const http = await app.inject({ method: 'GET', url: `${root}/occurrences`, headers: { authorization: `Bearer ${reader.token}` } })
      expect(http.statusCode).toBe(200); expect(http.json()).toEqual(facts)
      const denied = await readOnly.callTool({ name: 'workflow_schedule_save', arguments: body })
      expect(denied.isError).toBe(true); expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      const deniedHttp = await app.inject({ method: 'PUT', url: root, headers: { authorization: `Bearer ${reader.token}` },
        payload: { schedule: once, commandId: randomUUID(), expectedRevision: 1 } })
      expect(deniedHttp.statusCode).toBe(403)
      expect(await countRuns()).toBe(1)
    } finally { await Promise.allSettled(clients.map((client) => client.close())); await app.close() }
  }, 60_000)
})
