import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { decodeMcpToolResult, OperatorRunCompactSchema } from '@foreman-code/contracts/operator-mcp'
import { RunExecutionsPageSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { DomainError } from '../src/modules/errors.js'

it.each(['normal cleanup', 'retried bookkeeping', 'retried cleanup', 'Stop during cleanup'] as const)(
  'persists an active-time timeout through %s and discloses it through authorized MCP reads', async mode => {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  fixture.version.definition.executionPolicy!.agentActiveTimeoutMs = 600_000
  const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [] })
  let failureInjected = false
  if (mode !== 'normal cleanup') {
    const repeat = f.runs.repeat.bind(f.runs)
    vi.spyOn(f.runs, 'repeat').mockImplementation(async (...args) => {
      const store = await repeat(...args)
      const settle = store.settleNegativeExecution.bind(store)
      store.settleNegativeExecution = async (...settlement) => {
        if (!failureInjected) {
          failureInjected = true
          if (mode === 'Stop during cleanup') await f.stop()
          if (mode === 'retried bookkeeping') {
            throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
          }
          throw new DomainError('REPEAT_CLEANUP_PENDING', 'Native settlement is temporarily unavailable.', 409)
        }
        return settle(...settlement)
      }
      return store
    })
  }
  const startTurn = f.provider.startTurn.bind(f.provider)
  vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
    const events = startTurn(session, input)[Symbol.asyncIterator]()
    try {
      const first = await events.next()
      expect(first.done).toBe(false)
      expect(f.provider.startedExecutions).toHaveLength(1)
      const executionId = f.provider.startedExecutions[0]!
      // Expire only after native Start so database load cannot consume the budget before this boundary.
      const expired = await f.db.pool.query(
        'update approval_execution_state set active_elapsed_ms=active_timeout_ms where execution_id=$1',
        [executionId],
      )
      expect(expired.rowCount).toBe(1)
      if (!first.done) yield first.value
    } finally {
      await events.return?.()
    }
  })
  try {
    if (mode === 'normal cleanup' || mode === 'retried bookkeeping') {
      await f.engine.start(f.f.run.id)
    } else {
      await expect(f.engine.start(f.f.run.id)).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
      const snapshot = await f.runs.getRepeatSnapshot(f.f.run.id)
      if (mode === 'Stop during cleanup') {
        expect(snapshot.run).toMatchObject({ executionState: 'completed', outcome: 'canceled' })
      } else {
        expect(snapshot.cleanupPending).toBe(true)
      }
      const recovery = f.compose()
      await recovery.engine.start(f.f.run.id)
    }
    const scope = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
    const outside = await f.access.issue({ name: 'Reader outside Run scope', audience: 'operator',
      expiresAt: new Date(Date.now() + 60_000),
      grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['another-workspace'] } }] })
    const deniedClient = await f.connect(outside.token)
    for (const name of ['run_get', 'run_executions_list']) {
      const denied = await deniedClient.callTool({ name, arguments: scope })
      expect(denied.isError).toBe(true)
      expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    }
    const failure = { code: 'EXECUTION_ACTIVE_TIMEOUT',
      message: 'The execution exhausted its active-time budget.', retryable: false }
    const stopped = mode === 'Stop during cleanup'
    const result = stopped ? { outcome: 'canceled' } : { outcome: 'failed', error: failure }
    const compactRead = await f.client.callTool({ name: 'run_get', arguments: scope })
    expect(compactRead.isError).not.toBe(true)
    const compact = OperatorRunCompactSchema.parse(decodeMcpToolResult(compactRead))
    expect(compact.run.failure).toEqual(stopped ? undefined : failure)
    expect(compact.executions).toHaveLength(1)
    expect(compact.executions[0]!.failure).toEqual(stopped ? undefined : failure)
    expect(compact.run).not.toHaveProperty('result')
    const read = await f.client.callTool({ name: 'run_get', arguments: { ...scope, detail: 'full' } })
    expect(read.isError).not.toBe(true)
    expect(decodeMcpToolResult(read)).toMatchObject({
      run: { executionState: 'completed', outcome: result.outcome, result },
      executions: [{ state: 'completed', result }],
    })
    const listed = await f.client.callTool({ name: 'run_executions_list', arguments: scope })
    expect(listed.isError).not.toBe(true)
    const page = RunExecutionsPageSchema.parse(decodeMcpToolResult(listed))
    expect(page.run.failure).toEqual(stopped ? undefined : failure)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ state: 'completed', acceptedResultAvailable: false })
    expect(page.items[0]!.failure).toEqual(stopped ? undefined : failure)
    const detail = await f.client.callTool({ name: 'run_execution_get',
      arguments: { ...scope, executionId: page.items[0]!.executionId } })
    expect(detail.isError).not.toBe(true)
    expect(decodeMcpToolResult(detail)).toMatchObject({
      reportedResult: result,
    })
    expect(await f.runs.get(f.f.run.id)).toMatchObject({ result })
    expect(failureInjected).toBe(mode !== 'normal cleanup')
    expect(f.provider.counts.starts).toBe(1)
    expect(f.provider.closedSessions.size).toBe(1)
    expect((await f.runs.getRepeatSnapshot(f.f.run.id)).cleanupPending).toBe(false)
  } finally {
    await f.close()
  }
}, 60_000)
