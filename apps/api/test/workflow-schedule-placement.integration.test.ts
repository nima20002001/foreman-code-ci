import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScheduleGetResultSchema, ScheduleSaveResultSchema } from '@foreman-code/contracts/schedules'
import { ApprovedSourceSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { HostHarnessOverrideListSchema } from '@foreman-code/contracts/harness-registry'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { ScheduleOccurrencePageSchema } from '../src/modules/schedules/transportSchemas.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { sch11Fixture, sch11DomainState, type Sch11Database, type Sch11Fixture } from './helpers/sch11Fixture.js'
import { sch11Once } from './helpers/sch11ClockCases.js'
import { schedulePlacementFixture } from './helpers/schedulePlacementFixture.js'
import { scheduleDevicePlacementFixture } from './helpers/scheduleDevicePlacementFixture.js'
import { assertDeviceHostInstallation } from '../src/modules/devices/hostAuthorization.js'

describe.skipIf(!postgresEnabled)('scheduled placement rejection', () => {
  let database: Sch11Database
  let f: Sch11Fixture
  beforeEach(async () => {
    database = await agent3Database()
    f = await sch11Fixture(database)
  }, 60_000)
  afterEach(async () => { await database?.close() })

  it.each(['disabled instance', 'unavailable source', 'revoked device'] as const)(
    'records %s rejection through authenticated HTTP/MCP history with denied callers', async (change) => {
    const mainPlacement = await schedulePlacementFixture(f)
    const device = change === 'revoked device' ? await scheduleDevicePlacementFixture(f, mainPlacement) : undefined
    const placement = device ?? mainPlacement
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: f.access, services: { workflows: f.workflows, commands: f.commands,
        sources: placement.sources, harnessInstances: placement.harness.service } as OperatorServices } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'schedule-placement-regression', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }))
        return client
      }
      const owner = await connect(placement.writer.token)
      const reader = await connect(f.reader.token)
      const root = `/api/management/workspaces/${f.scope.workspaceId}/workflows/${f.scope.workflowId}/schedule`
      const input = { ...f.command(0), schedule: { ...sch11Once, localDate: '2099-01-01' } }
      const created = await owner.callTool({ name: 'workflow_schedule_save', arguments: input })
      expect(created.isError).not.toBe(true)
      const saved = ScheduleSaveResultSchema.parse(decodeMcpToolResult(created)).value
      const approved = await owner.callTool({ name: 'source_get', arguments: {
        workspaceId: f.scope.workspaceId, ...placement.source,
      } })
      expect(approved.isError).not.toBe(true)
      expect(ApprovedSourceSchema.parse(decodeMcpToolResult(approved)).manifest.manifestDigest).toBe(placement.source.manifestDigest)
      const bound = await owner.callTool({ name: 'source_root_get', arguments: {
        workspaceId: f.scope.workspaceId, rootId: placement.root.binding.rootId,
        bindingRevision: placement.root.binding.bindingRevision,
      } })
      expect(bound.isError).not.toBe(true)
      expect(SourceRootRecordSchema.parse(decodeMcpToolResult(bound))).toEqual(placement.root)
      const profiles = await owner.callTool({ name: 'harness_instances_list', arguments: {
        hostRef: placement.policy.hostRef, applicationInstallationId: placement.policy.applicationInstallationId,
      } })
      expect(profiles.isError).not.toBe(true)
      expect(HostHarnessOverrideListSchema.parse(decodeMcpToolResult(profiles)).overrides).toHaveLength(placement.harness.settings.length)
      expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain('source_get')
      const sourceOutsider = await f.issue(['sources:read', 'capabilities:read'], randomUUID())
      const sourceReader = await connect(sourceOutsider.token)
      const deniedSource = await sourceReader.callTool({ name: 'source_get', arguments: {
        workspaceId: f.scope.workspaceId, ...placement.source,
      } })
      expect(deniedSource.isError).toBe(true)
      expect(JSON.stringify(deniedSource.content)).toContain('ACCESS_DENIED')
      let reason = 'workflow_not_executable'
      if (change === 'disabled instance') await placement.harness.changeInstance({ enabled: false })
      if (change === 'unavailable source') {
        await database.pool.query("update source_snapshots set availability='unavailable' where snapshot_id=$1",
          [placement.source.snapshotId])
        const unavailable = await owner.callTool({ name: 'source_get', arguments: {
          workspaceId: f.scope.workspaceId, ...placement.source,
        } })
        expect(unavailable.isError).toBe(true)
        expect(JSON.stringify(unavailable.content)).toContain('SOURCE_UNAVAILABLE')
      }
      if (device) {
        const revoked = await device.revoke()
        expect(revoked.status).toBe('revoked')
        await expect(assertDeviceHostInstallation(database.pool, placement.policy.hostRef,
          placement.policy.applicationInstallationId)).rejects.toMatchObject({ code: 'revoked' })
        reason = 'schedule_authorization_denied'
      }
      placement.restart()
      await placement.recover()
      f.time.now = saved.nextOccurrenceAt!
      const dispatcher = f.dispatcher(async (principal, start, schedule) => {
        await admitRepeatRun(database.pool, f.locations, principal, 'schedule', start,
          { ...repeatStartPublication, placementAdmission: placement.producer,
            ...(device ? { workerExecution: device.workerExecution } : {}) }, { schedule })
      })
      await dispatcher.dispatch(saved)
      const history = await reader.callTool({ name: 'workflow_schedule_occurrences_list', arguments: f.scope })
      expect(history.isError).not.toBe(true)
      const page = ScheduleOccurrencePageSchema.parse(decodeMcpToolResult(history))
      expect(page.items).toEqual([expect.objectContaining({ dueAt: saved.nextOccurrenceAt,
        status: 'rejected', reason })])
      const http = await app.inject({ method: 'GET', url: `${root}/occurrences`,
        headers: { authorization: `Bearer ${f.reader.token}` } })
      expect(http.statusCode).toBe(200)
      expect(http.json()).toEqual(page)
      expect((await f.current())?.nextOccurrenceAt).toBeNull()
      const readback = await reader.callTool({ name: 'workflow_schedule_get', arguments: f.scope })
      expect(readback.isError).not.toBe(true)
      expect(ScheduleGetResultSchema.parse(decodeMcpToolResult(readback)).schedule).toEqual(await f.current())
      expect(await f.countRuns()).toBe(0)
      await f.dispatcher(async (principal, start, schedule) => {
        await admitRepeatRun(database.pool, f.locations, principal, 'schedule', start,
          { ...repeatStartPublication, placementAdmission: placement.producer,
            ...(device ? { workerExecution: device.workerExecution } : {}) }, { schedule })
      }).dispatch(saved)
      expect(await f.history()).toEqual(page.items)
      const before = await sch11DomainState(f)
      const denied = await reader.callTool({ name: 'workflow_schedule_save', arguments: {
        ...input, commandId: randomUUID(), expectedRevision: 1,
      } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      const foreign = await f.issue(['workflows:read', 'capabilities:read'], randomUUID())
      const foreignClient = await connect(foreign.token)
      const deniedHistory = await foreignClient.callTool({ name: 'workflow_schedule_occurrences_list', arguments: f.scope })
      expect(deniedHistory.isError).toBe(true)
      expect(JSON.stringify(deniedHistory.content)).toContain('ACCESS_DENIED')
      expect(await sch11DomainState(f)).toEqual(before)
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()))
      await app.close()
    }
  }, 30_000)

  it('retains the due occurrence while a changed instance revision needs native qualification', async () => {
    const placement = await schedulePlacementFixture(f)
    const saved = await placement.save()
    await placement.changeInstance()
    placement.restart()
    await placement.recover()
    f.time.now = saved.nextOccurrenceAt!
    const dispatcher = f.dispatcher(async (principal, input, schedule) => {
      await admitRepeatRun(database.pool, f.locations, principal, 'schedule', input,
        { ...repeatStartPublication, placementAdmission: placement.producer }, { schedule })
    })
    await expect(dispatcher.dispatch(saved)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
    expect(await f.history()).toEqual([])
    expect(await f.current()).toEqual(saved)
    expect(await f.countRuns()).toBe(0)
  }, 30_000)

  it('retains a due Once across restart and retries the real path after inventory recovery', async () => {
    const placement = await schedulePlacementFixture(f)
    const saved = await placement.save()
    f.time.now = saved.nextOccurrenceAt!
    placement.restart()
    const dispatcher = () => f.dispatcher(async (principal, input, schedule) => {
      await admitRepeatRun(database.pool, f.locations, principal, 'schedule', input,
        { ...repeatStartPublication, placementAdmission: placement.producer }, { schedule })
    })
    const before = await sch11DomainState(f)
    await expect(dispatcher().dispatch(saved)).rejects.toMatchObject({ code: 'HARNESS_INVENTORY_UNAVAILABLE' })
    expect(await sch11DomainState(f)).toEqual(before)
    expect(await f.history()).toEqual([])
    expect(await f.current()).toEqual(saved)
    expect(await f.countRuns()).toBe(0)
    await placement.recover()
    // Native qualification has not run in this database test. Inventory recovery
    // reaches its real persisted profile check while retaining the same occurrence.
    await expect(dispatcher().dispatch((await f.current())!)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
    expect(await sch11DomainState(f)).toEqual(before)
    expect(await f.history()).toEqual([])
    expect(await f.current()).toEqual(saved)
    expect(await f.countRuns()).toBe(0)
  }, 30_000)

  it('persists installation removal as a rejection after complete discovery and restart', async () => {
    const placement = await schedulePlacementFixture(f)
    const saved = await placement.save()
    const selected = placement.harness.settings[0]!
    await placement.harness.changeBinary(join(database.directory, 'removed-codex'))
    placement.restart()
    await placement.recover()
    expect(placement.harness.registry.installations.list().some(installation =>
      installation.harnessInstallationId === selected.target.harnessInstallationId)).toBe(false)
    expect(() => placement.harness.registry.pinOverride(selected))
      .toThrow(expect.objectContaining({ code: 'HARNESS_INSTALLATION_CHANGED' }))
    f.time.now = saved.nextOccurrenceAt!
    const dispatcher = () => f.dispatcher(async (principal, input, schedule) => {
      await admitRepeatRun(database.pool, f.locations, principal, 'schedule', input,
        { ...repeatStartPublication, placementAdmission: placement.producer }, { schedule })
    })
    await dispatcher().dispatch(saved)
    const history = await f.history()
    expect(history).toEqual([expect.objectContaining({ dueAt: saved.nextOccurrenceAt,
      status: 'rejected', reason: 'workflow_not_executable' })])
    expect((await f.current())?.nextOccurrenceAt).toBeNull()
    placement.restart()
    await placement.recover()
    await dispatcher().dispatch(saved)
    expect(await f.history()).toEqual(history)
    expect(await f.countRuns()).toBe(0)
  }, 30_000)

  it.each(['host configuration', 'disabled instance'] as const)('rejects changed %s before grace expires', async (change) => {
    const placement = await schedulePlacementFixture(f)
    const saved = await placement.save()
    if (change === 'host configuration') await placement.changeHostConfiguration()
    else await placement.harness.changeInstance({ enabled: false })
    f.time.now = saved.nextOccurrenceAt!
    await f.dispatcher(async (principal, input, schedule) => {
      await admitRepeatRun(database.pool, f.locations, principal, 'schedule', input,
        { ...repeatStartPublication, placementAdmission: placement.producer }, { schedule })
    }).dispatch(saved)
    expect(await f.history()).toEqual([expect.objectContaining({
      dueAt: saved.nextOccurrenceAt, status: 'rejected', reason: 'workflow_not_executable',
    })])
    expect((await f.current())?.nextOccurrenceAt).toBeNull()
    expect(await f.countRuns()).toBe(0)
  }, 30_000)
})
