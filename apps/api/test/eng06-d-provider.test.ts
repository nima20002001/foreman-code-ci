import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HarnessExecutionRequestSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, parseRepeatExitResultV1 } from '@foreman-code/contracts/wave25'
import { assertOriginalWorkflowTerminal } from '../src/modules/interactions/workflowTerminalSource.js'
import { normalizeRepeatTerminal } from '../src/modules/runs/repeatNode.js'
import { bindRepeatNodeInput, freezeRepeatEntry, makeRepeatOccurrence } from '../src/modules/runs/repeatResolution.js'
import { RecoveryProvider, type Fault } from './helpers/eng06DProvider.js'

/** These validate the synthetic provider separately from SQL/engine recovery.
 * Pure input/occurrence constructors are NOT durable admission or proof writers. */
async function setup(form: 'sequential' | 'repeat', fault: Fault, nodeIndex = 0) {
  const f = makeCurrentWorkflowFixture(randomUUID(), form), node = f.version.definition.nodes[nodeIndex]!
  const provider = new RecoveryProvider(f.version, () => fault), manager = provider.connection()
  const scope = f.scope, block = f.version.definition.repeat?.blocks[0]
  const entry = block ? makeRepeatOccurrence(scope, block, freezeRepeatEntry(f.run.input, []), null) : null
  const ref = { nodeId: node.id, occurrence: entry?.occurrence.identity ?? null }
  const queued = HarnessExecutionSchema.parse({ id: `unit-${randomUUID()}`, runId: scope.runId, workflowNodeId: node.id,
    agentId: node.agentId, agentConfigurationVersionId: f.version.agentConfigurationVersionIds[node.agentId],
    attempt: 1, input: {}, state: 'queued', createdAt: f.createdAt })
  const bound = bindRepeatNodeInput({ version: f.version, runInput: f.run.input, recipient: queued, ref,
    occurrence: entry?.occurrence ?? null, entry: entry?.input ?? null, predecessors: [] })
  const request = HarnessExecutionRequestSchema.parse({ executionId: queued.id, runId: scope.runId, workspaceId: scope.workspaceId,
    workflowNodeId: node.id, workingDirectory: '/synthetic/eng06-provider-unit', runtimeDirectory: `/synthetic/${queued.id}`,
    input: bound.input, configuration: f.configurations[nodeIndex] })
  const session = await manager.createSession({ request })
  const correlationId = `execution:${queued.id}`
  const events = manager.startTurn(session, { prompt: 'Synthetic fixture protocol only', clientCorrelationId: correlationId })
  return { f, provider, manager, queued, request, ref, session, correlationId, events }
}

