import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { matchingDeliveryEvidence } from '../src/modules/interactions/delivery.js'
import { input } from './fixtures/codex-test-helpers.js'
import { deliveryFixture } from './helpers/wave25ApprovalFixture.js'
import { CodexApprovalProvider } from './helpers/codexApprovalProvider.js'

function fixture(executionId: string, completion: 'notifications' | 'history' = 'notifications') {
  const provider = new CodexApprovalProvider(executionId, false)
  const dependencies = provider.dependencies()
  const transport = dependencies.transport
  dependencies.transport = (...args) => {
    const [binary, cwd, environment, protocol, onRequest, onNotification, ...rest] = args
    return transport(binary, cwd, environment, protocol, onRequest, (method, params) => {
      // Simulate a missed terminal notification while retaining the provider's completed turn.
      if (completion === 'history' && method === 'turn/completed') return
      onNotification(method, params)
    }, ...rest)
  }
  const manager = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined,
    undefined, 'scoped', undefined, dependencies)
  const source = input(process.cwd())
  source.request.executionId = executionId
  return { provider, manager, source }
}

describe('Codex approval provider replay', () => {
  it.each(['notifications', 'history'] as const)(
    'delivers one native callback and settles the original turn through %s', async completion => {
      const f = fixture('approval-worker', completion)
      const abort = new AbortController()
      let settled: Promise<unknown> | undefined
      try {
        const session = await f.manager.createSession(f.source)
        const correlationId = `execution:${f.source.request.executionId}`
        let streamedCompletion = false
        const stream = (async () => {
          for await (const event of f.manager.startTurn(session, {
            clientCorrelationId: correlationId, prompt: 'Request approval',
          }, abort.signal)) {
            if (event.type === 'turn.completed') streamedCompletion = true
          }
        })()
        settled = Promise.allSettled([stream])
        await vi.waitFor(async () => expect(await f.manager.pending(session)).toBeDefined())
        const pending = (await f.manager.pending(session))!
        const option = pending.responseOptions.find(value => value.semantic === 'approve_once')!
        await f.manager.respond(session, pending.turn.nativeRequestId!, option)
        await f.provider.flush()
        expect(f.provider.responses).toHaveLength(1)
        expect(await f.manager.pending(session)).toBeUndefined()
        const before = await f.manager.history(session)
        expect(before.events.some(event => event.type === 'turn.completed')).toBe(completion === 'notifications')
        if (completion === 'notifications') {
          await expect(stream).resolves.toBeUndefined()
          expect(streamedCompletion).toBe(true)
          expect(before.terminalResult).toMatchObject({ outcome: 'succeeded', output: { text: 'finished' } })
        } else {
          expect(streamedCompletion).toBe(false)
          expect(before.terminalResult).toBeUndefined()
        }
        const interaction = { ...deliveryFixture().interaction, harness: session.harness,
          providerVersion: session.providerVersion, nativeSessionId: session.nativeSessionId,
          nativeRequestId: pending.turn.nativeRequestId!, nativeRequestType: pending.nativeRequestType,
          request: pending.request, responseOptions: pending.responseOptions,
          selectedOptionId: option.optionId, selectedSemantic: option.semantic }
        expect(matchingDeliveryEvidence(interaction, session, before)).toMatchObject({
          nativeRequestId: pending.turn.nativeRequestId, optionId: option.optionId,
        })
        const history = await f.manager.reconcile(session, correlationId)
        expect(history.terminalTurn).toMatchObject({ correlationId, providerId: pending.turn.nativeTurnId,
          result: { outcome: 'succeeded', output: { text: 'finished' } } })
        await expect(stream).resolves.toBeUndefined()
        await expect(f.manager.respond(session, pending.turn.nativeRequestId!, option))
          .rejects.toThrow('not pending')
        expect(f.provider.responses).toHaveLength(1)
      } finally {
        abort.abort()
        await settled
        await f.manager.shutdown()
        await f.provider.flush()
      }
    })

  it('uses separate provider sessions for separate workflow executions', async () => {
    const first = fixture('first-worker')
    const second = fixture('second-worker')
    try {
      const sessions = await Promise.all([
        first.manager.createSession(first.source), second.manager.createSession(second.source),
      ])
      expect(sessions[0]!.nativeSessionId).not.toBe(sessions[1]!.nativeSessionId)
      expect(first.provider.threads.size).toBe(1)
      expect(second.provider.threads.size).toBe(1)
    } finally {
      await first.manager.shutdown()
      await second.manager.shutdown()
    }
  })
})
