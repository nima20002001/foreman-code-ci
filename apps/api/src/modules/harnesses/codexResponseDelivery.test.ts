import { describe, expect, it } from 'vitest'
import type { NativeHarnessEvent, PendingNativeInteraction } from '@foreman-code/contracts'
import { responseValueDigest } from '../interactions/delivery.js'
import { codexResponseDeliveryEvidence } from './codexResponseDelivery.js'

const pending: PendingNativeInteraction = {
  session: { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'session' },
  turn: { nativeTurnId: 'turn', nativeRequestId: 'question' },
  nativeRequestType: 'item/tool/requestUserInput',
  request: { itemId: 'question-tool', isBlocking: true, autoResolutionMs: null },
  responseOptions: [{ optionId: 'answer', label: 'Answer', semantic: 'approve_once', persistence: 'request',
    affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false,
    input: { kind: 'questions', questions: [{ id: 'fruit', header: 'Fruit', question: 'Which fruit?',
      isOther: true, isSecret: false, options: null }] } }],
}

function event(sequence: number, type: string, payload: NativeHarnessEvent['payload']): NativeHarnessEvent {
  return { sequence, type, payload, connectionId: 'connection', occurredAt: '2026-10-08T00:00:00Z' }
}

function scenario(answer: string) {
  const option = { ...pending.responseOptions[0]!, response: { fruit: { answers: [answer] } } }
  const submitted = [
    event(1, 'interaction.submitting', { nativeRequestId: 'question', optionId: 'answer' }),
    event(2, 'interaction.submitted', { nativeRequestId: 'question', optionId: 'answer',
      semantic: 'approve_once', responseDigest: responseValueDigest(option.response) }),
    event(3, 'interaction.resolved', { nativeRequestId: 'question', submittedOptionId: 'answer',
      evidence: 'serverRequest/resolved' }),
  ]
  const reply = event(4, 'item.completed', { threadId: 'session', turnId: 'turn',
    item: { type: 'agentMessage', id: 'reply', text: `RECEIVED ${answer}`, phase: 'final_answer' } })
  const completed = event(5, 'turn.completed', { threadId: 'session', turnId: 'turn', status: 'completed' })
  const read = (events: NativeHarnessEvent[], request = pending) =>
    codexResponseDeliveryEvidence(request, option, { answers: option.response }, { events, pendingInteractions: [] })
  return { submitted, reply, completed, read, option }
}

describe('Codex native question delivery', () => {
  it.each(['Pear', 'Native forms custom label'])('confirms %s after the answered blocking turn completes', answer => {
    const f = scenario(answer)
    expect(f.read(f.submitted)).toBeUndefined()
    expect(f.read([...f.submitted, f.reply])).toBeUndefined()
    expect(f.read([...f.submitted, f.reply, f.completed])).toMatchObject({
      nativeRequestId: 'question', optionId: 'answer', responseDigest: responseValueDigest(f.option.response),
    })
  })

  it.each(['failed', 'interrupted'])('keeps an answer unconfirmed after a %s turn', status => {
    const f = scenario('Pear')
    expect(f.read([...f.submitted, f.reply, { ...f.completed, payload: { ...f.completed.payload, status } }]))
      .toBeUndefined()
  })

  it('does not confirm a cleared request, a foreign turn or another connection', () => {
    const f = scenario('Pear')
    expect(f.read([f.submitted[0]!, f.submitted[1]!,
      event(3, 'interaction.cleared', { nativeRequestId: 'question', submittedOptionId: 'answer' }),
      f.reply, f.completed])).toBeUndefined()
    expect(f.read([...f.submitted, f.reply, { ...f.completed,
      payload: { ...f.completed.payload, turnId: 'another-turn' } }])).toBeUndefined()
    expect(f.read([...f.submitted, f.reply, { ...f.completed, connectionId: 'another-connection' }])).toBeUndefined()
    expect(f.read([...f.submitted, f.completed])).toBeUndefined()
  })

  it('does not infer consumption for nonblocking or automatically resolved questions', () => {
    const f = scenario('Pear')
    const events = [...f.submitted, f.reply, f.completed]
    expect(f.read(events, { ...pending, request: { itemId: 'question-tool', isBlocking: false,
      autoResolutionMs: null } })).toBeUndefined()
    expect(f.read(events, { ...pending, request: { itemId: 'question-tool', isBlocking: true,
      autoResolutionMs: 1000 } })).toBeUndefined()
  })

  it('confirms the completed question from correlated native history after a lost terminal notification', () => {
    const f = scenario('Pear')
    const readback = event(5, 'thread.reconciled', { threadId: 'session', thread: {
      id: 'session', turns: [{ id: 'turn', status: 'completed', items: [] }],
    } })
    expect(f.read([...f.submitted, f.reply, readback])).toBeDefined()
    expect(f.read([...f.submitted, f.reply, { ...readback, payload: { ...readback.payload, thread: {
      id: 'session', turns: [{ id: 'other-turn', status: 'completed', items: [] }],
    } } }])).toBeUndefined()
  })

  it('does not infer a permission choice from a successful turn', () => {
    const f = scenario('Pear')
    const permission = { ...pending.responseOptions[0]!, response: f.option.response }
    delete permission.input
    expect(codexResponseDeliveryEvidence(pending, permission, { answers: permission.response }, {
      events: [...f.submitted, f.reply, f.completed], pendingInteractions: [],
    })).toBeUndefined()
  })

  it('still confirms the exact question result before completion and refuses different answers', () => {
    const f = scenario('Pear')
    const output = event(4, 'item.completed', { threadId: 'session', turnId: 'turn', item: {
      type: 'functionCallOutput', id: 'question-tool', name: 'request_user_input',
      output: JSON.stringify({ answers: f.option.response }),
    } })
    expect(f.read([...f.submitted, output])).toBeDefined()
    const otherAnswer = { ...output, payload: { ...output.payload, item: {
      ...output.payload.item as Record<string, unknown>, output: JSON.stringify({ answers: {} }),
    } } }
    expect(f.read([...f.submitted, otherAnswer])).toBeUndefined()
    expect(f.read([...f.submitted, otherAnswer, f.reply, f.completed])).toBeUndefined()
  })
})

