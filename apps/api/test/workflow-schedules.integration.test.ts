import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ScheduleGetResultSchema, ScheduleSaveResultSchema, ScheduleOccurrenceSchema, scheduleOccurrenceId,
  type ScheduleConfiguration, type ScheduleGetInput, type ScheduleOccurrence,
} from '@foreman-code/contracts/schedules'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { ManagementGrant } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { workflowScheduleMigration } from '../src/infrastructure/workflowScheduleMigration.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { ScheduleOperatorCapabilitiesSchema, WORKFLOW_SCHEDULE_TOOLS } from '../src/mcp/operator/tools/workflowSchedules.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { WorkflowScheduleService } from '../src/modules/schedules/service.js'
import { ScheduleClearResultSchema, ScheduleOccurrencePageSchema } from '../src/modules/schedules/transportSchemas.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

const settings = { timezone: 'UTC', enabled: true, policy: 'latest_saved' as const }
const weekly: ScheduleConfiguration = { ...settings, mode: 'weekly', weekdays: [1, 3], time: '10:00' }
const interval: ScheduleConfiguration = { ...settings, mode: 'interval', every: 1, unit: 'minute', anchorAt: '2030-01-07T08:00:00.000Z' }
const once: ScheduleConfiguration = { ...settings, mode: 'once', localDate: '2030-01-08', time: '10:00' }

