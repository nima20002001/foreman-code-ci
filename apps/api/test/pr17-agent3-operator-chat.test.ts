import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type NativeHarnessEvent, type NativeSessionReference, type OperatorConfigurationVersion, type PendingNativeInteraction } from '@foreman-code/contracts'
import { OperatorChatService, type OperatorChatAuthority } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation, type ConversationRow } from '../src/modules/conversations/operatorChatRepository.js'
import type { NativeSessionStart, NativeTurnInput } from '../src/modules/harnesses/port.js'
import type { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { eventually, memoryConversation, operator, ReviewManager } from './fixtures/agent1OperatorChat.js'
import { rejectableDeferred } from './helpers/deferred.js'

const configuration: OperatorConfigurationVersion = {
  id: 'operator-v1', operatorId: 'operator-one', version: 1, harness: DEFAULT_HARNESS_DEFAULTS.codex,
  contentHash: 'sha256:test', createdAt: new Date().toISOString(),
}
class Manager extends ReviewManager {
  rejection: unknown
  afterSubmissionError: unknown
  finish = false
  emitted: NativeHarnessEvent[] = []
  creations = 0
  override async createSession() { this.creations++; return this.session }
  stoppedAutomatic = 0
  attachInputs: NativeSessionStart[] = []
  override async attachSession(session: NativeSessionReference, input?: NativeSessionStart) {
    if (input) this.attachInputs.push(input)
    return super.attachSession(session)
  }
  override async *startTurn(session: NativeSessionReference, input: NativeTurnInput) {
    if (this.rejection) { this.turns++; throw this.rejection }
    yield* super.startTurn(session, input)
    yield* this.emitted
    if (this.afterSubmissionError) throw this.afterSubmissionError
    if (this.finish) this.nativeHistory.terminalResult = { outcome: 'succeeded', output: { text: '' } }
  }
  stopAutomaticResponses() { this.stoppedAutomatic++ }
}
function fixture() {
  const memory = memoryConversation(configuration)
  const owner = operator()
  let current = owner
  let prepared = 0
  const manager = new Manager()
  const { row, repository } = memory
  repository.requestCancel = async (_id, requestId) => {
    if (row.active_request_id !== requestId) return false
    row.cancel_requested = true; row.turn_state = 'canceling'; return true
  }
  repository.claimResponse = async (_id, requestId, nativeRequestId) => {
    if (row.active_request_id !== requestId || row.cancel_requested || row.response_delivery !== 'offered'
      || row.pending_interaction?.turn.nativeRequestId !== nativeRequestId) return false
    row.response_delivery = 'submitted'; return true
  }
  repository.pending = async (_id, requestId, pending) => {
    if (row.active_request_id !== requestId) return
    const same = pending && row.pending_interaction?.turn.nativeRequestId === pending.turn.nativeRequestId
    row.response_delivery = pending ? same ? row.response_delivery : 'offered' : null
    row.pending_interaction = pending ?? null
  }
  repository.responseUncertain = async () => { if (row.response_delivery === 'submitted') row.response_delivery = 'uncertain' }
  repository.responseFailed = async () => { row.response_delivery = 'offered' }
  const authority: OperatorChatAuthority = {
    current: async () => current, assertConfiguration() {},
    setup: async (manager) => ({ harness: manager.harness, status: 'configured', endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() }),
    prepare: async () => { prepared++; return { agentId: configuration.operatorId, variables: {} } },
    release: async () => {},
  }
  const createChat = () => new OperatorChatService(repository, {} as PostgresOperatorRepository, () => manager, '/tmp/operator', authority)
  return { ...memory, owner, manager, authority, chat: createChat(), createChat,
    revoke: () => { current = { ...owner, revokedAt: new Date().toISOString() } },
    prepared: () => prepared }
}
function seed(f: ReturnType<typeof fixture>, phase: ConversationRow['active_phase'] = 'submitted') {
  Object.assign(f.row, { active_request_id: 'request', active_phase: phase, turn_state: 'active',
    ...(phase === 'accepted' || phase === 'creating' ? {} : {
      native_session_id: f.manager.session.nativeSessionId, provider_version: f.manager.session.providerVersion,
    }), active_native_turn_id: phase === 'submitted' ? 'turn' : null })
  f.manager.nativeHistory = { correlationId: nativeCorrelation(f.row.id, 'request'), nativeTurnId: 'turn',
    events: [], pendingInteractions: [] }
}
function approval(f: ReturnType<typeof fixture>): PendingNativeInteraction {
  return { session: f.manager.session, turn: { nativeTurnId: 'turn', nativeRequestId: 'ask' },
    nativeRequestType: 'permission.asked', request: {}, responseOptions: [
      { optionId: 'yes', label: 'Approve once', semantic: 'approve_once', persistence: 'request',
        affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
    ] }
}

describe('PR17 Agent3: durable Operator chat recovery', () => {
  it('F7 settles successful exact terminal history without inventing a message ID, once, then permits a later turn', async () => {
    const f = fixture(); seed(f)
    f.manager.nativeHistory.terminalResult = { outcome: 'succeeded', output: { text: '' } }
    await f.chat.reconcileActive(); await f.chat.reconcileActive()
    expect(f.finishResults).toHaveLength(1)
    expect(f.row.active_request_id).toBeNull()
    expect(f.state().messages).toEqual([])
    f.manager.finish = true
    await f.chat.send(f.row.id, { requestId: 'next', content: 'Explicit next turn' }, f.owner)
    await eventually(() => f.finishResults.length === 2)
    expect(f.manager.turns).toBe(1)
    await f.chat.shutdown()
  })

  for (const error of [
    Object.assign(new Error('Prompt rejected'), { certainty: 'definite' }),
    Object.assign(new Error('Codex rejected turn/start'), { method: 'turn/start', uncertain: false }),
  ]) it('F15 clears a definite pre-onSubmitted rejection as retryable, with no automatic resend', async () => {
    const f = fixture(); f.manager.rejection = error
    await f.chat.send(f.row.id, { requestId: 'rejected', content: 'Try this' }, f.owner)
    await eventually(() => f.row.active_request_id === null)
    expect(f.finishResults[0]).toMatchObject({ outcome: 'failed', error: { retryable: true } })
    await f.chat.reconcileActive()
    expect(f.manager.turns).toBe(1)
    f.manager.rejection = undefined; f.manager.finish = true
    await f.chat.send(f.row.id, { requestId: 'explicit-next', content: 'Another attempt' }, f.owner)
    await eventually(() => f.finishResults.length === 2)
    await f.chat.shutdown()
  })

  for (const error of [
    Object.assign(new Error('Lost prompt acknowledgement'), { certainty: 'uncertain' }),
    Object.assign(new Error('Lost Codex acknowledgement'), { method: 'turn/start', uncertain: true }),
    new Error('Unknown transport outcome'),
  ]) it('F15 keeps uncertain submission fenced across reconciliation and same-ID retry', async () => {
    const f = fixture(); f.manager.rejection = error
    const command = { requestId: 'lost-ack', content: 'Do not submit twice' }
    await f.chat.send(f.row.id, command, f.owner)
    await eventually(() => f.row.turn_state === 'uncertain')
    await f.chat.reconcileActive(); await f.chat.reconcileActive()
    expect((await f.chat.send(f.row.id, command, f.owner)).replayed).toBe(true)
    expect(f.manager.turns).toBe(1); expect(f.row.active_request_id).toBe(command.requestId)
    expect(f.finishResults).toHaveLength(0)
    await f.chat.shutdown()
  })

  it('F15 does not reinterpret a definite error after native onSubmitted as rejection', async () => {
    const f = fixture()
    f.manager.afterSubmissionError = Object.assign(new Error('Later read failed'), { certainty: 'definite' })
    await f.chat.send(f.row.id, { requestId: 'known-turn', content: 'Keep the native identity' }, f.owner)
    await eventually(() => f.row.turn_state === 'uncertain')
    expect(f.row.active_native_turn_id).toBe('review-turn-1')
    expect(f.finishResults).toHaveLength(0)
    await f.chat.shutdown()
  })

  for (const phase of ['accepted', 'ready'] as const) {
    for (const cancel of [false, true]) it(`restart: ${phase}, cancellation=${cancel}, is safe before prompt submission`, async () => {
      const f = fixture(); seed(f, phase); f.row.cancel_requested = cancel
      await f.chat.reconcileActive()
      expect(f.finishResults[0]?.outcome).toBe(cancel ? 'canceled' : 'failed')
      expect(f.manager.turns).toBe(0); expect(f.manager.attachments).toBe(0)
      await f.chat.shutdown()
    })
  }
  for (const phase of ['creating', 'submitting'] as const) it(`restart: ${phase} with unknown delivery is never replayed`, async () => {
    const f = fixture(); seed(f, phase)
    f.manager.nativeHistory = { events: [], pendingInteractions: [] }
    await f.chat.reconcileActive(); await f.chat.cancel(f.row.id, 'request', f.owner); await f.chat.reconcileActive()
    expect(f.row.active_request_id).toBe('request'); expect(f.manager.turns).toBe(0)
    expect(f.finishResults).toHaveLength(0)
    await f.chat.shutdown()
  })

  for (const terminal of [true, false]) it(`F8 revoked owner cleanup after restart; already terminal=${terminal}`, async () => {
    const f = fixture(); seed(f)
    if (terminal) {
      f.manager.nativeHistory.terminalResult = { outcome: 'succeeded', output: { text: '' } }
      f.manager.cancel = async () => false // Existing terminal result wins, not a cancel ACK.
    } else {
      f.row.pending_interaction = approval(f); f.row.response_delivery = 'offered'
      f.manager.pendingInteraction = f.row.pending_interaction
      f.manager.nativeHistory.pendingInteractions = [f.row.pending_interaction]
    }
    f.revoke()
    await f.chat.reconcileActive()
    expect(f.row.active_request_id).toBeNull()
    expect(f.finishResults[0]?.outcome).toBe(terminal ? 'succeeded' : 'canceled')
    expect(f.prepared()).toBe(0) // No new delegated authority.
    expect(f.manager.attachInputs[0]?.environment?.variables).toEqual({ FOREMAN_CODE_MCP_TOKEN: 'operator-cleanup-disabled' })
    expect(f.manager.stoppedAutomatic).toBeGreaterThan(0)
    await expect(f.chat.send(f.row.id, { requestId: 'denied', content: 'New execution' }, f.owner)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await f.chat.shutdown()
  })

  it('F8 notices revocation while a turn is running and still denies approval and new execution', async () => {
    const f = fixture()
    await f.chat.send(f.row.id, { requestId: 'running', content: 'Wait for approval' }, f.owner)
    await eventually(() => f.row.active_native_turn_id !== null)
    f.row.pending_interaction = approval(f); f.row.response_delivery = 'offered'
    f.revoke()
    await expect(f.chat.respond(f.row.id, { requestId: 'running', nativeRequestId: 'ask', optionId: 'yes' }, f.owner))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await eventually(async () => { await f.chat.reconcileActive(); return f.row.active_request_id === null })
    expect(f.manager.responses).toEqual([])
    expect(f.manager.turns).toBe(1)
    await f.chat.shutdown()
  })

  it('a cancellation ACK alone is not terminal evidence', async () => {
    const f = fixture(); seed(f); f.row.cancel_requested = true
    f.manager.cancel = async () => true
    await f.chat.reconcileActive()
    expect(f.row.active_request_id).toBe('request'); expect(f.finishResults).toHaveLength(0)
    await f.chat.shutdown()
  })

  for (const responseOutcome of ['uncertain', 'terminal'] as const) it(`F13 persists cancellation during held ${responseOutcome} response delivery and recovers unrelated conversations`, async () => {
    const f = fixture(); seed(f)
    f.row.pending_interaction = approval(f); f.row.response_delivery = 'offered'
    f.manager.nativeHistory.pendingInteractions = [f.row.pending_interaction]
    const entered = rejectableDeferred(), held = rejectableDeferred()
    f.manager.respond = async (_session, requestId) => {
      f.manager.responses.push(requestId); entered.resolve(); await held.promise
      if (responseOutcome === 'uncertain') throw new Error('Response acknowledgement lost')
      f.manager.nativeHistory.pendingInteractions = []
      f.manager.nativeHistory.terminalResult = { outcome: 'succeeded', output: { text: '' } }
    }
    const response = f.chat.respond(f.row.id, { requestId: 'request', nativeRequestId: 'ask', optionId: 'yes' }, f.owner)
      .catch((error: unknown) => error)
    try {
      await entered.promise
      const state = await f.chat.cancel(f.row.id, 'request', f.owner)
      expect(f.row.cancel_requested).toBe(true); expect(state.activeRequestId).toBe('request')
      expect(f.manager.responses).toEqual(['ask'])
      const second = memoryConversation(configuration, f.owner.id, 'other-chat')
      Object.assign(second.row, { active_request_id: 'other-request', active_phase: 'accepted', turn_state: 'starting' })
      const originalActive = f.repository.active.bind(f.repository), originalFinish = f.repository.finish.bind(f.repository)
      f.repository.active = async (id) => id === second.row.id ? structuredClone(second.row) : originalActive(id)
      f.repository.finish = (id, ...args) => id === second.row.id ? second.repository.finish(id, ...args) : originalFinish(id, ...args)
      const originalTerminal = f.repository.terminal.bind(f.repository)
      f.repository.terminal = (id, ...args) => id === second.row.id
        ? second.repository.terminal(id, ...args) : originalTerminal(id, ...args)
      const originalJournalTerminal = f.repository.journalTerminal.bind(f.repository)
      f.repository.journalTerminal = (id, ...args) => id === second.row.id
        ? second.repository.journalTerminal(id, ...args) : originalJournalTerminal(id, ...args)
      const originalTerminalHistoryPersisted = f.repository.terminalHistoryPersisted.bind(f.repository)
      f.repository.terminalHistoryPersisted = (id, ...args) => id === second.row.id
        ? second.repository.terminalHistoryPersisted(id, ...args) : originalTerminalHistoryPersisted(id, ...args)
      const originalClosurePending = f.repository.closurePending.bind(f.repository)
      f.repository.closurePending = (id, ...args) => id === second.row.id
        ? second.repository.closurePending(id, ...args) : originalClosurePending(id, ...args)
      const originalClosureProven = f.repository.closureProven.bind(f.repository)
      f.repository.closureProven = (id, ...args) => id === second.row.id
        ? second.repository.closureProven(id, ...args) : originalClosureProven(id, ...args)
      f.repository.unfinished = async () => [structuredClone(f.row), structuredClone(second.row)]
      await f.chat.reconcileActive()
      expect(second.row.active_request_id).toBeNull()
      held.resolve(); await response
      await eventually(async () => { await f.chat.reconcileActive(); return f.row.active_request_id === null })
      expect(f.manager.responses).toEqual(['ask'])
      expect(f.finishResults[0]?.outcome).toBe(responseOutcome === 'terminal' ? 'succeeded' : 'canceled')
      await expect(f.chat.respond(f.row.id, { requestId: 'request', nativeRequestId: 'ask', optionId: 'yes' }, f.owner)).rejects.toBeDefined()
    } finally { held.resolve(); await response; await f.chat.shutdown() }
  })

  it('uncertain approval delivery remains non-repeatable after a restarted observer sees the same ask', async () => {
    const f = fixture(); seed(f)
    f.row.pending_interaction = approval(f); f.row.response_delivery = 'uncertain'
    f.manager.nativeHistory.pendingInteractions = [f.row.pending_interaction]
    await f.chat.reconcileActive()
    expect(f.row.response_delivery).toBe('uncertain')
    await expect(f.chat.respond(f.row.id, { requestId: 'request', nativeRequestId: 'ask', optionId: 'yes' }, f.owner))
      .rejects.toMatchObject({ code: 'NATIVE_RESPONSE_UNCERTAIN' })
    expect(f.manager.responses).toEqual([])
    await f.chat.cancel(f.row.id, 'request', f.owner)
    await eventually(async () => { await f.chat.reconcileActive(); return f.row.active_request_id === null })
    await f.chat.shutdown()
  })
  for (const phase of ['prepare', 'create'] as const) it(`cancel during ${phase} never submits a prompt, even if creation returns an identity`, async () => {
    const f = fixture(), entered = rejectableDeferred(), gate = rejectableDeferred()
    if (phase === 'prepare') f.authority.prepare = async () => {
      entered.resolve(); await gate.promise
      return { agentId: configuration.operatorId, variables: {} }
    }
    else f.manager.createSession = async () => {
      f.manager.creations++; entered.resolve(); await gate.promise; return f.manager.session
    }
    try {
      await f.chat.send(f.row.id, { requestId: 'cancel-before-prompt', content: 'Do not submit after cancellation' }, f.owner)
      await entered.promise
      await f.chat.cancel(f.row.id, 'cancel-before-prompt', f.owner)
      expect(f.row.cancel_requested).toBe(true)
      gate.resolve()
      await eventually(() => f.row.active_request_id === null)
      expect(f.finishResults[0]?.outcome).toBe('canceled')
      expect(f.manager.turns).toBe(0)
      expect(f.manager.creations).toBe(phase === 'create' ? 1 : 0)
      if (phase === 'create') expect(f.row.native_session_id).toBe(f.manager.session.nativeSessionId)
    } finally { gate.resolve(); await f.chat.shutdown() }
  })

  it('recovers a created native session whose first durable bind failed without replaying setup or prompt', async () => {
    const f = fixture(), bind = f.repository.bind.bind(f.repository)
    let first = true
    f.repository.bind = async (...args) => {
      if (first) { first = false; throw new Error('Database unavailable after session creation') }
      return bind(...args)
    }
    await f.chat.send(f.row.id, { requestId: 'bind-lost', content: 'Keep returned session identity' }, f.owner)
    await eventually(() => f.row.turn_state === 'uncertain')
    expect(f.row.native_session_id).toBeNull()
    await f.chat.reconcileActive()
    expect(f.row.native_session_id).toBe(f.manager.session.nativeSessionId)
    expect(f.row.active_request_id).toBeNull()
    expect(f.manager.creations).toBe(1)
    expect(f.manager.turns).toBe(0)
    await f.chat.shutdown()
  })

  for (const mismatch of ['correlation', 'turn']) it(`does not accept terminal evidence for a different ${mismatch}`, async () => {
    const f = fixture(); seed(f)
    f.manager.nativeHistory.terminalResult = { outcome: 'succeeded' }
    if (mismatch === 'turn') f.manager.nativeHistory.nativeTurnId = 'foreign-turn'
    else f.manager.nativeHistory.correlationId = 'foreign-correlation'
    await f.chat.reconcileActive()
    expect(f.row.active_request_id).toBe('request')
    expect(f.finishResults).toHaveLength(0)
    await f.chat.shutdown()
  })

})

it('W05 does not advertise authoritative final text when its repository mutation was declined', async () => {
  const f = fixture(), deltas: unknown[] = []
  f.repository.appendAssistantTextOperation = async () => ({ status: 'ignored', revision: String(f.row.revision) })
  f.manager.emitted = [{ sequence: 1, type: 'item.completed', occurredAt: new Date().toISOString(),
    payload: { item: { id: 'uncommitted-item', type: 'agentMessage', text: 'uncommitted text' } } },
    { sequence: 2, type: 'assistant.delta', occurredAt: new Date().toISOString(), payload: { itemId: 'uncommitted-item', text: 'late' } }]
  f.manager.finish = true
  const unsubscribe = f.chat.events.subscribe(f.row.id, (event) => { if (event.type === 'delta') deltas.push(event.data) })
  try {
    await f.chat.send(f.row.id, { requestId: 'commit-before-publish', content: 'Keep canonical ownership' }, f.owner)
    await eventually(() => f.finishResults.length === 1)
    expect(deltas).toEqual([])
  } finally { unsubscribe(); await f.chat.shutdown() }
})

it('mounts exact transport fences and authoritative same-status history in Operator activity writers', async () => {
  const f = fixture()
  const calls: unknown[][] = []
  const activity = { append: async (...args: unknown[]) => { calls.push(args); return undefined } }
  Object.assign(f.repository, { activity })
  const event = (sequence: number, output: string): NativeHarnessEvent => ({ connectionId: 'operator-connection', sequence,
    occurredAt: '2026-10-01T00:00:00Z', type: 'item.snapshot', payload: { turnId: 'review-turn-1',
      item: { id: 'operator-tool', type: 'commandExecution', status: 'running', aggregatedOutput: output },
    } })
  f.manager.emitted = [event(1, 'first'), event(2, 'second')]
  f.manager.finish = true
  f.manager.reconcile = async () => ({ ...f.manager.nativeHistory, events: [event(0, 'history correction')] })
  try {
    await f.chat.send(f.row.id, { requestId: 'operator-activity', content: 'Use tool' }, f.owner)
    await eventually(() => f.finishResults.length === 1)
    expect(calls.map((call) => (call[2] as { output?: string }).output)).toEqual(['first', 'second', 'history correction', 'history correction'])
    expect(calls[0]?.[3]).toMatchObject({ nativeSessionId: 'review-native-session', nativeTurnId: 'review-turn-1',
      authoritativeReconciliation: false, connectionId: 'operator-connection', source: { transportSequence: 1 } })
    expect(calls[2]?.[3]).toMatchObject({ nativeSessionId: 'review-native-session', nativeTurnId: 'review-turn-1',
      authoritativeReconciliation: true, source: { system: 'codex_history' } })
    expect((calls[2]?.[3] as { source: { sequence?: string } }).source.sequence).toBeUndefined()
  } finally { await f.chat.shutdown() }
})