describe('ENG06-D synthetic provider contract (no PostgreSQL or native binary)', () => {
  describe.each(['sequential', 'repeat'] as const)('%s original terminal provenance', (form) => {
    it.each(['success', 'retryable_failure', 'permanent_failure'] as const)('%s retains exact frames and the declared retryability', async (fault) => {
      const f = await setup(form, fault)
      try {
        // A session reservation is not a submitted/acknowledged native turn.
        const beforeStart = await f.manager.history(f.session)
        expect(beforeStart.correlationId).toBeUndefined()
        expect(beforeStart.nativeTurnId).toBeUndefined()
        expect(beforeStart.terminalTurn).toBeUndefined()
        const events = []
        for await (const event of f.events) events.push(event)
        expect(events.map((event) => event.type)).toEqual(['turn.started', 'turn.completed'])
        const history = await f.manager.reconcile(f.session, f.correlationId)
        expect(() => assertOriginalWorkflowTerminal(f.queued, f.session, history)).not.toThrow()
        const result = history.terminalTurn!.result
        expect(result).toEqual(f.provider.originalResult(f.queued.id))
        if (fault !== 'success') expect(result).toMatchObject({ outcome: 'failed',
          error: { code: 'ENG06_NATIVE_FAILURE', retryable: fault === 'retryable_failure' } })
        const completed = HarnessExecutionSchema.parse({ ...f.queued, input: f.request.input,
          nativeSessionId: f.session.nativeSessionId, state: 'completed', result, finishedAt: new Date().toISOString() })
        expect(normalizeRepeatTerminal(f.f.version, f.f.scope, f.ref, completed)).toEqual(completed)
        // Convenient terminal fields without their exact original source do not qualify.
        expect(() => assertOriginalWorkflowTerminal(f.queued, f.session, { ...history, events: [] })).toThrow()
        await f.manager.cancel(f.session)
        expect(f.provider.originalResult(f.queued.id)).toEqual(result)
        expect(f.provider.counts.starts).toBe(1)
      } finally { await f.manager.close(f.session) }
    })
  })

  it('emits a valid saved repeat-exit envelope rather than relying on a manufactured success', async () => {
    const f = await setup('repeat', 'success', 1)
    try {
      for await (const event of f.events) expect(event.payload).toBeDefined()
      const history = await f.manager.reconcile(f.session, f.correlationId), result = history.terminalTurn!.result
      expect(parseRepeatExitResultV1(result, f.f.version.definition.nodes[1]!.choice!)).toMatchObject({ routing: { outcome: 'issues' } })
      const completed = HarnessExecutionSchema.parse({ ...f.queued, input: f.request.input,
        nativeSessionId: f.session.nativeSessionId, state: 'completed', result, finishedAt: new Date().toISOString() })
      expect(normalizeRepeatTerminal(f.f.version, f.f.scope, f.ref, completed)).toEqual(completed)
    } finally { await f.manager.close(f.session) }
  })

  it('does not report a physical receipt for an unknown execution or invent a terminal when closing a known process', async () => {
    const f = await setup('sequential', 'park'), signal = new AbortController().signal
    try {
      expect(await f.provider.recoverProcesses('unknown-execution', signal)).toBe(false)
      f.provider.recoveryProofAvailable = false
      expect(await f.provider.recoverProcesses(f.queued.id, signal)).toBe(false)
      f.provider.recoveryProofAvailable = true
      expect(await f.provider.recoverProcesses(f.queued.id, signal)).toBe(true)
      expect(f.provider.originalResult(f.queued.id)).toBeUndefined()
      expect(f.provider.counts.starts).toBe(0)
      expect(f.provider.counts.attaches).toBe(0)
      const aborted = AbortSignal.abort(new Error('closed owner'))
      await expect(f.provider.recoverProcesses(f.queued.id, aborted)).rejects.toThrow('closed owner')
    } finally { await f.manager.close(f.session) }
  })

  it.each(['park', 'durable_reply_gap', 'durable_failure_gap'] as const)('%s exposes a real fault barrier before an API restart is injected', async (fault) => {
    const f = await setup('sequential', fault), iterator = f.events[Symbol.asyncIterator]()
    let pending: ReturnType<typeof iterator.next> | undefined
    try {
      expect((await iterator.next()).value.type).toBe('turn.started')
      expect(f.provider.atBarrier(f.queued.id)).toBe(false)
      pending = iterator.next()
      await expect.poll(() => f.provider.atBarrier(f.queued.id)).toBe(true)
      const live = await f.manager.reconcile(f.session, f.correlationId)
      expect(live.terminalTurn).toBeUndefined()
      expect(f.provider.originalResult(f.queued.id)?.outcome).toBe(fault === 'park' ? undefined
        : fault === 'durable_failure_gap' ? 'failed' : 'succeeded')
      await f.manager.closeForRestart!(f.session)
      expect((await pending).done).toBe(true)
      if (fault === 'park') await expect(f.manager.history(f.session)).rejects.toThrow(/no durable result/)
      else {
        const durable = await f.manager.reconcile(f.session, f.correlationId)
        expect(durable.terminalTurn!.result).toEqual(f.provider.originalResult(f.queued.id))
        expect(() => assertOriginalWorkflowTerminal(f.queued, f.session, durable)).not.toThrow()
      }
      expect(f.provider.counts.starts).toBe(1); expect(f.provider.counts.attaches).toBe(0)
    } finally {
      await f.manager.close(f.session)
      await pending
      await iterator.return?.()
    }
  })
})
