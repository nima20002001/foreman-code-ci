import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COORDINATION_RESULT_PROTOCOL, type ExecutionResult } from '@foreman-code/contracts'
import type { NativeHistory } from '../../harnesses/port.js'
import { runningInstalledFixture } from './__tests__/installedWorkflowHost.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { readUntil } from '../../../../test/helpers/observableCondition.js'
import { RemoteOwnerControlSchema } from '@foreman-code/contracts/remote-execution'

describe('Worker coordinated result settlement', () => {
  it('retains one native owner for two corrections until Main commits, then closes and replays the exact result', async () => {
    const f = await runningInstalledFixture('generation', { deferTurn: true, resultProtocol: COORDINATION_RESULT_PROTOCOL })
    let sequence = f.history.nextSequence!
    const results = new Map<string, ExecutionResult>()
    f.turns.mockImplementation(async function* (session, input) {
      const turnId = `turn-${input.clientCorrelationId}`
      await input.onSubmitted?.(turnId)
      const event = { sequence: sequence++, type: 'turn.completed', occurredAt: new Date().toISOString(),
        payload: { threadId: session.nativeSessionId, turnId, clientCorrelationId: input.clientCorrelationId,
          status: 'completed' } }
      const result: ExecutionResult = { outcome: 'succeeded', output: { text: JSON.stringify({
        data: { revision: results.size + 1 }, summary: 'The same work with corrected board context',
        board: { kind: 'none', reason: 'no_changes' },
      }) } }
      results.set(input.clientCorrelationId!, result)
      Object.assign(f.history, { events: [...f.history.events, event], nextSequence: sequence,
        correlationId: input.clientCorrelationId, nativeTurnId: turnId, terminalResult: result,
        terminalTurn: { correlationId: input.clientCorrelationId, providerId: turnId, result } })
      yield event
    })
    try {
      expect(f.create.mock.calls[0]![0]).toMatchObject({ request: { resultProtocol: COORDINATION_RESULT_PROTOCOL } })
      for (const attempt of [0, 1, 2]) {
        const correlationId = `execution:execution${attempt ? `:result-repair:${attempt}` : ''}`
        const input = { prompt: `Bounded correction ${attempt}`, correlationId, deferSettlement: true }
        await f.call('start-turn', input)
        await readUntil(async () => (await f.call('history', { correlationId })).payload,
          value => (value as { history?: NativeHistory }).history?.terminalTurn?.correlationId === correlationId,
          { timeoutMs: 2000, description: 'original Worker result available to Main validation' })
        await f.call('start-turn', input)
        expect(f.closeOwner).not.toHaveBeenCalled()
        expect(await f.journal.status(f.intent.operationId)).toMatchObject({ receipt: { phase: 'running' } })
      }
      expect(f.create).toHaveBeenCalledTimes(1)
      expect(f.turns).toHaveBeenCalledTimes(3)
      await expect(f.call('start-turn', { prompt: 'another correction',
        correlationId: 'execution:execution:result-repair:3', deferSettlement: true })).rejects.toThrow()
      const correlationId = 'execution:execution:result-repair:2'
      await f.call('settle-turn', { correlationId, nativeTurnId: `turn-${correlationId}` })
      await f.settled
      const settled = await f.journal.status(f.intent.operationId)
      expect(settled).toMatchObject({ receipt: { outputValidationComplete: true,
        terminal: { result: results.get(correlationId) } } })
      expect(f.closeOwner).toHaveBeenCalledTimes(1)
      await f.call('settle-turn', { correlationId, nativeTurnId: `turn-${correlationId}` })
      expect(await f.journal.status(f.intent.operationId)).toEqual(settled)
      expect(f.closeOwner).toHaveBeenCalledTimes(1)
      await expect(f.call('start-turn', { prompt: 'late correction',
        correlationId: 'execution:execution:result-repair:3', deferSettlement: true })).rejects.toThrow()
      expect(f.turns).toHaveBeenCalledTimes(3)
      await f.host.close()
      await f.journal.close()
      const reopened = await RemoteOperationJournal.open(join(f.root, 'workflow-journal'))
      try { expect(await reopened.status(f.intent.operationId)).toEqual(settled) }
      finally { await reopened.close() }
    } finally { f.finish('succeeded'); await f.host.close() }
  })

  it('settles a marked designated reviewer into its original retained session without opening another owner', async () => {
    const f = await runningInstalledFixture('generation', { deferTurn: true, retainReviewer: true,
      resultProtocol: COORDINATION_RESULT_PROTOCOL })
    try {
      await f.call('start-turn', { prompt: 'Delegate and summarize', correlationId: 'execution:execution', deferSettlement: true })
      f.finish('succeeded', { text: JSON.stringify({ data: { latestDeliverable: 'Delegation plan', remainingFindings: [] },
        routing: { kind: 'finish' }, summary: 'The initial coordinator work is complete', board: { kind: 'none', reason: 'no_changes' } }) })
      await readUntil(async () => (await f.call('history', { correlationId: 'execution:execution' })).payload,
        value => Boolean((value as { history?: NativeHistory }).history?.terminalTurn),
        { timeoutMs: 2000, description: 'reviewer result before validation' })
      expect(f.closeOwner).not.toHaveBeenCalled()
      await f.call('settle-turn', { correlationId: 'execution:execution', nativeTurnId: 'original-turn' })
      await f.retained
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({ receipt: { outputValidationComplete: true,
        retainedReviewer: { workflowTurnId: 'original-turn', result: { outcome: 'succeeded' } } } })
      expect(f.create).toHaveBeenCalledTimes(1)
      expect(f.closeOwner).not.toHaveBeenCalled()
      await f.call('settle-turn', { correlationId: 'execution:execution', nativeTurnId: 'original-turn' })
      expect(f.turns).toHaveBeenCalledTimes(1)
      const current = await f.journal.status(f.intent.operationId)
      if (current.status !== 'known') throw new Error('Expected the retained original reviewer')
      expect(current.receipt.native).toMatchObject({ sessionId: 'original-session', turnId: 'original-turn' })
      await f.call('control', { command: RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1,
        commandId: 'close-original-reviewer', operationId: f.intent.operationId,
        attemptId: f.intent.attemptId, executionId: f.intent.executionId, bindingHash: f.intent.bindingHash,
        owner: f.intent.owner, native: current.receipt.native, action: { kind: 'stop' } }) })
      await f.settled
      expect(f.closeOwner).toHaveBeenCalledTimes(1)
    } finally { f.finish('succeeded'); await f.host.close() }
  })
})
