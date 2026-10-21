import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import { decodeMcpToolResult, OperatorRunCompactSchema } from '@foreman-code/contracts/operator-mcp'
import { RunExecutionsPageSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { DomainError } from '../src/modules/errors.js'
import { EXECUTION_INFRASTRUCTURE_RETRY_WINDOW_MS } from '../src/modules/runs/executionRetryPolicy.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it.each([false, true])('retains each lost native connection when the next attempt exceeds the infrastructure retry window (settlement initially unavailable: %s)', async retry => {
  vi.stubEnv('FOREMAN_EXECUTION_RETRY_BACKOFF_MS', `0,0,${EXECUTION_INFRASTRUCTURE_RETRY_WINDOW_MS}`)
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [] })
  const secret = `opm_${'x'.repeat(43)}`
  const failure = { code: 'CODEX_APP_SERVER_DISCONNECTED',
    message: 'The original observer disconnected: [REDACTED]', retryable: true }
  let retried = false
  if (retry) {
    const repeat = f.runs.repeat.bind(f.runs)
    vi.spyOn(f.runs, 'repeat').mockImplementation(async (...args) => {
      const store = await repeat(...args)
      const settle = store.settleNegativeExecution.bind(store)
      store.settleNegativeExecution = async (...args) => {
        if (!retried) {
          retried = true
          throw new DomainError('REPEAT_CLEANUP_PENDING', 'Native settlement is temporarily unavailable.', 409)
        }
        return settle(...args)
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
      if (!first.done) yield first.value
      throw new HarnessExecutionError(failure.code, `The original observer disconnected: ${secret}`, true)
    } finally {
      await events.return?.()
    }
  })
  try {
    await f.engine.start(f.f.run.id)
    expect((await f.runs.getRepeatSnapshot(f.f.run.id)).cleanupPending).toBe(false)
    await f.compose().engine.start(f.f.run.id)
    const scope = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
    const saved = await f.runs.get(f.f.run.id)
    expect(saved).toMatchObject({ executionState: 'completed', outcome: 'failed',
      result: { outcome: 'failed', error: failure } })
    const compact = OperatorRunCompactSchema.parse(decodeMcpToolResult(
      await f.client.callTool({ name: 'run_get', arguments: scope })))
    expect(compact.run).toMatchObject({ outcome: 'failed', failure })
    expect(compact.executions).toHaveLength(3)
    for (const execution of compact.executions) expect(execution.failure).toEqual(failure)
    const full = decodeMcpToolResult(await f.client.callTool({ name: 'run_get',
      arguments: { ...scope, detail: 'full' } }))
    expect(full).toMatchObject({ run: { outcome: 'failed', result: saved!.result },
      executions: Array.from({ length: 3 }, () => ({ state: 'completed', result: { outcome: 'failed', error: failure } })) })
    expect(JSON.stringify(full)).not.toContain(secret)
    const page = RunExecutionsPageSchema.parse(decodeMcpToolResult(await f.client.callTool({
      name: 'run_executions_list', arguments: scope })))
    expect(page.run).toMatchObject({ outcome: 'failed', failure, cleanupPending: false })
    expect(page.items).toHaveLength(3)
    expect(page.items.map(item => item.attempt).sort()).toEqual([1, 2, 3])
    for (const item of page.items) expect(item).toMatchObject({ failure, acceptedResultAvailable: false })
    const outside = await f.access.issue({ name: 'Reader outside Run scope', audience: 'operator',
      expiresAt: new Date(Date.now() + 60_000),
      grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['another-workspace'] } }] })
    const denied = await f.connect(outside.token)
    await expectMcpAccessDenied(denied.callTool({ name: 'run_get', arguments: scope }))
    expect(f.provider.startedNodes).toEqual(Array(3).fill(f.f.version.entryNodeId))
    expect(f.provider.counts.starts).toBe(3)
    expect(retried).toBe(retry)
    await f.engine.reconcile()
    expect(await f.runs.get(f.f.run.id)).toEqual(saved)
    expect(f.provider.counts.starts).toBe(3)
  } finally {
    await f.close()
  }
}, 60_000)

it('keeps a live native turn after observer recovery is unavailable and reconciles it without replay', async () => {
  const f = await currentOperatorIntegration({ approvalNodeIds: [] })
  const startTurn = f.provider.startTurn.bind(f.provider)
  const native: { turn?: AsyncIterator<NativeHarnessEvent> } = {}
  vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
    if (native.turn) {
      yield* startTurn(session, input)
      return
    }
    native.turn = startTurn(session, input)[Symbol.asyncIterator]()
    const first = await native.turn.next()
    expect(first.done).toBe(false)
    if (!first.done) yield first.value
    throw new HarnessExecutionError('CODEX_OBSERVER_UNAVAILABLE', 'The original native observer is unavailable.', true)
  })
  try {
    await expect(f.engine.start(f.f.run.id)).rejects.toMatchObject({ code: 'CODEX_OBSERVER_UNAVAILABLE' })
    expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'running', outcome: 'pending' })
    expect((await f.runs.getRepeatSnapshot(f.f.run.id)).cleanupPending).toBe(false)
    expect(f.provider.counts.starts).toBe(1)
    expect(f.provider.closedSessions.size).toBe(0)
    if (!native.turn) throw new Error('Expected the original native turn.')
    const completion = await native.turn.next()
    expect(completion).toMatchObject({ done: false, value: { type: 'turn.completed' } })
    await f.engine.start(f.f.run.id)
    const scope = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
    const full = decodeMcpToolResult(await f.client.callTool({ name: 'run_get',
      arguments: { ...scope, detail: 'full' } }))
    expect(full).toMatchObject({ run: { outcome: 'succeeded' }, cleanupPending: false })
    expect(f.provider.startedNodes).toEqual(f.f.version.definition.nodes.map(node => node.id))
    expect(new Set(f.provider.startedExecutions).size).toBe(2)
    expect(f.provider.counts.starts).toBe(2)
  } finally {
    await native.turn?.return?.()
    await f.close()
  }
}, 60_000)