function approvalScenario() {
  const option = { optionId: 'deny', label: 'Reject', semantic: 'reject' as const, persistence: 'request' as const,
    affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }
  const approval: PendingNativeInteraction = { session: pending.session, turn: pending.turn,
    nativeRequestType: 'item/permissions/requestApproval', request: { threadId: 'session', turnId: 'turn',
      itemId: 'permissions', permissions: { network: { enabled: true } } }, responseOptions: [option] }
  const events = [
    event(0, 'interaction.pending', { nativeRequestId: 'question',
      nativeRequestType: approval.nativeRequestType, turnId: 'turn' }),
    event(1, 'interaction.submitting', { nativeRequestId: 'question', optionId: 'deny' }),
    event(2, 'interaction.submitted', { nativeRequestId: 'question', optionId: 'deny',
      semantic: 'reject', responseDigest: responseValueDigest(undefined) }),
    event(3, 'interaction.resolved', { nativeRequestId: 'question', submittedOptionId: 'deny',
      evidence: 'serverRequest/resolved' }),
  ]
  const read = (observed: NativeHarnessEvent[]) => codexResponseDeliveryEvidence(approval, option,
    { permissions: {}, scope: 'turn' }, { events: observed, pendingInteractions: [] })
  return { approval, option, events, read }
}

describe('Codex approval acknowledgements', () => {
  it.each(['before', 'after'])('settles a denied permission acknowledged %s the write callback', ordering => {
    const f = approvalScenario()
    if (ordering === 'before') {
      f.events[2]!.sequence = 3
      f.events[3]!.sequence = 2
      f.events.sort((left, right) => left.sequence - right.sequence)
    }
    expect(f.read(f.events)).toEqual({ source: 'provider_acknowledgement', ...pending.session,
      nativeRequestId: 'question', nativeRequestType: f.approval.nativeRequestType,
      optionId: 'deny', semantic: 'reject', responseDigest: responseValueDigest(undefined) })
  })

  const invalid: Array<[string, (events: NativeHarnessEvent[]) => NativeHarnessEvent[]]> = [
    ['no offer', events => events.slice(1)],
    ['no write reservation', events => events.filter(event => event.type !== 'interaction.submitting')],
    ['no submitted response', events => events.filter(event => event.type !== 'interaction.submitted')],
    ['no provider acknowledgement', events => events.slice(0, 3)],
    ['cleared callback', events => events.map(event => event.type === 'interaction.resolved'
      ? { ...event, type: 'interaction.cleared' } : event)],
    ['resolution before the write', events => events.map(event => event.type === 'interaction.resolved'
      ? { ...event, sequence: 0 } : event)],
    ['another connection', events => events.map(event => event.type === 'interaction.resolved'
      ? { ...event, connectionId: 'other-connection' } : event)],
    ['another request', events => events.map(event => event.type === 'interaction.resolved'
      ? { ...event, payload: { ...event.payload, nativeRequestId: 'other-request' } } : event)],
    ['another reserved option', events => events.map(event => event.type === 'interaction.submitting'
      ? { ...event, payload: { ...event.payload, optionId: 'other-option' } } : event)],
    ['another submitted option', events => events.map(event => event.type === 'interaction.submitted'
      ? { ...event, payload: { ...event.payload, optionId: 'other-option' } } : event)],
    ['another resolved option', events => events.map(event => event.type === 'interaction.resolved'
      ? { ...event, payload: { ...event.payload, submittedOptionId: 'other-option' } } : event)],
    ['another response value', events => events.map(event => event.type === 'interaction.submitted'
      ? { ...event, payload: { ...event.payload, responseDigest: responseValueDigest({ different: true }) } } : event)],
    ['another semantic', events => events.map(event => event.type === 'interaction.submitted'
      ? { ...event, payload: { ...event.payload, semantic: 'allow_turn' } } : event)],
    ['terminal clearing', events => events.map(event => event.type === 'interaction.resolved'
      ? { ...event, payload: { ...event.payload, evidence: 'terminal_turn' } } : event)],
    ['another request type', events => events.map(event => event.type === 'interaction.pending'
      ? { ...event, payload: { ...event.payload, nativeRequestType: 'item/tool/requestUserInput' } } : event)],
    ['another turn', events => events.map(event => event.type === 'interaction.pending'
      ? { ...event, payload: { ...event.payload, turnId: 'other-turn' } } : event)],
  ]
  it.each(invalid)('keeps delivery uncertain with %s', (_name, change) => {
    const f = approvalScenario()
    expect(f.read(change(f.events))).toBeUndefined()
  })
})
