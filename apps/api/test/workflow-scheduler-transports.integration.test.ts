import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ScheduleGetResultSchema, ScheduleOccurrencePageSchema, ScheduleSaveResultSchema } from '@foreman-code/contracts/schedules'
import { buildApp } from '../src/app.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { ScheduleClearResultSchema } from '../src/modules/schedules/transportSchemas.js'
import { DomainError } from '../src/modules/errors.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { sch11Once, sch11Settings } from './helpers/sch11ClockCases.js'
import { sch11Actions, sch11DomainState, sch11Fixture, type Sch11Database, type Sch11Fixture } from './helpers/sch11Fixture.js'

// HTTP/MCP use their real service clock. A far-future Once gives an exact cursor
// without changing auth clocks or monkey-patching product methods. Deterministic
// calendar/dispatch clocks are covered by the separate SCH-11 vector suites.
const futureOnce = { ...sch11Once, localDate: '2099-01-01' }
const operations = ['save', 'enable', 'disable', 'clear'] as const
const deniedCases = operations.flatMap((operation) => [
  { operation, caller: 'read-only' as const }, { operation, caller: 'foreign-workspace' as const },
])

describe.skipIf(!postgresEnabled)('SCH-11 authenticated HTTP and MCP persisted state / denials', () => {
  let database: Sch11Database
  let f: Sch11Fixture
  let app: ReturnType<typeof buildApp> | undefined
  let address: string
  let clients: Client[] = []
  beforeAll(async () => { database = await agent3Database() }, 60_000)
  afterAll(async () => { await database?.close() })
  beforeEach(async () => {
    clients = []; app = undefined
    f = await sch11Fixture(database)
    app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: f.access, services: { workflows: f.workflows, commands: f.commands } as unknown as OperatorServices },
      localHuman: new PostgresLocalHumanAccess(database.pool, f.access) })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60_000)
  afterEach(async () => {
    await Promise.allSettled(clients.map((client) => client.close()))
    await app?.close()
  }, 30_000)

  const root = () => `/api/management/workspaces/${f.scope.workspaceId}/workflows/${f.scope.workflowId}/schedule`
  const http = (method: 'GET' | 'PUT' | 'POST', path = '', payload?: Record<string, unknown>, token = f.writer.token) =>
    app!.inject({ method, url: `${root()}${path}`, headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }) })
  async function connect(token: string) {
    const client = new Client({ name: 'sch11-tests', version: '1.0.0' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }))
    return client
  }
  async function readback(client: Client) {
    const response = await http('GET', '', undefined, f.reader.token)
    expect(response.statusCode).toBe(200)
    const tool = await client.callTool({ name: 'workflow_schedule_get', arguments: f.scope })
    expect(tool.isError).not.toBe(true)
    const value = ScheduleGetResultSchema.parse(response.json())
    expect(ScheduleGetResultSchema.parse(decodeMcpToolResult(tool))).toEqual(value)
    return value
  }

  it('saves and reads scheduled attempts without login while preserving authenticated MCP readback', async () => {
    const body = { commandId: randomUUID(), expectedRevision: 0, schedule: futureOnce }
    const save = await fetch(new URL(root(), address), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    expect(save.status).toBe(200)
    const saved = ScheduleSaveResultSchema.parse(await save.json())
    expect(saved.replayed).toBe(false)
    expect(saved.value.nextOccurrenceAt).toBe('2099-01-01T10:00:00.000Z')
    const replay = await fetch(new URL(root(), address), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    expect(replay.status).toBe(200)
    expect(ScheduleSaveResultSchema.parse(await replay.json())).toEqual({ ...saved, replayed: true })
    const human = await new PostgresLocalHumanAccess(database.pool, f.access).current()
    const authority = await database.pool.query<{ owner_principal_id: string; actor_principal_id: string }>(
      'select owner_principal_id,actor_principal_id from workflow_schedule_authorities where workflow_id=$1',
      [f.scope.workflowId],
    )
    expect(authority.rows).toEqual([{ owner_principal_id: human.id, actor_principal_id: human.id }])
    expect(await f.countRuns()).toBe(0)
    f.time.now = saved.value.nextOccurrenceAt!
    await f.dispatcher().dispatch(saved.value)
    expect(await f.countRuns()).toBe(1)
    const response = await fetch(new URL(`${root()}/occurrences?limit=1`, address))
    expect(response.status).toBe(200)
    const page = ScheduleOccurrencePageSchema.parse(await response.json())
    expect(page.items).toEqual([expect.objectContaining({ status: 'accepted', scheduleRevision: 1 })])
    const reader = await connect(f.reader.token)
    const result = await reader.callTool({
      name: 'workflow_schedule_occurrences_list', arguments: { ...f.scope, limit: 1 },
    })
    expect(result.isError).not.toBe(true)
    expect(ScheduleOccurrencePageSchema.parse(decodeMcpToolResult(result))).toEqual(page)
    const unchanged = await fetch(new URL(root(), address), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, commandId: randomUUID(), expectedRevision: 1 }),
    })
    expect(unchanged.status).toBe(200)
    const current = ScheduleSaveResultSchema.parse(await unchanged.json()).value
    expect(current).toEqual({ ...saved.value, revision: 2, nextOccurrenceAt: null })
    expect(await readback(reader)).toEqual({ schedule: current })
    const invalid = await fetch(new URL(root(), address), {
      headers: { Authorization: 'Bearer invalid-schedule-credential' },
    })
    expect(invalid.status).toBe(401)
    expect(await f.countRuns()).toBe(1)
  }, 60_000)

  it.each(['accepted', 'rejected', 'missed', 'skipped'] as const)(
    'exposes the latest persisted %s attempt equally over authenticated HTTP and MCP, and denies foreign reads',
    async (status) => {
      let saved = await f.save(futureOnce)
      f.time.now = saved.nextOccurrenceAt!
      if (status === 'skipped') {
        await f.dispatcher().dispatch(saved)
        saved = await f.save({ ...futureOnce, time: '10:01' }, saved.revision)
        f.time.now = saved.nextOccurrenceAt!
      }
      if (status === 'missed') {
        f.time.now = new Date(Date.parse(f.time.now) + 5 * 60_000 + 1).toISOString()
      }
      const dispatcher = status === 'rejected' ? f.dispatcher(async () => {
        throw new DomainError('WORKFLOW_CONFIGURATION_STALE', 'Private native detail: credential-sentinel', 409)
      }) : f.dispatcher()
      await dispatcher.dispatch(saved)

      const reader = await connect(f.reader.token)
      const response = await http('GET', '/occurrences?limit=1', undefined, f.reader.token)
      expect(response.statusCode).toBe(200)
      const page = ScheduleOccurrencePageSchema.parse(response.json())
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({ ...f.scope, status, dueAt: saved.nextOccurrenceAt })
      expect(JSON.stringify(page)).not.toContain('credential-sentinel')
      if (status === 'accepted') expect(page.items[0]).toMatchObject({ runId: expect.any(String) })
      if (status === 'rejected') expect(page.items[0]).toMatchObject({ reason: 'workflow_not_executable' })
      if (status === 'missed') expect(page.items[0]).toMatchObject({ reason: 'outside_grace' })
      if (status === 'skipped') expect(page.items[0]).toMatchObject({ reason: 'overlap' })
      const result = await reader.callTool({ name: 'workflow_schedule_occurrences_list', arguments: { ...f.scope, limit: 1 } })
      expect(result.isError).not.toBe(true)
      expect(ScheduleOccurrencePageSchema.parse(decodeMcpToolResult(result))).toEqual(page)
      expect(await readback(reader)).toMatchObject({ schedule: { enabled: true, nextOccurrenceAt: null } })
      expect(await f.countRuns()).toBe(status === 'accepted' || status === 'skipped' ? 1 : 0)

      const outsider = await f.issue(['workflows:read', 'capabilities:read'], `foreign-${randomUUID()}`)
      const deniedClient = await connect(outsider.token)
      const before = await sch11DomainState(f)
      expect((await http('GET', '/occurrences?limit=1', undefined, outsider.token)).statusCode).toBe(403)
      const denied = await deniedClient.callTool({
        name: 'workflow_schedule_occurrences_list', arguments: { ...f.scope, limit: 1 },
      })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      expect(await sch11DomainState(f)).toEqual(before)
      const after = await http('GET', '/occurrences?limit=1', undefined, f.reader.token)
      expect(after.statusCode).toBe(200)
      expect(ScheduleOccurrencePageSchema.parse(after.json())).toEqual(page)
    }, 60_000,
  )

  it('save/enable/disable/clear/recreate round-trip across transports with replay and immutable history readback', async () => {
    const owner = await connect(f.writer.token), reader = await connect(f.reader.token)
    expect(await readback(reader)).toEqual({ schedule: null })
    const body = { commandId: randomUUID(), expectedRevision: 0, schedule: { ...futureOnce, enabled: false } }
    const created = await http('PUT', '', body)
    expect(created.statusCode).toBe(200)
    const saved = ScheduleSaveResultSchema.parse(created.json())
    expect(saved).toMatchObject({ replayed: false, value: { enabled: false, revision: 1, nextOccurrenceAt: null } })
    const replay = await owner.callTool({ name: 'workflow_schedule_save', arguments: { ...f.scope, ...body } })
    expect(replay.isError).not.toBe(true)
    expect(ScheduleSaveResultSchema.parse(decodeMcpToolResult(replay))).toEqual({ value: saved.value, replayed: true })
    expect(await readback(reader)).toEqual({ schedule: saved.value })
    expect(await f.countRuns()).toBe(0)

    const enable = { commandId: randomUUID(), expectedRevision: 1 }
    const enabledTool = await owner.callTool({ name: 'workflow_schedule_enable', arguments: { ...f.scope, ...enable } })
    expect(enabledTool.isError).not.toBe(true)
    const enabled = ScheduleSaveResultSchema.parse(decodeMcpToolResult(enabledTool))
    expect(enabled).toMatchObject({ replayed: false, value: { enabled: true, revision: 2, nextOccurrenceAt: '2099-01-01T10:00:00.000Z' } })
    const enabledReplay = await http('POST', '/enable', enable)
    expect(enabledReplay.statusCode).toBe(200)
    expect(enabledReplay.json()).toEqual({ value: enabled.value, replayed: true })
    expect(await readback(reader)).toEqual({ schedule: enabled.value })
    expect(await f.countRuns()).toBe(0)

    f.time.now = enabled.value.nextOccurrenceAt!
    await f.dispatcher().dispatch(enabled.value)
    const pageTool = await reader.callTool({ name: 'workflow_schedule_occurrences_list', arguments: { ...f.scope, limit: 1 } })
    expect(pageTool.isError).not.toBe(true)
    const page = ScheduleOccurrencePageSchema.parse(decodeMcpToolResult(pageTool))
    expect(page.items).toEqual([expect.objectContaining({ status: 'accepted', scheduleRevision: 2 })])
    const pageHttp = await http('GET', '/occurrences?limit=1', undefined, f.reader.token)
    expect(pageHttp.statusCode).toBe(200); expect(pageHttp.json()).toEqual(page)

    const disabledTool = await owner.callTool({ name: 'workflow_schedule_disable', arguments: f.command(2) })
    expect(disabledTool.isError).not.toBe(true)
    const disabled = ScheduleSaveResultSchema.parse(decodeMcpToolResult(disabledTool))
    expect(disabled.value).toMatchObject({ enabled: false, revision: 3, nextOccurrenceAt: null })
    expect(await readback(reader)).toEqual({ schedule: disabled.value })
    const clear = { commandId: randomUUID(), expectedRevision: 3 }
    const cleared = await http('POST', '/clear', clear)
    expect(cleared.statusCode).toBe(200)
    expect(ScheduleClearResultSchema.parse(cleared.json())).toEqual({ value: null, replayed: false })
    const clearReplay = await owner.callTool({ name: 'workflow_schedule_clear', arguments: { ...f.scope, ...clear } })
    expect(clearReplay.isError).not.toBe(true)
    expect(ScheduleClearResultSchema.parse(decodeMcpToolResult(clearReplay))).toEqual({ value: null, replayed: true })
    expect(await readback(reader)).toEqual({ schedule: null })
    const recreated = await owner.callTool({ name: 'workflow_schedule_save', arguments: {
      ...f.scope, ...body, commandId: randomUUID(),
    } })
    expect(recreated.isError).not.toBe(true)
    const current = ScheduleSaveResultSchema.parse(decodeMcpToolResult(recreated)).value
    expect(current.revision).toBe(5) // clear consumes the tombstone revision
    expect(await readback(reader)).toEqual({ schedule: current })
    const after = await http('GET', '/occurrences?limit=1', undefined, f.reader.token)
    expect(after.statusCode).toBe(200); expect(after.json()).toEqual(page)
    expect(await f.countRuns()).toBe(1)
  }, 60_000)

  it.each(deniedCases)('$caller: HTTP and MCP $operation deny without changing any domain state', async ({ caller, operation }) => {
    const saved = await f.save()
    const identity = caller === 'read-only' ? f.reader : await f.issue(sch11Actions, `foreign-${randomUUID()}`)
    const deniedClient = await connect(identity.token), reader = await connect(f.reader.token)
    const before = await sch11DomainState(f)
    const body = { commandId: randomUUID(), expectedRevision: saved.revision,
      ...(operation === 'save' ? { schedule: futureOnce } : {}) }
    const response = await http(operation === 'save' ? 'PUT' : 'POST', operation === 'save' ? '' : `/${operation}`, body, identity.token)
    expect(response.statusCode).toBe(403)
    expect(await sch11DomainState(f)).toEqual(before)
    const denied = await deniedClient.callTool({ name: `workflow_schedule_${operation}`, arguments: { ...f.scope, ...body } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await sch11DomainState(f)).toEqual(before)
    expect(await readback(reader)).toEqual({ schedule: saved })
  }, 60_000)

  it('foreign readers cannot read the schedule or history and remote unauthenticated writes cannot mutate', async () => {
    await f.save()
    const outsider = await f.issue(['workflows:read', 'capabilities:read'], `foreign-${randomUUID()}`)
    const client = await connect(outsider.token)
    const before = await sch11DomainState(f)
    for (const path of ['', '/occurrences']) expect((await http('GET', path, undefined, outsider.token)).statusCode).toBe(403)
    for (const name of ['workflow_schedule_get', 'workflow_schedule_occurrences_list']) {
      const result = await client.callTool({ name, arguments: f.scope })
      expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain('ACCESS_DENIED')
    }
    const anonymous = await app!.inject({ method: 'PUT', url: root(), remoteAddress: '192.0.2.1', payload: {
      commandId: randomUUID(), expectedRevision: 1, schedule: futureOnce,
    } })
    expect(anonymous.statusCode).toBe(403)
    expect(await sch11DomainState(f)).toEqual(before)
  }, 60_000)

  it('a revoked owner cannot replay an old successful HTTP command', async () => {
    const body = { commandId: randomUUID(), expectedRevision: 0, schedule: futureOnce }
    const first = await http('PUT', '', body)
    expect(first.statusCode).toBe(200)
    const before = await sch11DomainState(f)
    await database.pool.query('update management_principals set revoked_at=now() where id=$1', [f.writer.principal.id])
    const replay = await http('PUT', '', body)
    expect([401, 403]).toContain(replay.statusCode)
    expect(await sch11DomainState(f)).toEqual(before)
  }, 60_000)

  const invalid = [
    { name: 'duplicate weekday', schedule: { ...sch11Settings, mode: 'weekly', weekdays: [1, 1], time: '10:00' } },
    { name: 'invalid timezone', schedule: { ...futureOnce, timezone: 'EST' } },
    { name: 'zero-minute interval', schedule: { ...sch11Settings, mode: 'interval', every: 0, unit: 'minute', anchorAt: '2030-01-01T00:00:00.000Z' } },
    { name: 'past Once (even disabled)', schedule: { ...sch11Once, localDate: '2000-01-01', enabled: false } },
  ]
  it.each(invalid)('$name: HTTP and MCP reject invalid inputs without a receipt or mutation', async ({ schedule }) => {
    await f.save()
    const client = await connect(f.writer.token)
    const before = await sch11DomainState(f)
    const body = { commandId: randomUUID(), expectedRevision: 1, schedule }
    const response = await http('PUT', '', body)
    expect(response.statusCode).toBe(400)
    expect(await sch11DomainState(f)).toEqual(before)
    await client.callTool({ name: 'workflow_schedule_save', arguments: { ...f.scope, ...body } }).then((result) => {
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toMatch(/invalid|validation|schema/i)
    }, (error: unknown) => {
      // SDK schema validation may reject before the domain callback. Other
      // transport/network/server failures must not count as input validation.
      expect(error).toMatchObject({ code: -32602 })
    })
    expect(await sch11DomainState(f)).toEqual(before)
  }, 60_000)

  it('ignores an MCP caller cursor and persists the server-computed occurrence', async () => {
    await f.save()
    const client = await connect(f.writer.token)
    const before = await sch11DomainState(f)
    const body = { commandId: randomUUID(), expectedRevision: 1,
      schedule: { ...futureOnce, nextOccurrenceAt: '2098-01-01T00:00:00.000Z' } }
    expect((await http('PUT', '', body)).statusCode).toBe(400)
    expect(await sch11DomainState(f)).toEqual(before)
    const result = await client.callTool({ name: 'workflow_schedule_save', arguments: { ...f.scope, ...body } })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    const saved = ScheduleSaveResultSchema.parse(decodeMcpToolResult(result))
    expect(saved.value.revision).toBe(2)
    expect(saved.value.nextOccurrenceAt).toBe('2099-01-01T10:00:00.000Z')
    expect(await readback(client)).toEqual({ schedule: saved.value })
    expect(ScheduleSaveResultSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'workflow_schedule_save', arguments: { ...f.scope, ...body },
    })))).toEqual({ ...saved, replayed: true })
  }, 60_000)

  it('HTTP route scope cannot be replaced by a workspace/workflow in its body', async () => {
    await f.save()
    const before = await sch11DomainState(f)
    const response = await http('PUT', '', { commandId: randomUUID(), expectedRevision: 1, schedule: futureOnce,
      workspaceId: `foreign-${randomUUID()}`, workflowId: `foreign-${randomUUID()}` })
    expect(response.statusCode).toBe(400)
    expect(await sch11DomainState(f)).toEqual(before)
  }, 60_000)
})
