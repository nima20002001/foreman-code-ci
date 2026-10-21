import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { makeCurrentWorkflowFixture, SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { RunGraphError } from '../src/modules/run-graph/errors.js'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { readUntil } from './helpers/observableCondition.js'
import { agent3Database } from './helpers/wave25Agent3.js'
import { retryDatabaseTimeout } from '../src/infrastructure/databaseTimeout.js'
import { renewOwnedLeases } from '../src/modules/leases/ownerLeases.js'
import { deferred } from './helpers/deferred.js'

it.each(['canceling statement due to user request', 'Native event persistence was interrupted.'])(
  'does not retry query cancellation or database failure: %s', async message => {
    const error = Object.assign(new Error(message), { code: '57014' })
    const write = vi.fn().mockRejectedValue(error)
    await expect(retryDatabaseTimeout(write)).rejects.toBe(error)
    expect(write).toHaveBeenCalledTimes(1)
    vi.useFakeTimers()
    const check = vi.fn().mockRejectedValue(error)
    const onFailure = vi.fn()
    const stop = renewOwnedLeases({
      leases: [{ name: 'execution credential', renewWithinMs: 60_000, remainingMs: () => 600_000, renew: async () => {} }],
      check, signal: new AbortController().signal, onFailure,
    })
    try {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(check).toHaveBeenCalledTimes(1)
      expect(onFailure).toHaveBeenCalledWith(error, 'check')
    } finally {
      await stop()
      vi.useRealTimers()
    }
  },
)

it('keeps graph work and an interval Agent alive through database timeouts and reads their original results through MCP', async () => {
  const fixture = makeCurrentWorkflowFixture(randomUUID())
  const watcher = fixture.version.definition.nodes[0]!
  watcher.interval = { everySeconds: 10 }
  fixture.version.approval = { handler: 'native' }
  fixture.version.definition.approval = { handler: 'native' }
  fixture.run.approval = { handler: 'native' }
  for (const configuration of fixture.configurations) {
    if (configuration.harness.harness !== 'codex') throw new Error('Expected a Codex configuration')
    configuration.harness = { ...configuration.harness, advanced: {
      ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never',
    } }
  }
  const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [] })
  const flush = deferred()
  const finish = deferred()
  const held = new Set<string>()
  const timedOut = new Set<string>()
  const persisted = new Set<string>()
  const committedBeforeTimeout = new Set<string>()
  const scopes = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
  let databaseReady = false
  let running: Promise<void> | undefined
  const append = f.runs.appendNativeEvents.bind(f.runs)
  vi.spyOn(f.runs, 'appendNativeEvents').mockImplementation(async (...args) => {
    const frames = args[0]
    const delayed = frames.find(({ event }) => event.type === 'native.notification'
      && event.payload.databaseTimeoutTest === true)
    if (!delayed) return append(...args)
    const executionId = delayed.event.executionId!
    if (!databaseReady) {
      // Also exercise a lost response after an idempotent native publication committed.
      if (!committedBeforeTimeout.has(executionId)) {
        await append(...args)
        committedBeforeTimeout.add(executionId)
      }
      timedOut.add(executionId)
      const error = timedOut.size === 1 ? new Error('Query read timeout')
        : Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
      throw new RunGraphError('GRAPH_TRANSACTION_FAILED', { cause: error })
    }
    await append(...args)
    persisted.add(executionId)
  })
  const startTurn = f.provider.startTurn.bind(f.provider)
  vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
    for await (const event of startTurn(session, input)) {
      yield event
      if (event.type !== 'turn.started' || f.provider.counts.starts === 1) continue
      held.add(session.nativeSessionId)
      await flush.promise
      yield { sequence: 10, type: 'native.notification', occurredAt: new Date().toISOString(),
        payload: { databaseTimeoutTest: true } }
      await finish.promise
    }
  })
  try {
    running = f.engine.start(f.f.run.id)
    // Observe failures without an unhandled rejection while the timing gates remain closed.
    void running.catch(() => { /* ignore: the finally block settles and asserts the Run; this only avoids an unhandled rejection */ })
    await readUntil(async () => held.size, count => count === 2,
      { timeoutMs: 30_000, description: 'running graph Agent and interval Agent' })
    const before = await f.runs.getDetails(f.f.run.workspaceId, f.f.run.id)
    const active = before!.executions.filter(execution => execution.state === 'running')
    expect(active).toHaveLength(2)
    expect(active.filter(execution => 'tick' in (execution.input as Record<string, unknown>))).toHaveLength(1)
    flush.resolve()
    await readUntil(async () => timedOut.size, count => count === 2,
      { timeoutMs: 10_000, description: 'bookkeeping timeout in both original sessions' })
    for (const execution of active) expect(f.provider.closedSessions.has(execution.nativeSessionId!)).toBe(false)
    expect(f.provider.counts.starts).toBe(3)
    const during = await f.runs.getRepeatSnapshot(f.f.run.id)
    expect(during.cleanupPending).toBe(false)
    expect(during.run).toMatchObject({ executionState: 'running', outcome: 'pending' })
    const duringRead = await f.client.callTool({ name: 'run_get', arguments: { ...scopes, detail: 'full' } })
    expect(duringRead.isError).not.toBe(true)
    const duringDetails = SavedRunDetailsSchema.parse(decodeMcpToolResult(duringRead))
    for (const execution of active) {
      expect(duringDetails.executions.find(item => item.id === execution.id)).toMatchObject({
        state: 'running', nativeSessionId: execution.nativeSessionId, attempt: 1,
      })
    }
    const outside = await f.access.issue({ name: 'Timeout test outside scope', audience: 'operator',
      expiresAt: new Date(Date.now() + 60_000),
      grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['outside-workspace'] } }] })
    const deniedClient = await f.connect(outside.token)
    const denied = await deniedClient.callTool({ name: 'run_get', arguments: scopes })
    expect(denied.isError).toBe(true)
    expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    databaseReady = true
    await readUntil(async () => persisted.size, count => count === 2,
      { timeoutMs: 10_000, description: 'original native publications retried successfully' })
    finish.resolve()
    await readUntil(() => f.runs.getDetails(f.f.run.workspaceId, f.f.run.id),
      details => details?.executions.every(execution => execution.state === 'completed') === true,
      { timeoutMs: 10_000, description: 'settled original native executions' })
    const stopped = await f.client.callTool({ name: 'run_stop', arguments: { ...scopes, commandId: randomUUID() } })
    expect(stopped.isError).not.toBe(true)
    await Promise.allSettled([running])
    const readback = await f.client.callTool({ name: 'run_get', arguments: { ...scopes, detail: 'full' } })
    expect(readback.isError).not.toBe(true)
    expect(decodeMcpToolResult(readback)).toMatchObject({ run: { executionState: 'completed', outcome: 'canceled' } })
    const after = await f.runs.getDetails(f.f.run.workspaceId, f.f.run.id)
    expect(after!.executions.map(execution => execution.id).sort())
      .toEqual(before!.executions.map(execution => execution.id).sort())
    for (const execution of active) {
      expect(after!.executions.find(item => item.id === execution.id)).toMatchObject({
        state: 'completed', nativeSessionId: execution.nativeSessionId, attempt: 1, result: { outcome: 'succeeded' },
      })
    }
    expect(f.provider.counts.starts).toBe(3)
    expect((await f.runs.getRepeatSnapshot(f.f.run.id)).cleanupPending).toBe(false)
  } finally {
    databaseReady = true
    flush.resolve()
    finish.resolve()
    await f.close()
    if (running) await Promise.allSettled([running])
    vi.restoreAllMocks()
  }
}, 60_000)

