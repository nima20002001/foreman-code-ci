import { CODEX_APPROVAL_OPTIONS_FIXTURE } from '@foreman-code/contracts'
import { agentChatFixtures, type AgentChatState } from '@foreman-code/contracts/agent-chat'

export const chatHarnesses = ['codex', 'claude'] as const

/** Explicit wire fixtures for PR #51, not execution of either provider. The shared cooperative
 * Claude fixture is a contract possibility, not the capability advertised by this backend. */
export function providerFixture(harness: typeof chatHarnesses[number], source: AgentChatState = agentChatFixtures.empty): AgentChatState {
  const state = structuredClone(source)
  const providerVersion = harness === 'codex' ? '0.157.1' : '2.1.128'
  state.capabilities = { harness, providerVersion: state.conversation ? providerVersion : null,
    steer: harness === 'codex' ? 'native_expected_turn' : 'unavailable',
    interruptAndSend: true, queueNextTurn: true, resume: true,
    unavailable: harness === 'codex' ? {} : { steer: 'Claude cannot add input to a running turn with a turn precondition. Queue it for the next turn or interrupt and send.' } }
  if (harness === 'claude') {
    const steerIds = new Set(state.turns.filter((turn) => turn.intent === 'steer').map((turn) => turn.requestId))
    state.turns = state.turns.filter((turn) => !steerIds.has(turn.requestId))
    state.messages = state.messages.filter((message) => !message.requestId || !steerIds.has(message.requestId))
  }
  if (state.conversation) {
    state.conversation.harness = harness
    if (state.conversation.nativeSession) state.conversation.nativeSession = {
      nativeSessionId: `${harness}-session-fixture`, providerVersion,
    }
  }
  return state
}

/** Advance only when a test explicitly supplies a later authoritative projection. No timer or
 * send handler invents native acceptance, and no fixture output is real-provider evidence. */
export function startedFixture(state: AgentChatState, requestId: string): AgentChatState {
  const next = structuredClone(state), turn = next.turns.find((entry) => entry.requestId === requestId)
  if (!next.conversation || !turn || turn.delivery !== 'queued') throw new Error('Expected an admitted queued fixture turn')
  if (next.activeTurn) throw new Error('Settle the active fixture turn before starting another')
  const harness = next.conversation.harness, providerVersion = harness === 'codex' ? '0.157.1' : '2.1.128'
  next.conversation.nativeSession ??= { nativeSessionId: `${harness}-session-fixture`, providerVersion }
  next.capabilities.providerVersion = providerVersion
  next.activeTurn = { requestId, nativeTurnId: `native-${requestId}`, startedAt: turn.createdAt }
  turn.delivery = 'accepted'; turn.nativeTurnId = next.activeTurn.nativeTurnId
  next.sessionState = 'active'; next.revision++
  return next
}

export function completedFixture(state: AgentChatState, text: string): AgentChatState {
  const next = structuredClone(state), requestId = next.activeTurn?.requestId
  const turn = next.turns.find((entry) => entry.requestId === requestId)
  if (!next.conversation || !turn) throw new Error('Expected an active fixture turn')
  turn.delivery = 'completed'
  next.messages.push({ id: `reply-${requestId}`, conversationId: next.conversation.id, requestId,
    role: 'assistant', content: text, nativeMessageComplete: true })
  next.sessionState = 'idle'; next.activeTurn = null; next.revision++
  delete next.pendingInteraction
  return next
}

export function approvalFixture(state: AgentChatState): AgentChatState {
  const next = structuredClone(state), session = next.conversation?.nativeSession
  if (!session || !next.activeTurn?.nativeTurnId) throw new Error('Expected a bound active fixture turn')
  const harness = next.conversation!.harness
  next.sessionState = 'waiting_approval'; next.revision++
  next.pendingInteraction = { session: { ...session, harness },
    turn: { nativeTurnId: next.activeTurn.nativeTurnId, nativeRequestId: `${harness}-approval` },
    nativeRequestType: harness === 'codex' ? 'item/commandExecution/requestApproval' : 'can_use_tool',
    request: { command: ['read', 'README.md'] },
    responseOptions: structuredClone(CODEX_APPROVAL_OPTIONS_FIXTURE).map(option => ({ ...option, optionId: option.optionId.replace('codex-', `${harness}-`) })) }
  // This controlled wire scenario explicitly represents an available native callback.
  next.responseAvailability = { nativeSessionId: session.nativeSessionId, nativeRequestId: `${harness}-approval`,
    nativeTurnId: next.activeTurn.nativeTurnId, nativeRequestType: next.pendingInteraction.nativeRequestType,
    available: true, status: 'available', path: 'live_callback', reason: 'live_callback', message: 'Native reply callback is available.' }
  return next
}

/** Terminal A-R16/B-R06 decision: resume is the backend's CURRENT continuation fact. The UI
 * cannot infer process residency from provider name/settings. Restart loss is a separate state. */
export function ephemeralFixture(phase: 'empty' | 'live' | 'restarted'): AgentChatState {
  const state = providerFixture('codex', phase === 'empty' ? agentChatFixtures.empty : agentChatFixtures.idleAfterCompletion)
  if (phase === 'restarted') {
    state.revision++; state.sessionState = 'unavailable'
    state.availability = { canSend: false, reason: 'native_session_missing',
      message: 'This ephemeral Codex session was lost when the API restarted. It cannot be resumed.' }
    state.capabilities.resume = false
    state.capabilities.unavailable.resume = state.availability.message
  }
  return state
}
