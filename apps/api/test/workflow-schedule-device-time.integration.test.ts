import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ScheduleGetResultSchema, ScheduleSaveResultSchema, scheduleUtcToLocalTime } from '@foreman-code/contracts/schedules'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { sch11DomainState, sch11Fixture, type Sch11Database, type Sch11Fixture } from './helpers/sch11Fixture.js'

describe.skipIf(!postgresEnabled)('device-time and seconds authenticated HTTP/MCP parity', () => {
  let database: Sch11Database
  let f: Sch11Fixture
  let app: ReturnType<typeof buildApp> | undefined
  let address: string
  let clients: Client[] = []
  beforeAll(async () => { database = await agent3Database() }, 60_000)
  afterAll(async () => { await database?.close() })
  beforeEach(async () => {
    f = await sch11Fixture(database)
    clients = []
    app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: f.access, services: { workflows: f.workflows, commands: f.commands } as unknown as OperatorServices } })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60_000)
  afterEach(async () => {
    await Promise.allSettled(clients.map((client) => client.close()))
    await app?.close()
  }, 30_000)
  async function connect(token: string) {
    const client = new Client({ name: 'device-time-proof', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }))
    return client
  }
  const root = () => `/api/management/workspaces/${f.scope.workspaceId}/workflows/${f.scope.workflowId}/schedule`
  async function readBoth(client: Client) {
    const http = await app!.inject({ method: 'GET', url: root(), headers: { authorization: `Bearer ${f.reader.token}` } })
    expect(http.statusCode).toBe(200)
    const mcp = await client.callTool({ name: 'workflow_schedule_get', arguments: f.scope })
    expect(mcp.isError).not.toBe(true)
    const result = ScheduleGetResultSchema.parse(http.json())
    expect(ScheduleGetResultSchema.parse(decodeMcpToolResult(mcp))).toEqual(result)
    return result.schedule!
  }

  it('different device calendar inputs persist the exact same Once UTC instant with replay and denied-caller readback', async () => {
    const owner = await connect(f.writer.token), reader = await connect(f.reader.token)
    const body = { commandId: randomUUID(), expectedRevision: 0,
      schedule: { mode: 'once', timezone: 'Asia/Tokyo', localDate: '2099-08-25', time: '00:30', enabled: true, policy: 'latest_saved' } }
    const first = await app!.inject({ method: 'PUT', url: root(), headers: { authorization: `Bearer ${f.writer.token}` }, payload: body })
    expect(first.statusCode).toBe(200)
    const saved = ScheduleSaveResultSchema.parse(first.json())
    expect(saved.value).toMatchObject({ timezone: 'UTC', localDate: '2099-08-24', time: '15:30', nextOccurrenceAt: '2099-08-24T15:30:00.000Z' })
    const replay = await owner.callTool({ name: 'workflow_schedule_save', arguments: { ...f.scope, ...body } })
    expect(ScheduleSaveResultSchema.parse(decodeMcpToolResult(replay))).toEqual({ value: saved.value, replayed: true })
    expect(await readBoth(reader)).toEqual(saved.value)
    const edited = await owner.callTool({ name: 'workflow_schedule_save', arguments: { ...f.command(1),
      schedule: { ...body.schedule, timezone: 'America/Los_Angeles', localDate: '2099-08-24', time: '08:30' } } })
    expect(edited.isError).not.toBe(true)
    const second = ScheduleSaveResultSchema.parse(decodeMcpToolResult(edited)).value
    expect(second).toEqual({ ...saved.value, revision: 2 })
    expect(scheduleUtcToLocalTime(second.nextOccurrenceAt!, 'Asia/Tokyo')).toEqual({ localDate: '2099-08-25', time: '00:30' })
    expect(scheduleUtcToLocalTime(second.nextOccurrenceAt!, 'America/Los_Angeles')).toEqual({ localDate: '2099-08-24', time: '08:30' })
    const before = await sch11DomainState(f)
    const denied = await reader.callTool({ name: 'workflow_schedule_save', arguments: { ...f.command(2), schedule: body.schedule } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await sch11DomainState(f)).toEqual(before)
    expect(await readBoth(reader)).toEqual(second)
    expect(await f.countRuns()).toBe(0)
  }, 60_000)

  it('Seconds saves/readback/edit/replay use UTC anchors and retain write grants', async () => {
    const owner = await connect(f.writer.token), reader = await connect(f.reader.token)
    const schedule = { mode: 'interval', timezone: 'Asia/Tokyo', every: 1, unit: 'second',
      anchorAt: '2099-08-25T00:30:17.250+09:00', enabled: true, policy: 'latest_saved' }
    const tools = await owner.listTools()
    const saveTool = tools.tools.find((tool) => tool.name === 'workflow_schedule_save')!
    expect(saveTool.description).toContain('whole seconds, minutes or hours')
    expect(saveTool.description).toContain('caller device')
    expect(JSON.stringify(saveTool.inputSchema)).toContain('second')
    const input = { ...f.command(0), schedule }
    const savedTool = await owner.callTool({ name: 'workflow_schedule_save', arguments: input })
    expect(savedTool.isError).not.toBe(true)
    const saved = ScheduleSaveResultSchema.parse(decodeMcpToolResult(savedTool)).value
    expect(saved).toMatchObject({ every: 1, unit: 'second', anchorAt: '2099-08-24T15:30:17.250Z', nextOccurrenceAt: '2099-08-24T15:30:17.250Z' })
    expect(await readBoth(reader)).toEqual(saved)
    const replay = await owner.callTool({ name: 'workflow_schedule_save', arguments: input })
    expect(ScheduleSaveResultSchema.parse(decodeMcpToolResult(replay))).toEqual({ value: saved, replayed: true })
    const edit = await app!.inject({ method: 'PUT', url: root(), headers: { authorization: `Bearer ${f.writer.token}` },
      payload: { commandId: randomUUID(), expectedRevision: 1, schedule: { ...schedule, every: 2 } } })
    expect(edit.statusCode).toBe(200)
    const current = ScheduleSaveResultSchema.parse(edit.json()).value
    expect(current).toMatchObject({ every: 2, unit: 'second', anchorAt: saved.mode === 'interval' ? saved.anchorAt : null })
    expect(await readBoth(reader)).toEqual(current)
    const before = await sch11DomainState(f)
    const denied = await reader.callTool({ name: 'workflow_schedule_save', arguments: { ...f.command(2), schedule } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await sch11DomainState(f)).toEqual(before)
    expect(await f.countRuns()).toBe(0)
  }, 60_000)

  it.each([0, -1, 0.5])('rejects invalid %s Seconds through HTTP and MCP without persistence', async (every) => {
    const owner = await connect(f.writer.token)
    const schedule = { mode: 'interval', timezone: 'UTC', every, unit: 'second', anchorAt: '2099-08-24T15:30:00.000Z', enabled: true, policy: 'latest_saved' }
    const before = await sch11DomainState(f)
    const body = { commandId: randomUUID(), expectedRevision: 0, schedule }
    const http = await app!.inject({ method: 'PUT', url: root(), headers: { authorization: `Bearer ${f.writer.token}` }, payload: body })
    expect(http.statusCode).toBe(400)
    await owner.callTool({ name: 'workflow_schedule_save', arguments: { ...f.scope, ...body } }).then((result) => {
      expect(result.isError).toBe(true)
    }, (error: unknown) => { expect(error).toMatchObject({ code: -32602 }) })
    expect(await sch11DomainState(f)).toEqual(before)
    expect(await f.countRuns()).toBe(0)
  }, 60_000)

  it('admits an owned test Seconds occurrence using the server clock and exact UTC due instant', async () => {
    const dueAt = '2030-01-07T09:00:01.250Z'
    const saved = await f.save({ mode: 'interval', unit: 'second', every: 1, timezone: 'Asia/Tokyo',
      anchorAt: '2030-01-07T18:00:01.250+09:00', enabled: true, policy: 'latest_saved' })
    expect(saved.nextOccurrenceAt).toBe(dueAt)
    await f.dispatcher().dispatch(saved)
    expect(await f.countRuns()).toBe(0)
    f.time.now = dueAt
    await f.dispatcher().dispatch(saved)
    expect(await f.countRuns()).toBe(1)
    const history = await f.history()
    expect(history).toEqual([expect.objectContaining({ status: 'accepted', dueAt, scheduleRevision: saved.revision,
      workflowVersionId: f.fixture.version.id })])
    expect((await f.current())?.nextOccurrenceAt).toBe('2030-01-07T09:00:02.250Z')
  }, 60_000)
})
