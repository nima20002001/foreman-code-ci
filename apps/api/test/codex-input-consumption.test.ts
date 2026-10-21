import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { withInteractionResponse } from '@foreman-code/contracts'
import { NativeResponseJournal } from '../src/modules/harnesses/recovery/responseJournal.js'
import { collect, emit, input, until } from './fixtures/codex-test-helpers.js'
import { deliveryFixture } from './fixtures/codex-delivery.js'

let f: Awaited<ReturnType<typeof deliveryFixture>>
beforeEach(async () => { f = await deliveryFixture() })
afterEach(async () => { await f.close() })

it.each(['questions', 'form'] as const)('proves %s consumption through native results and reopens its receipt', async kind => {
  await f.json('workflow-input.json', kind === 'questions'
    ? { method: 'item/tool/requestUserInput', params: { itemId: 'question-tool', isBlocking: true,
      questions: [{ id: 'answer', header: 'Answer', question: 'Enter an answer', isOther: true,
        isSecret: false, options: null }] } }
    : { method: 'mcpServer/elicitation/request', params: { mode: 'form', serverName: 'app', message: 'Enter details',
      requestedSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } } })
  const journalPath = join(f.directory, 'response-journal')
  const manager = f.makeManager(undefined, {}, { responseJournal: new NativeResponseJournal(journalPath) })
  const source = input(f.directory)
  delete source.environment
  const session = await manager.createSession(source)
  const completed = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'input' }))
  const pending = await until(async () => manager.pending(session))
  const option = withInteractionResponse(pending.responseOptions[0]!, kind === 'questions'
    ? { answer: { answers: ['Entered'] } } : { count: 2 })
  const identity = { nativeRequestId: pending.turn.nativeRequestId!, nativeRequestType: pending.nativeRequestType, option }
  expect((await manager.reconcileResponse(session, identity)).responseDeliveries).toEqual([])
  await manager.respond(session, identity.nativeRequestId, option)
  await completed
  const proof = (await manager.reconcileResponse(session, identity)).responseDeliveries![0]!
  expect(proof).toMatchObject({ source: 'provider_history', nativeRequestId: identity.nativeRequestId,
    optionId: option.optionId, semantic: option.semantic })
  await manager.shutdown()
  const reopened = new NativeResponseJournal(journalPath)
  expect(reopened.read(session, identity)).toEqual(proof)
  expect(() => reopened.read(session, { ...identity, option: { ...option, response: kind === 'questions'
    ? { answer: { answers: ['Different'] } } : { count: 3 } } })).toThrow('exact response')
  expect(await f.wire('turn/start')).toHaveLength(1)
})

it('does not treat request resolution or a canceled turn as consumed user input', async () => {
  await f.json('workflow-input.json', { method: 'item/tool/requestUserInput', params: {
    itemId: 'question-tool', isBlocking: true, questions: [{ id: 'answer', header: 'Answer', question: 'Enter an answer',
      isOther: true, isSecret: false, options: null }],
  } })
  const manager = f.makeManager()
  const source = input(f.directory)
  delete source.environment
  const session = await manager.createSession(source)
  await f.flag('no-resolution')
  const stream = manager.startTurn(session, { prompt: 'approval', clientCorrelationId: 'cleared' })[Symbol.asyncIterator]()
  await stream.next()
  const pending = await until(async () => manager.pending(session))
  const option = withInteractionResponse(pending.responseOptions[0]!, { answer: { answers: ['Entered'] } })
  const response = manager.respond(session, pending.turn.nativeRequestId!, option)
  await Promise.all([
    expect(response).rejects.toThrow('cleared'),
    manager.cancel(session),
  ])
  expect((await manager.history(session)).responseDeliveries).toEqual([])
  await stream.return?.()
})

it('confirms a standalone form with session/request identity and an unchanged native readback', async () => {
  const journalPath = join(f.directory, 'response-journal')
  const manager = f.makeManager(undefined, {}, { responseJournal: new NativeResponseJournal(journalPath) })
  const source = input(f.directory)
  delete source.environment
  const session = await manager.createSession(source)
  await emit(f.directory, { id: 6200, method: 'mcpServer/elicitation/request', params: {
    threadId: session.nativeSessionId, turnId: null, mode: 'form', serverName: 'app', message: 'Enter details',
    requestedSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
  } })
  const pending = await until(async () => manager.pending(session))
  expect(pending.turn.nativeTurnId).toBeUndefined()
  const option = withInteractionResponse(pending.responseOptions[0]!, { count: 2 })
  await manager.respond(session, pending.turn.nativeRequestId!, option)
  const identity = { nativeRequestId: pending.turn.nativeRequestId!, nativeRequestType: pending.nativeRequestType, option }
  const evidence = (await manager.reconcileResponse(session, identity)).responseDeliveries![0]!
  expect(evidence).toMatchObject({ source: 'provider_history', nativeSessionId: session.nativeSessionId,
    nativeRequestId: identity.nativeRequestId, optionId: option.optionId })
  expect(new NativeResponseJournal(journalPath).read(session, identity)).toEqual(evidence)
  expect(await f.wire('turn/start')).toHaveLength(0)
})

it('keeps a form uncertain when resolution is followed by a native turn transition', async () => {
  const manager = f.makeManager()
  const source = input(f.directory)
  delete source.environment
  const session = await manager.createSession(source)
  const completed = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'transition' }))
  const turnId = await until(async () => {
    const history = await manager.reconcile(session, 'transition')
    return history.nativeTurnId
  })
  await f.flag('no-resolution')
  await emit(f.directory, { id: 6201, method: 'mcpServer/elicitation/request', params: {
    threadId: session.nativeSessionId, turnId, mode: 'form', serverName: 'app', message: 'Enter details',
    requestedSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
  } })
  const pending = await until(async () => manager.pending(session))
  const option = withInteractionResponse(pending.responseOptions[0]!, { count: 2 })
  const responding = manager.respond(session, pending.turn.nativeRequestId!, option)
  await until(async () => (await manager.history(session)).events.some(event => event.type === 'interaction.submitted'))
  await emit(f.directory, { method: 'serverRequest/resolved', params: { threadId: session.nativeSessionId, requestId: 6201 } })
  await responding
  await manager.cancel(session)
  await completed
  const history = await manager.reconcileResponse(session, { nativeRequestId: pending.turn.nativeRequestId!,
    nativeRequestType: pending.nativeRequestType, option })
  expect(history.responseDeliveries).toEqual([])
})