/** No native providers, scheduler or paid calls. Real schema, receipts, SQL locks, HTTP and MCP. */
describe.skipIf(!postgresEnabled)('SCH-03 PostgreSQL persistence and authenticated HTTP/MCP parity', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let access: PostgresAccessService
  let commands: PostgresCommandCoordinator
  let workflows: WorkflowManagementService
  let service: WorkflowScheduleService
  let writer: Awaited<ReturnType<PostgresAccessService['issue']>>
  let reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  let foreign: Awaited<ReturnType<PostgresAccessService['issue']>>
  let scope: ScheduleGetInput
  let foreignScope: ScheduleGetInput
  let now: string

  beforeAll(async () => {
    database = await agent3Database()
    // The production registry is deliberately owned by the integrator. Run this migration
    // explicitly before registration, and avoid applying it twice after registration.
    await transaction(async (client) => {
      const applied = await client.query('select 1 from application_migrations where version=$1', [workflowScheduleMigration.version])
      if (!applied.rows.length) {
        await client.query(workflowScheduleMigration.sql)
        await client.query('insert into application_migrations(version) values($1)', [workflowScheduleMigration.version])
      }
    })
    access = new PostgresAccessService(database.pool)
    commands = new PostgresCommandCoordinator(database.pool)
    workflows = new WorkflowManagementService(database.pool, commands)
  }, 60_000)
  afterAll(async () => { await database?.close() })

  beforeEach(async () => {
    now = '2030-01-07T09:00:00.000Z'
    service = new WorkflowScheduleService(database.pool, commands, () => new Date(now))
    const workspaceId = `sch03-${randomUUID()}`, foreignWorkspaceId = `sch03-foreign-${randomUUID()}`
    for (const id of [workspaceId, foreignWorkspaceId]) {
      await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
        [id, JSON.stringify({ id, name: 'Synthetic schedule test' })])
    }
    writer = await issue(workspaceId, ['workflows:create', 'workflows:read', 'workflows:update', 'capabilities:read'])
    reader = await issue(workspaceId, ['workflows:read', 'capabilities:read'])
    foreign = await issue(foreignWorkspaceId, ['workflows:create', 'workflows:read', 'workflows:update'])
    scope = { workspaceId, workflowId: (await workflows.create(writer.principal, 'http', {
      workspaceId, commandId: randomUUID(), name: 'Schedule persistence only',
    })).value.workflow.id }
    foreignScope = { workspaceId: foreignWorkspaceId, workflowId: (await workflows.create(foreign.principal, 'http', {
      workspaceId: foreignWorkspaceId, commandId: randomUUID(), name: 'Other workspace',
    })).value.workflow.id }
  })

  function issue(workspaceId: string, actions: ManagementGrant['actions']) {
    return access.issue({ name: 'Synthetic SCH-03 caller', audience: 'operator', expiresAt: new Date(Date.now() + 3_600_000),
      grants: [{ actions, scope: { workspaceIds: [workspaceId] } }] })
  }
  async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await database.pool.connect()
    try {
      await client.query('begin')
      const value = await work(client)
      await client.query('commit')
      return value
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }
  function request(schedule: ScheduleConfiguration = weekly, expectedRevision = 0, commandId = randomUUID()) {
    return { ...scope, schedule, expectedRevision, commandId }
  }
  function command(expectedRevision: number) { return { ...scope, expectedRevision, commandId: randomUUID() } }
  function occurrence(dueAt: string, status: 'skipped' | 'missed' | 'rejected' = 'skipped'): ScheduleOccurrence {
    const reason = status === 'skipped' ? 'overlap' : status === 'missed' ? 'outside_grace' : 'workflow_not_saved'
    return ScheduleOccurrenceSchema.parse({ ...scope, id: scheduleOccurrenceId(scope.workflowId, dueAt),
      dueAt, scheduleRevision: 1, status, reason })
  }
  const record = (value: ScheduleOccurrence) => transaction((client) => service.repository.recordOccurrence(client, value, now))
  async function runCount() { return (await database.pool.query<{ count: string }>('select count(*) from runs')).rows[0]!.count }

  it.each([
    ['weekly', weekly, '2030-01-07T10:00:00.000Z'],
    ['interval', interval, '2030-01-07T09:01:00.000Z'],
    ['once', once, '2030-01-08T10:00:00.000Z'],
  ] as const)('persists %s and reads through a fresh service without starting a Run', async (_mode, schedule, next) => {
    const before = await runCount()
    expect(await service.get(writer.principal, scope)).toEqual({ schedule: null })
    const saved = await service.save(writer.principal, 'http', request(schedule))
    expect(saved).toMatchObject({ replayed: false, value: { ...scope, revision: 1, nextOccurrenceAt: next } })
    const restarted = new WorkflowScheduleService(database.pool, new PostgresCommandCoordinator(database.pool))
    expect(await restarted.get(reader.principal, scope)).toEqual({ schedule: saved.value })
    expect(await runCount()).toBe(before)
  })

  it('replays the original value after a later write and after Once has elapsed', async () => {
    const input = request(once)
    const original = await service.save(writer.principal, 'http', input)
    const newer = await service.save(writer.principal, 'mcp', request(weekly, 1))
    now = '2030-01-09T00:00:00.000Z'
    expect(await service.save(writer.principal, 'mcp', input)).toEqual({ value: original.value, replayed: true })
    expect(await service.get(reader.principal, scope)).toEqual({ schedule: newer.value })
    const receipts = await database.pool.query<{ count: string }>(`select count(*) from management_command_receipts
      where principal_id=$1 and operation='workflow.schedule.save' and command_id=$2`, [writer.principal.id, input.commandId])
    expect(receipts.rows[0]!.count).toBe('1')
  })

  it('rejects stale revisions and changed-payload command reuse', async () => {
    const input = request()
    await service.save(writer.principal, 'http', input)
    await expect(service.save(writer.principal, 'http', request(interval)))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT', details: { currentRevision: 1 } })
    await expect(service.save(writer.principal, 'mcp', { ...input, schedule: interval }))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    await expect(service.save(writer.principal, 'mcp', { ...input, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    expect((await service.get(reader.principal, scope)).schedule?.revision).toBe(1)
  })

  it('normalizes weekday order and interval offsets for matching retries', async () => {
    const input = request(weekly)
    const first = await service.save(writer.principal, 'http', input)
    expect(await service.save(writer.principal, 'mcp', { ...input, schedule: { ...weekly, weekdays: [3, 1] } }))
      .toEqual({ value: first.value, replayed: true })
    const elapsed = request(interval, 1)
    const second = await service.save(writer.principal, 'http', elapsed)
    expect(await service.save(writer.principal, 'mcp', { ...elapsed,
      schedule: { ...interval, anchorAt: '2030-01-07T13:00:00+05:00' },
    })).toEqual({ value: second.value, replayed: true })
  })

  it('serializes duplicate concurrent commands and distinct competing writes', async () => {
    const input = request()
    const duplicate = await Promise.all([service.save(writer.principal, 'http', input), service.save(writer.principal, 'mcp', input)])
    expect(duplicate.map((value) => value.replayed).sort()).toEqual([false, true])
    expect(duplicate[0]!.value).toEqual(duplicate[1]!.value)
    const competing = await Promise.allSettled([
      service.save(writer.principal, 'http', request(interval, 1)), service.save(writer.principal, 'mcp', request(once, 1)),
    ])
    expect(competing.filter((value) => value.status === 'fulfilled')).toHaveLength(1)
    expect(competing.filter((value) => value.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'REVISION_CONFLICT' }) }),
    ])
    expect((await service.get(reader.principal, scope)).schedule?.revision).toBe(2)
  })

  it('serializes distinct first saves against an absent schedule slot', async () => {
    const results = await Promise.allSettled([
      service.save(writer.principal, 'http', request(weekly)),
      service.save(writer.principal, 'mcp', request(interval)),
    ])
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((value) => value.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'REVISION_CONFLICT' }) }),
    ])
    expect((await service.get(reader.principal, scope)).schedule?.revision).toBe(1)
  })

  it.each([
    { ...weekly, timezone: 'Bad/Timezone' }, { ...weekly, weekdays: [1, 1] },
    { ...interval, every: 0 }, { ...interval, every: 1.1 },
    { ...once, localDate: '2030-01-06' }, { ...once, localDate: '2030-01-07', time: '09:00' },
    { ...once, enabled: false, localDate: '2030-01-06' },
  ])('rejects invalid new saves without a receipt or schedule: %j', async (schedule) => {
    const input = { ...scope, schedule, commandId: randomUUID(), expectedRevision: 0 }
    await expect(service.save(writer.principal, 'mcp', input)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(await service.get(reader.principal, scope)).toEqual({ schedule: null })
    expect((await database.pool.query('select 1 from management_command_receipts where principal_id=$1 and command_id=$2',
      [writer.principal.id, input.commandId])).rows).toHaveLength(0)
  })

  it('preserves DST gap/fold decisions from the contract and uses only the first fold', async () => {
    now = '2030-03-01T00:00:00.000Z'
    const gap = await service.save(writer.principal, 'http', request({ ...settings, mode: 'once',
      timezone: 'America/New_York', localDate: '2030-03-10', time: '02:30' }))
    expect(gap.value.nextOccurrenceAt).toBe('2030-03-10T07:30:00.000Z')
    now = '2030-11-03T06:00:00.000Z'
    await expect(service.save(writer.principal, 'http', request({ ...settings, mode: 'once',
      timezone: 'America/New_York', localDate: '2030-11-03', time: '01:30' }, 1)))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('supports disable and re-enable after unchanged Once settings have elapsed', async () => {
    await service.save(writer.principal, 'http', request(once))
    now = '2030-01-09T00:00:00.000Z'
    const input = command(1)
    const disabled = await service.disable(writer.principal, 'http', input)
    expect(disabled.value).toMatchObject({ enabled: false, nextOccurrenceAt: null, revision: 2 })
    expect(await service.disable(writer.principal, 'mcp', input)).toEqual({ value: disabled.value, replayed: true })
    const enabled = await service.enable(writer.principal, 'mcp', command(2))
    expect(enabled.value).toMatchObject({ enabled: true, nextOccurrenceAt: null, revision: 3 })
    expect((await service.get(reader.principal, scope)).schedule).toEqual(enabled.value)
    await expect(service.save(writer.principal, 'mcp', request({ ...once, time: '11:00' }, 3)))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('clear retains command/occurrence history and monotonic saved revisions', async () => {
    const firstInput = request(interval)
    const first = await service.save(writer.principal, 'http', firstInput)
    const item = occurrence('2030-01-07T08:00:00.000Z')
    await record(item)
    const input = command(1)
    expect(await service.clear(writer.principal, 'http', input)).toEqual({ value: null, replayed: false })
    expect(await service.get(reader.principal, scope)).toEqual({ schedule: null })
    const row = (await database.pool.query('select revision,record,enabled,cleared_at from workflow_schedules where workflow_id=$1', [scope.workflowId])).rows[0]!
    expect(row).toMatchObject({ revision: '2', record: null, enabled: false })
    expect(row.cleared_at).not.toBeNull()
    const recreated = await service.save(writer.principal, 'mcp', request(weekly, 0))
    expect(recreated.value.revision).toBe(3)
    expect(await service.clear(writer.principal, 'mcp', input)).toEqual({ value: null, replayed: true })
    expect(await service.save(writer.principal, 'mcp', firstInput)).toEqual({ value: first.value, replayed: true })
    expect(await service.get(reader.principal, scope)).toEqual({ schedule: recreated.value })
    expect((await service.recentOccurrences(reader.principal, scope)).items).toEqual([item])
    await expect(service.disable(writer.principal, 'http', command(1))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  })

  it.each(['disable', 'enable', 'clear'] as const)('%s requires an existing record', async (operation) => {
    await expect(service[operation](writer.principal, 'mcp', command(0))).rejects.toMatchObject({ code: 'SCHEDULE_NOT_FOUND' })
  })

  it('denies cross-workspace access, forged hierarchy and revoked receipt replay', async () => {
    const input = request()
    await service.save(writer.principal, 'http', input)
    await expect(service.get(foreign.principal, scope)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(service.save(foreign.principal, 'mcp', input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(service.recentOccurrences(foreign.principal, scope)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(service.get(writer.principal, { ...scope, workflowId: foreignScope.workflowId }))
      .rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND' })
    await expect(service.save(writer.principal, 'mcp', { ...input, commandId: randomUUID(), workflowId: foreignScope.workflowId }))
      .rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND' })
    await access.revoke(writer.principal.id)
    // The stale in-memory principal still looks authorized: replay must re-read live SQL authority.
    await expect(service.save(writer.principal, 'mcp', input)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  })

  it('checks updated live grants before both reads and matching replays', async () => {
    const input = request()
    await service.save(writer.principal, 'http', input)
    await database.pool.query('update management_principals set grants=$2::jsonb where id=$1', [writer.principal.id, '[]'])
    await expect(service.get(writer.principal, scope)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(service.save(writer.principal, 'mcp', input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  })

  it('records immutable unique outcomes, canonical retries and rejects future occurrences', async () => {
    await service.save(writer.principal, 'http', request(interval))
    const item = occurrence('2030-01-07T08:00:00.000Z')
    expect(await record(item)).toEqual({ value: item, replayed: false })
    expect(await record({ ...item, dueAt: '2030-01-07T13:00:00+05:00' })).toEqual({ value: item, replayed: true })
    await expect(record(occurrence(item.dueAt, 'missed'))).rejects.toMatchObject({ code: 'SCHEDULE_OCCURRENCE_CONFLICT' })
    await expect(record(occurrence('2030-01-07T10:00:00.000Z'))).rejects.toMatchObject({ code: 'SCHEDULE_NOT_DUE' })
    await expect(database.pool.query('update workflow_schedule_occurrences set reason=reason where id=$1', [item.id]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(database.pool.query('delete from workflow_schedule_occurrences where id=$1', [item.id]))
      .rejects.toMatchObject({ code: '23514' })
    expect((await service.recentOccurrences(reader.principal, scope)).items).toEqual([item])
  })

  it('uses the dispatcher transaction without committing it', async () => {
    await service.save(writer.principal, 'http', request(interval))
    const client = await database.pool.connect()
    const item = occurrence('2030-01-07T08:00:00.000Z')
    try {
      await client.query('begin')
      await service.repository.recordOccurrence(client, item, now)
      expect((await service.recentOccurrences(reader.principal, scope)).items).toEqual([])
      await client.query('rollback')
    } finally { client.release() }
    expect((await service.recentOccurrences(reader.principal, scope)).items).toEqual([])
  })

  it('pages all four outcomes and checks accepted Run/version lineage', async () => {
    // Existing synthetic fixture writer creates stored Run facts only; no provider is launched.
    const fixture = await seedAgent3(database.pool, database.directory, makeCurrentWorkflowFixture(randomUUID(), 'single'))
    const owner = await issue(fixture.scope.workspaceId, ['workflows:read', 'workflows:update'])
    const target = { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId }
    await service.save(owner.principal, 'http', { ...target, schedule: interval, commandId: randomUUID(), expectedRevision: 0 })
    const accepted = ScheduleOccurrenceSchema.parse({ ...target, id: scheduleOccurrenceId(target.workflowId, '2030-01-07T08:04:00Z'),
      dueAt: '2030-01-07T08:04:00Z', scheduleRevision: 1, status: 'accepted', reason: null,
      runId: fixture.run.id, workflowVersionId: fixture.version.id })
    await transaction((client) => service.repository.recordOccurrence(client, accepted, now))
    for (const [index, status] of (['skipped', 'missed', 'rejected'] as const).entries()) {
      const dueAt = `2030-01-07T08:0${index}:00.000Z`
      const item = ScheduleOccurrenceSchema.parse({ ...occurrence(dueAt, status), ...target,
        id: scheduleOccurrenceId(target.workflowId, dueAt) })
      await transaction((client) => service.repository.recordOccurrence(client, item, now))
    }
    const first = await service.recentOccurrences(owner.principal, { ...target, limit: 2 })
    expect(first.items.map((item) => item.status)).toEqual(['accepted', 'rejected'])
    expect(first.items[0]).toEqual(accepted)
    expect(first.pageInfo.nextCursor).toBeTypeOf('string')
    const second = await service.recentOccurrences(owner.principal, { ...target, limit: 2, cursor: first.pageInfo.nextCursor })
    expect(second.items.map((item) => item.status)).toEqual(['missed', 'skipped'])
    expect(second.pageInfo.nextCursor).toBeNull()
    await expect(service.recentOccurrences(writer.principal, { ...scope, cursor: first.pageInfo.nextCursor }))
      .rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    await service.save(writer.principal, 'http', request(interval))
    await expect(record(ScheduleOccurrenceSchema.parse({ ...accepted, ...scope, id: scheduleOccurrenceId(scope.workflowId, accepted.dueAt) })))
      .rejects.toMatchObject({ code: 'SCHEDULE_RUN_MISMATCH' })
    const runBefore = (await database.pool.query('select to_jsonb(r) as value from runs r where id=$1', [fixture.run.id])).rows
    await service.disable(owner.principal, 'http', { ...target, commandId: randomUUID(), expectedRevision: 1 })
    await service.clear(owner.principal, 'mcp', { ...target, commandId: randomUUID(), expectedRevision: 2 })
    expect((await database.pool.query('select to_jsonb(r) as value from runs r where id=$1', [fixture.run.id])).rows).toEqual(runBefore)
    expect((await service.recentOccurrences(owner.principal, target)).items[0]).toEqual(accepted)
  }, 60_000)

  it('bounds due scans and CAS-advances without editing the schedule revision', async () => {
    const saved = await service.save(writer.principal, 'http', request(interval))
    const other = await workflows.create(writer.principal, 'http', { workspaceId: scope.workspaceId, name: 'Second due schedule', commandId: randomUUID() })
    const otherScope = { workspaceId: scope.workspaceId, workflowId: other.value.workflow.id }
    await service.save(writer.principal, 'http', { ...otherScope, schedule: interval, commandId: randomUUID(), expectedRevision: 0 })
    // Earlier tests may retain due schedules in this isolated schema. Scan every bounded page
    // with one fixed boundary, and assert this test's two tied-time IDs are both visited.
    const throughUtc = '2030-01-07T09:02:00.000Z'
    const ids: string[] = []
    let cursor: string | undefined
    do {
      const page = await service.repository.listDueSchedules({ throughUtc, limit: 1, ...(cursor ? { cursor } : {}) })
      expect(page.items.length).toBeLessThanOrEqual(1)
      ids.push(...page.items.map((item) => item.workflowId))
      cursor = page.pageInfo.nextCursor ?? undefined
    } while (cursor)
    expect(ids.filter((id) => id === scope.workflowId || id === otherScope.workflowId)).toHaveLength(2)
    const first = await service.repository.listDueSchedules({ throughUtc, limit: 1 })
    if (first.pageInfo.nextCursor) await expect(service.repository.listDueSchedules({
      throughUtc: '2030-01-07T09:03:00.000Z', cursor: first.pageInfo.nextCursor,
    })).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    await expect(service.repository.listDueSchedules({ throughUtc, limit: 101 })).rejects.toBeDefined()
    const nextDue = '2030-01-07T09:03:00.000Z'
    await transaction(async (client) => {
      await service.repository.lock(client, scope)
      await service.repository.advanceCursor(client, scope, 1, saved.value.nextOccurrenceAt!, nextDue)
    })
    expect((await service.get(reader.principal, scope)).schedule).toMatchObject({ revision: 1, nextOccurrenceAt: nextDue })
    await expect(transaction((client) => service.repository.advanceCursor(client, scope, 1, saved.value.nextOccurrenceAt!, nextDue)))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await service.disable(writer.principal, 'http', { ...otherScope, commandId: randomUUID(), expectedRevision: 1 })
    const due = await service.repository.listDueSchedules({ throughUtc, limit: 100 })
    expect(due.items.some((item) => item.workflowId === scope.workflowId || item.workflowId === otherScope.workflowId)).toBe(false)
    await transaction(async (client) => {
      await client.query('update workflows set archived_at=now() where id=$1', [scope.workflowId])
      const archived = await service.repository.listDueSchedules({ throughUtc: nextDue, limit: 100 }, client)
      expect(archived.items.some((item) => item.workflowId === scope.workflowId)).toBe(false)
    })
    await expect(service.save(writer.principal, 'http', request(weekly, 1))).rejects.toMatchObject({ code: 'WORKFLOW_ARCHIVED' })
  })

  it('serves the complete workflow through the authenticated MCP endpoint and reads it back over HTTP', async () => {
    const before = await runCount()
    // Real production assembly for the changed capability; unrelated services are not invoked by these calls.
    const services = { workflows, commands } as unknown as OperatorServices
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connected: Client[] = []
    async function connect(token: string) {
      const client = new Client({ name: 'sch03-integration', version: '1.0.0' })
      connected.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }))
      return client
    }
    const root = `/api/management/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/schedule`
    try {
      const owner = await connect(writer.token), readOnly = await connect(reader.token), outsider = await connect(foreign.token)
      const listed = await owner.listTools()
      for (const name of WORKFLOW_SCHEDULE_TOOLS) expect(listed.tools.map((tool) => tool.name)).toContain(name)
      expect((await readOnly.listTools()).tools.map((tool) => tool.name)).not.toContain('workflow_schedule_save')
      const caps = await owner.callTool({ name: 'operator_get_capabilities', arguments: { ...scope, detail: 'full' } })
      expect(caps.isError).not.toBe(true)
      expect(ScheduleOperatorCapabilitiesSchema.parse(decodeMcpToolResult(caps)).tools).toEqual(expect.arrayContaining([...WORKFLOW_SCHEDULE_TOOLS]))
      const body = { commandId: randomUUID(), expectedRevision: 0, schedule: weekly }
      const created = await owner.callTool({ name: 'workflow_schedule_save', arguments: { ...scope, ...body } })
      expect(created.isError).not.toBe(true)
      const saved = ScheduleSaveResultSchema.parse(decodeMcpToolResult(created))
      expect(saved).toMatchObject({ replayed: false, value: { revision: 1 } })
      const persisted = await readOnly.callTool({ name: 'workflow_schedule_get', arguments: scope })
      expect(ScheduleGetResultSchema.parse(decodeMcpToolResult(persisted))).toEqual({ schedule: saved.value })
      const http = await app.inject({ method: 'GET', url: root, headers: { authorization: `Bearer ${reader.token}` } })
      expect(http.statusCode).toBe(200)
      expect(http.headers['cache-control']).toBe('no-store')
      expect(http.json()).toEqual({ schedule: saved.value })
      // The original command replays identically across transports and needs no graph:save grant.
      const replay = await app.inject({ method: 'PUT', url: root, payload: body, headers: { authorization: `Bearer ${writer.token}` } })
      expect(replay.statusCode).toBe(200)
      expect(replay.json()).toEqual({ value: saved.value, replayed: true })
      const denied = await readOnly.callTool({ name: 'workflow_schedule_save', arguments: { ...scope, ...body } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      const wrongScope = await outsider.callTool({ name: 'workflow_schedule_get', arguments: scope })
      expect(wrongScope.isError).toBe(true)
      expect(JSON.stringify(wrongScope.content)).toContain('ACCESS_DENIED')
      const deniedHttp = await app.inject({ method: 'PUT', url: root, payload: body, headers: { authorization: `Bearer ${reader.token}` } })
      expect(deniedHttp.statusCode).toBe(403)
      const local = await app.inject({ method: 'GET', url: root })
      expect(local.statusCode).toBe(200)
      expect(local.json()).toEqual({ schedule: saved.value })
      const invalid = await app.inject({ method: 'GET', url: root, headers: { authorization: 'Bearer invalid' } })
      expect(invalid.statusCode).toBe(401)
      const missingHierarchy = await app.inject({ method: 'GET',
        url: `/api/management/workspaces/${scope.workspaceId}/workflows/${foreignScope.workflowId}/schedule`,
        headers: { authorization: `Bearer ${writer.token}` } })
      expect(missingHierarchy.statusCode).toBe(404)
      const badPage = await app.inject({ method: 'GET', url: `${root}/occurrences?limit=101`, headers: { authorization: `Bearer ${reader.token}` } })
      expect(badPage.statusCode).toBe(400)
      const pastOnce = await owner.callTool({ name: 'workflow_schedule_save', arguments: {
        ...scope, commandId: randomUUID(), expectedRevision: 1,
        schedule: { ...settings, mode: 'once', localDate: '2000-01-01', time: '00:00' },
      } })
      expect(pastOnce.isError).toBe(true)
      expect(JSON.stringify(pastOnce.content)).toContain('INVALID_REQUEST')
      const disabled = await owner.callTool({ name: 'workflow_schedule_disable', arguments: command(1) })
      expect(ScheduleSaveResultSchema.parse(decodeMcpToolResult(disabled)).value).toMatchObject({ revision: 2, enabled: false, nextOccurrenceAt: null })
      const enabled = await owner.callTool({ name: 'workflow_schedule_enable', arguments: command(2) })
      expect(ScheduleSaveResultSchema.parse(decodeMcpToolResult(enabled)).value).toMatchObject({ revision: 3, enabled: true })
      const dueAt = '2000-01-01T00:00:00.000Z'
      const history = ScheduleOccurrenceSchema.parse({ ...occurrence(dueAt, 'rejected'), scheduleRevision: 3 })
      await record(history)
      const page = await readOnly.callTool({ name: 'workflow_schedule_occurrences_list', arguments: { ...scope, limit: 1 } })
      expect(ScheduleOccurrencePageSchema.parse(decodeMcpToolResult(page)).items).toEqual([history])
      const clear = await owner.callTool({ name: 'workflow_schedule_clear', arguments: command(3) })
      expect(ScheduleClearResultSchema.parse(decodeMcpToolResult(clear))).toEqual({ value: null, replayed: false })
      const cleared = await readOnly.callTool({ name: 'workflow_schedule_get', arguments: scope })
      expect(ScheduleGetResultSchema.parse(decodeMcpToolResult(cleared))).toEqual({ schedule: null })
      const audit = await database.pool.query(`select 1 from management_audit where principal_id=$1
        and source='mcp' and action='workflow_schedule_save' and outcome='denied'`, [reader.principal.id])
      expect(audit.rows.length).toBeGreaterThan(0)
      expect(await runCount()).toBe(before)
    } finally {
      await Promise.allSettled(connected.map((client) => client.close()))
      await app.close()
    }
  }, 60_000)

  it('enforces database scope constraints without modifying legacy trigger rows', async () => {
    const before = await database.pool.query('select to_jsonb(t) as record from workflow_triggers t order by workflow_id')
    await service.save(writer.principal, 'http', request())
    await service.disable(writer.principal, 'http', command(1))
    await service.clear(writer.principal, 'mcp', command(2))
    expect((await database.pool.query('select to_jsonb(t) as record from workflow_triggers t order by workflow_id')).rows).toEqual(before.rows)
    await expect(database.pool.query(`insert into workflow_schedules
      (workspace_id,workflow_id,revision,record,enabled,cleared_at,updated_by_principal_id)
      values($1,$2,1,null,false,now(),$3)`, [scope.workspaceId, foreignScope.workflowId, writer.principal.id]))
      .rejects.toMatchObject({ code: '23503' })
    expect(workflowScheduleMigration.version).toBe(270203)
    expect((await service.repository.getSlot(database.pool, scope))!.lastRevision).toBe(3)
  })
})
