import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NativeResponseJournal } from '../src/modules/harnesses/recovery/responseJournal.js'
import { deliveryFixture } from './fixtures/codex-delivery.js'
import { collect, emit, finish, input, until } from './fixtures/codex-test-helpers.js'

describe('native question answer readback', () => {
  it.each(['Pear', 'Native forms custom label'])('retains confirmation for %s after a completed turn', async answer => {
    const f = await deliveryFixture()
    try {
      const journal = new NativeResponseJournal(join(f.directory, 'responses'))
      const manager = f.makeManager(undefined, {}, { appMcpAccess: 'scoped', responseJournal: journal })
      const session = await manager.createSession(input(f.directory))
      const turn = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'question-turn' }))
      const nativeTurnId = await until(async () => {
        const history = await manager.history(session)
        const started = history.events.find(event => event.type === 'turn.started')
        return typeof started?.payload.turnId === 'string' ? started.payload.turnId : undefined
      })
      await emit(f.directory, { id: 5001, method: 'item/tool/requestUserInput', params: {
        threadId: session.nativeSessionId, turnId: nativeTurnId, itemId: 'fruit-question',
        isBlocking: true, autoResolutionMs: null, questions: [{ id: 'fruit', header: 'Fruit',
          question: 'Choose a fruit', isOther: true, isSecret: false,
          options: [{ label: 'Apple', description: 'Apple' }, { label: 'Pear', description: 'Pear' }] }],
      } })
      const pending = await until(() => manager.pending(session))
      const option = { ...pending.responseOptions[0]!, response: { fruit: { answers: [answer] } } }
      const query = { nativeRequestId: pending.turn.nativeRequestId!, nativeRequestType: pending.nativeRequestType, option }
      await manager.respond(session, query.nativeRequestId, option)
      expect((await manager.reconcileResponse(session, query)).responseDeliveries).toHaveLength(0)
      expect(journal.read(session, query)).toBeUndefined()
      await finish(f.directory, session.nativeSessionId, `RECEIVED ${answer}`)
      await turn
      const completed = await manager.reconcile(session, 'question-turn')
      expect(completed.terminalResult).toMatchObject({ outcome: 'succeeded', output: { text: `RECEIVED ${answer}` } })
      expect(completed.responseDeliveries).toHaveLength(1)
      expect(completed.responseDeliveries![0]).toMatchObject({ nativeRequestId: query.nativeRequestId,
        optionId: option.optionId, source: 'provider_history' })
      await manager.shutdown()
      const restarted = f.makeManager(undefined, {}, { responseJournal: new NativeResponseJournal(join(f.directory, 'responses')) })
      expect((await restarted.reconcileResponse(session, query)).responseDeliveries).toEqual(completed.responseDeliveries)
      expect(await f.wire('turn/start')).toHaveLength(1)
    } finally {
      await f.close()
    }
  })
})