it('rolls back a real PostgreSQL statement deadline and keeps the same connection usable', async () => {
  const db = await agent3Database()
  const client = await db.pool.connect()
  const connection = new ExclusiveGraphConnection(client, () => {})
  try {
    await connection.query('create temporary table timeout_bookkeeping (completed integer not null)')
    await connection.query('insert into timeout_bookkeeping values (0)')
    const mutation = vi.fn(async () => connection.transaction(async sql => {
      await sql.query('set local statement_timeout = 15')
      await sql.query('update timeout_bookkeeping set completed=completed+1')
      await sql.query('select pg_sleep(0.1)')
    }))
    await expect(mutation()).rejects.toMatchObject({ code: '57014' })
    expect(mutation).toHaveBeenCalledTimes(1)
    expect((await connection.query<{ completed: number }>('select completed from timeout_bookkeeping')).rows)
      .toEqual([{ completed: 0 }])
    const persisted = await connection.transaction(sql => sql.query<{ completed: number }>(
      'update timeout_bookkeeping set completed=completed+1 returning completed'))
    expect(persisted.rows).toEqual([{ completed: 1 }])
    expect(mutation).toHaveBeenCalledTimes(1)
  } finally {
    await connection.close()
    client.release()
    await db.close()
  }
})

it('closes the original session when authenticated MCP Stop interrupts active database retries', async () => {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [] })
  const flush = deferred()
  const finish = deferred()
  let published = false
  let timedOut = false
  let running: Promise<unknown> | undefined
  const append = f.runs.appendNativeEvents.bind(f.runs)
  vi.spyOn(f.runs, 'appendNativeEvents').mockImplementation(async (...args) => {
    if (args[0].some(({ event }) => event.payload.databaseTimeoutTest === true)) {
      timedOut = true
      throw new Error('Query read timeout')
    }
    await append(...args)
    published = true
  })
  const startTurn = f.provider.startTurn.bind(f.provider)
  vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
    for await (const event of startTurn(session, input)) {
      yield event
      if (event.type !== 'turn.started') continue
      await flush.promise
      yield { sequence: 10, type: 'native.notification', occurredAt: new Date().toISOString(),
        payload: { databaseTimeoutTest: true } }
      await finish.promise
    }
  })
  try {
    running = f.engine.start(f.f.run.id).catch((error: unknown) => error)
    await readUntil(async () => published, Boolean,
      { timeoutMs: 10_000, description: 'first native events persisted' })
    const before = await f.runs.getDetails(f.f.run.workspaceId, f.f.run.id)
    const execution = before!.executions[0]!
    flush.resolve()
    await readUntil(async () => timedOut, Boolean,
      { timeoutMs: 10_000, description: 'active database retry' })
    const scope = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
    const reader = await f.access.issue({ name: 'Read-only Stop caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 60_000),
      grants: [{ actions: ['runs:read'], scope: { workspaceIds: [scope.workspaceId] } }] })
    const readerClient = await f.connect(reader.token)
    const denied = await readerClient.callTool({ name: 'run_stop', arguments: { ...scope, commandId: randomUUID() } })
    expect(denied.isError).toBe(true)
    expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    const stopping = f.client.callTool({ name: 'run_stop', arguments: { ...scope, commandId: randomUUID() } })
    finish.resolve()
    expect((await stopping).isError).not.toBe(true)
    await running
    const readback = await f.client.callTool({ name: 'run_get', arguments: { ...scope, detail: 'full' } })
    expect(readback.isError).not.toBe(true)
    expect(decodeMcpToolResult(readback)).toMatchObject({ run: { executionState: 'completed', outcome: 'canceled' },
      executions: [{ id: execution.id, nativeSessionId: execution.nativeSessionId, state: 'completed' }] })
    expect(f.provider.closedSessions.has(execution.nativeSessionId!)).toBe(true)
    expect(f.provider.counts.starts).toBe(1)
    expect((await f.runs.getRepeatSnapshot(f.f.run.id)).cleanupPending).toBe(false)
  } finally {
    flush.resolve()
    finish.resolve()
    await readUntil(() => f.runs.getDetails(f.f.run.workspaceId, f.f.run.id),
      details => details?.executions.every(execution => execution.state === 'completed') === true,
      { timeoutMs: 10_000, description: 'settled original native executions' })
    const stopped = await f.client.callTool({ name: 'run_stop', arguments: { workspaceId: f.f.run.workspaceId, runId: f.f.run.id, commandId: randomUUID() } })
    expect(stopped.isError).not.toBe(true)
    await Promise.allSettled([running])
    await f.close()
    vi.restoreAllMocks()
  }
}, 60_000)
