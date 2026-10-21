import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CI_HOST_NAMESPACE, CI_HOST_START_PROTOCOL_VERSION, CiComputersOutputSchema, CiGetOutputSchema, CiHostRequestSchema,
  CiRunOutputSchema, CiRunRecordSchema, type CiHostReply, type CiHostRequest, type CiHostRun } from '@foreman-code/contracts'
import { BuildComputerStatusSchema, BuildComputerBatchResultSchema } from '@foreman-code/contracts/build-computers'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { ProductionHostCiEndpoint } from '../src/modules/ci-host/endpoint.js'
import { HostCiService } from '../src/modules/ci-host/service.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { BuildComputerSettings } from '../src/modules/settings/buildComputers.js'
import { buildComputerFixture } from './helpers/buildComputerFixture.js'
import { deferred } from './helpers/deferred.js'
import { agent3Database } from './helpers/wave25Agent3.js'

it('honors persisted MCP build participation and priority while retaining assigned run control', async () => {
  const db = await agent3Database()
  const clients: Client[] = []
  let preferredStatusRequested = deferred()
  let preferredStatusReleased = deferred()
  let app: ReturnType<typeof buildApp> | undefined
  let ci: HostCiService | undefined
  try {
    const workspaceId = randomUUID()
    const mainId = (await db.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId,
      JSON.stringify({ id: workspaceId, name: 'CI preferences fixture', repository: {
        provider: 'github', owner: 'fixture-owner', name: 'fixture-repository', defaultBranch: 'main',
      } })])
    const devices = [0, 1, 2].map(() => buildComputerFixture(mainId, workspaceId))
    for (const { registration } of devices) {
      await db.pool.query(`insert into device_registrations
        (id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,'fixture',$4::jsonb)`,
      [registration.deviceId, mainId, registration.workerInstallationId, JSON.stringify(registration)])
    }
    const main: DeviceProvisioningTarget = { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
      keyRevision: null, authorizationRevision: null }
    const runs = new Map<string, { computer: string; run: CiHostRun }>()
    const starts: string[] = []
    const requests = new Map<string, CiHostRequest>()
    const outdated = new Set<string>()
    let holdPreferredStatus = false
    const cancelAcknowledgements = new Set<string>()
    const request = async (computer: string, input: CiHostRequest): Promise<CiHostReply> => {
      if (input.operation === 'status') {
        if (holdPreferredStatus && computer === devices[1]!.registration.deviceId) {
          preferredStatusRequested.resolve()
          await preferredStatusReleased.promise
        }
        return { operation: 'status', ready: true, reasons: [],
          ...(!outdated.has(computer) ? { startProtocolVersion: CI_HOST_START_PROTOCOL_VERSION } : {}),
          cpuCount: 8, memoryBytes: 16 * 2 ** 30,
          runs: [...runs.values()].filter(entry => entry.computer === computer).map(entry => entry.run) }
      }
      if (input.operation === 'start') {
        const run: CiHostRun = { runId: input.runId, state: 'running', step: input.suite, exitCode: null,
          startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0, message: null }
        runs.set(input.runId, { computer, run })
        starts.push(computer)
        requests.set(input.runId, input)
        return { operation: 'start', run }
      }
      const entry = runs.get(input.runId)!
      if (input.operation === 'cancel') {
        // The computer acknowledges cancellation only after the caller sees the pending response.
        if (!cancelAcknowledgements.has(input.runId)) return { operation: 'cancel', run: entry.run }
        entry.run = { ...entry.run, state: 'canceled', finishedAt: new Date().toISOString() }
        return { operation: 'cancel', run: entry.run }
      }
      return { operation: 'read', run: entry.run, text: '', nextOffset: input.afterOffset }
    }
    const endpoint = new ProductionHostCiEndpoint(db.pool, mainId, () => ({
      capabilities: () => [{ namespace: CI_HOST_NAMESPACE, mainCanRequest: true }],
      request: async (deviceId, _namespace, payload) => ({ payload: await request(deviceId, CiHostRequestSchema.parse(payload)) }),
    }), { handle: input => request('main', CiHostRequestSchema.parse(input)) }, [], undefined,
    new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }))
    const commands = new PostgresCommandCoordinator(db.pool)
    const settings = new BuildComputerSettings(db.pool, commands, async () => ({
      state: 'ready', reasons: [], remoteExecutionEnabled: true,
    }))
    const access = new PostgresAccessService(db.pool)
    ci = new HostCiService(db.pool, commands, new RunCiAuthority(db.pool), {
      capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
      resolve: async () => 'a'.repeat(40),
    }, endpoint)
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { commands, ci, buildComputers: settings } as unknown as OperatorServices } })
    const address = await app.listen({ port: 0 })
    const connect = async (actions: ManagementAction[]) => {
      const issued = await access.issue({ name: 'CI preferences caller', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: actions.length ? [{ actions, scope: {} }] : [] })
      const client = new Client({ name: 'ci-preferences-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
      return client
    }
    const writer = await connect([...CI_GET_ACTIONS, ...CI_RUN_ACTIONS, 'jobs:cancel', 'settings:read', 'settings:update'])
    const reader = await connect([...CI_GET_ACTIONS, 'settings:read'])
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      return decodeMcpToolResult(result)
    }
    const read = async (target: DeviceProvisioningTarget) => BuildComputerStatusSchema.parse(
      await call(reader, 'build_computer_get', { target }))
    const save = async (target: DeviceProvisioningTarget, buildEnabled: boolean, buildPriority: number,
      buildAllowancePercent = 100) => {
      const old = await read(target)
      const saved = BuildComputerStatusSchema.parse(await call(writer, 'build_computer_update', {
        target, expectedRevision: old.preference.revision,
        buildEnabled, buildPriority, buildAllowancePercent,
      }))
      expect(await read(target)).toEqual(saved)
      return saved
    }
    const saveBatch = async (target: DeviceProvisioningTarget) => {
      const old = await read(target)
      const result = BuildComputerBatchResultSchema.parse(await call(writer, 'build_computers_update', { updates: [{
        target, expectedRevision: old.preference.revision, buildEnabled: old.preference.buildEnabled,
        buildPriority: old.preference.buildPriority,
      }] }))
      expect(await read(target)).toEqual(BuildComputerStatusSchema.parse(result.computers[0]))
    }
    const list = async () => CiComputersOutputSchema.parse(await call(reader, 'ci_computers_list', { workspaceId }))
    const start = async () => CiRunOutputSchema.parse(await call(writer, 'ci_run', {
      workspaceId, suite: 'install',
    }))
    const get = async (ticketId: string, waitSeconds = 0) => CiGetOutputSchema.parse(
      await call(reader, 'ci_get', { workspaceId, ticketId, waitSeconds, logTail: false }))
    const getRunning = async (ticketId: string) => {
      const deadline = performance.now() + 5000
      await ci!.dispatch()
      let output = await get(ticketId)
      // ci_get waits on persisted ticket changes; dispatch and live observation can finish separately.
      while (['queued', 'starting', 'running'].includes(output.run.state)
        && (output.run.state !== 'running' || output.run.observation?.status !== 'available')) {
        const remaining = deadline - performance.now()
        expect(remaining, JSON.stringify(output)).toBeGreaterThan(0)
        // A completed change can precede this next-change request; re-read within one dispatch cadence.
        output = await get(ticketId, Math.min(1, remaining / 1000))
      }
      expect(output.run).toMatchObject({ state: 'running', observation: { status: 'available' } })
      return output
    }
    const getSettled = async (ticketId: string) => {
      await ci!.dispatch()
      const output = CiGetOutputSchema.parse(await call(reader, 'ci_get', {
        workspaceId, ticketId, waitUntil: 'group-terminal', waitSeconds: 5, logTail: false,
      }))
      expect(output.wait?.status).toBe('settled')
      return output
    }
    const cancel = async (...ticketIds: string[]) => {
      const inputs = ticketIds.map(ticketId => ({ workspaceId, ticketId, commandId: randomUUID() }))
      for (const input of inputs) {
        const pending = await writer.callTool({ name: 'ci_cancel', arguments: input })
        expect(pending.isError).toBe(true)
        expect(decodeMcpToolResult(pending)).toMatchObject({ error: { code: 'CI_CANCEL_PENDING' } })
        cancelAcknowledgements.add(input.ticketId)
      }
      // Cancel every partition before waiting for the whole group to settle.
      const completed = await getSettled(ticketIds[0]!)
      expect(completed.wait).toMatchObject({ tickets: ticketIds.length, settledTickets: ticketIds.length })
      expect((completed.partitions ?? [completed.run]).map(run => run.state))
        .toEqual(ticketIds.map(() => 'canceled'))
      for (const input of inputs) {
        expect(await call(writer, 'ci_cancel', input)).toMatchObject({ run: { state: 'canceled' } })
      }
    }

    expect((await list()).computers).toEqual([])
    await save(main, false, 100)
    await saveBatch(main)
    await save(devices[0]!.target, true, 20)
    const high = await save(devices[1]!.target, true, 90, 50)
    await save(devices[2]!.target, false, 100)
    expect((await list()).computers.map(computer => computer.hostRef)).toEqual([
      devices[1]!.target.hostRef, devices[0]!.target.hostRef,
    ])
    const denied = await reader.callTool({ name: 'build_computer_update', arguments: {
      target: devices[1]!.target, expectedRevision: high.preference.revision,
      buildEnabled: false, buildPriority: 0,
    } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await read(devices[1]!.target)).toEqual(high)
    expect((await reader.callTool({ name: 'ci_run', arguments: {
      workspaceId, suite: 'install',
    } })).isError).toBe(true)
    expect((await db.pool.query('select count(*)::int as count from ci_runs')).rows[0]!.count).toBe(0)

    outdated.add(devices[1]!.registration.deviceId)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 5001)
    const incompatible = (await list()).computers.find(computer => computer.hostRef.deviceId === devices[1]!.registration.deviceId)
    expect(incompatible).toMatchObject({ ready: false, reasons: [expect.stringMatching(/CI start protocol.*update/i)] })
    const protocolTicket = await start()
    const protocolRead = await getRunning(protocolTicket.ticketId)
    expect(protocolRead.run.computer?.hostRef).toEqual(devices[0]!.target.hostRef)
    expect((await db.pool.query('select record from ci_runs where id=$1', [protocolTicket.ticketId])).rows[0]!.record)
      .toEqual(protocolRead.run)
    const ungranted = await connect([])
    expect((await ungranted.listTools()).tools.map(tool => tool.name)).not.toContain('ci_computers_list')
    const deniedList = await ungranted.callTool({ name: 'ci_computers_list', arguments: { workspaceId } })
    expect(deniedList.isError).toBe(true)
    expect(JSON.stringify(deniedList.content)).toContain('ACCESS_DENIED')
    expect(await read(devices[1]!.target)).toEqual(high)
    expect((await get(protocolTicket.ticketId)).run).toEqual({ ...protocolRead.run,
      observation: { status: 'available', lastSuccessAt: expect.any(String), lastError: null,
        consecutiveFailures: 0, nextAttemptAt: null } })
    await cancel(protocolTicket.ticketId)
    await ci.drain()
    outdated.clear()
    // Keep the preferred Worker's readiness refresh pending through dispatch, independent of database timing.
    holdPreferredStatus = true
    vi.setSystemTime(Date.now() + 5001)
    starts.length = 0

    // Cache expiry starts a background refresh; priority is only comparable after readiness is observed.
    const readiness = list()
    await preferredStatusRequested.promise
    preferredStatusReleased.resolve()
    expect((await readiness).computers.find(computer => computer.hostRef.deviceId === devices[1]!.registration.deviceId))
      .toMatchObject({ ready: true, reasons: [], priority: 90, slotsUsed: 0, slotsTotal: 1 })
    const first = await start()
    const firstRead = await getRunning(first.ticketId)
    expect(firstRead.run.computer?.hostRef).toEqual(devices[1]!.target.hostRef)
    expect((await db.pool.query('select record from ci_runs where id=$1', [first.ticketId])).rows[0]!.record)
      .toEqual(firstRead.run)
    const staleComputer = (await endpoint.computers())[0]!
    await save(devices[1]!.target, false, 90)
    await expect(endpoint.request(staleComputer, { operation: 'start', runId: randomUUID(),
      repository: 'fixture-owner/fixture-repository', commit: 'a'.repeat(40), suite: 'install' }))
      .rejects.toMatchObject({ code: 'BUILD_COMPUTER_DISABLED' })
    expect((await get(first.ticketId)).run.state).toBe('running')
    expect(await call(reader, 'ci_logs_read', { workspaceId, ticketId: first.ticketId })).toMatchObject({ text: '' })
    const second = await start()
    expect((await getRunning(second.ticketId)).run.computer?.hostRef).toEqual(devices[0]!.target.hostRef)
    await save(main, true, 100)
    const third = await start()
    expect((await getRunning(third.ticketId)).run.computer?.hostRef).toEqual(main.hostRef)
    expect(starts).toEqual([devices[1]!.registration.deviceId, devices[0]!.registration.deviceId, 'main'])
    await cancel(first.ticketId)
    expect((await get(first.ticketId)).run.state).toBe('canceled')
    const entry = runs.get(second.ticketId)!
    entry.run = { ...entry.run, state: 'passed', exitCode: 0, finishedAt: new Date().toISOString() }
    await save(devices[0]!.target, false, 20)
    const completed = await getSettled(second.ticketId)
    expect(completed.wait).toMatchObject({ status: 'settled', tickets: 1, settledTickets: 1 })
    expect(completed.run.state).toBe('passed')
    expect((await db.pool.query('select state from ci_runs where id=$1', [second.ticketId])).rows[0]!.state).toBe('passed')
    await db.pool.query('update build_computer_preferences set target=$1::jsonb where host_key=$2',
      [JSON.stringify({ ...main, applicationInstallationId: randomUUID() }), `${mainId}:main`])
    expect((await read(main)).preference.buildEnabled).toBe(false)
    expect((await list()).computers).toEqual([])
    expect((await get(third.ticketId)).run.state).toBe('running')
    await cancel(third.ticketId)
    await ci.drain()
    preferredStatusRequested = deferred()
    preferredStatusReleased = deferred()
    await save(main, false, 100)
    await save(devices[0]!.target, true, 20)
    await save(devices[1]!.target, true, 90, 50)
    for (const [index, device, seconds] of [[0, devices[1]!, 400], [1, devices[0]!, 200]] as const) {
      const finishedAt = new Date(Date.now() - 60_000)
      const startedAt = new Date(finishedAt.getTime() - seconds * 1000).toISOString()
      const history = CiRunRecordSchema.parse({ id: randomUUID(), workspaceId, groupId: randomUUID(),
        suite: 'integration', repository: 'fixture-owner/fixture-repository', commit: 'b'.repeat(40),
        partition: { index, count: 2 }, state: 'passed', step: 'integration', exitCode: 0, message: null,
        computer: { hostRef: device.target.hostRef, label: 'Build computer' },
        queuedAt: startedAt, startedAt, finishedAt: finishedAt.toISOString(),
        initiator: { principalId: 'fixture-history', executionId: null } })
      await db.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
        values($1,$2,$3,'passed',$4::jsonb)`, [history.id, workspaceId, history.groupId, JSON.stringify(history)])
    }
    // Re-enabled workers need observed readiness before comparing partition priority and capacity.
    const partitionReadiness = list()
    await preferredStatusRequested.promise
    preferredStatusReleased.resolve()
    expect((await partitionReadiness).computers).toMatchObject([
      { hostRef: devices[1]!.target.hostRef, ready: true, reasons: [], priority: 90, buildAllowancePercent: 50,
        slotsUsed: 0, slotsTotal: 1 },
      { hostRef: devices[0]!.target.hostRef, ready: true, reasons: [], priority: 20, buildAllowancePercent: 100,
        slotsUsed: 0, slotsTotal: 1 },
    ])
    const partitioned = CiRunOutputSchema.parse(await call(writer, 'ci_run', {
      workspaceId, suite: 'integration', commandId: randomUUID(), partitions: 2,
    }))
    expect(partitioned.partitions).toHaveLength(2)
    for (const ticket of partitioned.partitions!) await getRunning(ticket.ticketId)
    const partitionRead = await get(partitioned.ticketId)
    const higher = partitionRead.partitions!.find(run => run.partition?.index === 0)!
    const lower = partitionRead.partitions!.find(run => run.partition?.index === 1)!
    expect(requests.get(higher.id)).toMatchObject({ operation: 'start', buildAllowancePercent: 50 })
    expect(requests.get(lower.id)).toMatchObject({ operation: 'start', buildAllowancePercent: 100 })
    expect((await read(devices[1]!.target)).preference.buildAllowancePercent).toBe(50)
    expect(higher.computer?.hostRef).toEqual(devices[1]!.target.hostRef)
    expect(lower.computer?.hostRef).toEqual(devices[0]!.target.hostRef)
    expect(higher.partition!.weights).toEqual(lower.partition!.weights)
    expect(higher.partition!.weights![0]! / higher.partition!.weights![1]!).toBeCloseTo(0.5, 1)
    await cancel(...partitioned.partitions!.map(ticket => ticket.ticketId))
    const smokeInput = { workspaceId, suite: 'integration', scope: 'affected', commit: 'a'.repeat(40),
      commandId: randomUUID(), files: ['apps/api/test/feature.integration.test.ts'],
      smokeComputer: devices[1]!.target.hostRef }
    expect((await reader.callTool({ name: 'ci_run', arguments: smokeInput })).isError).toBe(true)
    const smoke = CiRunOutputSchema.parse(await call(writer, 'ci_run', smokeInput))
    const smokeRead = await getRunning(smoke.ticketId)
    expect(smokeRead.run).toMatchObject({ state: 'running', integrationShards: 4,
      smokeComputer: smokeInput.smokeComputer, computer: { hostRef: smokeInput.smokeComputer } })
    expect(requests.get(smoke.ticketId))
      .toMatchObject({ gate: true, integrationShards: 4, buildAllowancePercent: 50 })
    const storedSmoke = (await db.pool.query('select record from ci_runs where id=$1', [smoke.ticketId])).rows[0]!.record
    expect(storedSmoke).not.toHaveProperty('smokeComputer')
    expect({ ...storedSmoke, smokeComputer: smokeInput.smokeComputer }).toEqual(smokeRead.run)
  } finally {
    preferredStatusReleased.resolve()
    vi.useRealTimers()
    await Promise.allSettled(clients.map(client => client.close()))
    await ci?.close()
    await app?.close()
    await db.close()
  }
})
