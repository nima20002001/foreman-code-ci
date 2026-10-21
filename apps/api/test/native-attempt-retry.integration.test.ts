import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { makeCurrentWorkflowFixture, SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { readUntil } from './helpers/observableCondition.js'

afterEach(() => vi.restoreAllMocks())

it.each(['publication', 'interruption', 'provider'] as const)(
  'retries a %s failure in a fresh native session while its sibling keeps running', async fault => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
    fixture.version.definition.executionPolicy = { maxParallelism: 2, maxNodeExecutions: 8 }
    const affected = fixture.version.definition.nodes[1]!
    const sibling = fixture.version.definition.nodes[2]!
    let injected = false
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [],
      nativeSourcePersisted: async (_sql, _evidence, source) => {
        if (fault !== 'publication' || injected || source.execution.workflowNodeId !== affected.id
          || source.original.type !== 'history') return
        injected = true
        throw Object.assign(new Error('Native publication connection reset'), { code: 'ECONNRESET' })
      } })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const start = f.provider.startTurn.bind(f.provider)
    vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
      if (!input.clientCorrelationId) throw new Error('Expected the accepted execution correlation')
      const execution = await f.runs.getExecution(input.clientCorrelationId.slice('execution:'.length))
      for await (const event of start(session, input)) {
        if (event.type === 'turn.started' && execution?.workflowNodeId === sibling.id) {
          yield event
          await held
          continue
        }
        yield event
        if (event.type === 'turn.started' && execution?.workflowNodeId === affected.id
          && fault !== 'publication' && !injected) {
          injected = true
          const code = fault === 'interruption' ? 'EXECUTION_INTERRUPTED' : 'PROVIDER_TEMPORARILY_UNAVAILABLE'
          throw new HarnessExecutionError(code, 'The native attempt was interrupted.', true)
        }
      }
    })
    const task = f.engine.start(f.f.run.id)
    // Keep the drive's rejection observed while checking its persisted state.
    void task.catch(() => { /* ignore: the awaited drive below reports its failure. */ })
    const args = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id, detail: 'full' }
    const read = async () => SavedRunDetailsSchema.parse(decodeMcpToolResult(
      await f.client.callTool({ name: 'run_get', arguments: args })))
    try {
      const active = await readUntil(read, details => details.executions.some(execution =>
        execution.workflowNodeId === sibling.id && execution.state === 'running' && execution.nativeSessionId),
      { timeoutMs: 15_000, description: 'the running sibling' })
      const originalSibling = active.executions.find(execution => execution.workflowNodeId === sibling.id)!
      const retried = await readUntil(read, details => {
        expect(details.run.executionState).toBe('running')
        expect(details.cleanupPending).toBe(false)
        return details.executions.some(execution => execution.workflowNodeId === affected.id && execution.attempt === 2)
      }, { timeoutMs: 15_000, description: 'the fresh native retry' })
      expect(injected).toBe(true)
      expect(retried.executions.find(execution => execution.id === originalSibling.id)).toMatchObject({
        state: 'running', nativeSessionId: originalSibling.nativeSessionId, attempt: 1,
      })
      const outside = await f.access.issue({ name: 'Unrelated Run reader', audience: 'operator',
        grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['unrelated-workspace'] } }] })
      const denied = await f.connect(outside.token)
      await expectMcpAccessDenied(denied.callTool({ name: 'run_get', arguments: args }))
      release()
      await task
      const finished = await read()
      expect(finished.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      const attempts = finished.executions.filter(execution => execution.workflowNodeId === affected.id)
        .sort((a, b) => a.attempt - b.attempt)
      expect(attempts).toHaveLength(2)
      expect(attempts[0]).toMatchObject({ state: 'completed', result: {
        outcome: 'failed', error: { retryable: true },
      } })
      expect(attempts[1]).toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
      expect(attempts[1]!.nativeSessionId).not.toBe(attempts[0]!.nativeSessionId)
      expect(attempts[1]!.input).toEqual(attempts[0]!.input)
      expect(f.provider.startedExecutions.filter(id => id === attempts[0]!.id)).toHaveLength(1)
      expect(f.provider.startedExecutions.filter(id => id === originalSibling.id)).toHaveLength(1)
      expect(finished.executions.find(execution => execution.id === originalSibling.id)?.result?.outcome)
        .toBe('succeeded')
    } finally {
      release()
      await task.catch(() => { /* ignore: assertions above retain the drive failure. */ })
      await f.close()
    }
  }, 60_000)
