import { messageTextPartKey } from '../chatTimeline'
import { activityScopeKey, reconcileActivitySnapshot, sourceVectorIsStale, sourceVectorHasAdvance } from './activityMerge'
import { isSessionNativeInteraction, type Message } from '@foreman-code/contracts'
import type { AgentChatContext, AgentChatIntent, AgentChatState, AgentChatTurn } from '@foreman-code/contracts/agent-chat'

/** A draft exists before a conversation does. Never key it by Agent alone or by a native id. */
export function agentChatContextKey(context: AgentChatContext): string {
  return JSON.stringify(['agent-chat', context.workspaceId, context.workflowId, context.workflowNodeId, context.agentId, context.runId ?? null])
}
export function sameAgentChatContext(a: AgentChatContext, b: AgentChatContext): boolean {
  return agentChatContextKey(a) === agentChatContextKey(b)
}
export function stateBelongsToContext(state: AgentChatState, context: AgentChatContext): boolean {
  if (!sameAgentChatContext(state.context, context)) return false
  if (state.sourceTranscript && !context.runId) return false
  const conversation = state.conversation
  if (!conversation) return state.messages.length === 0 && state.turns.length === 0 && !state.pendingInteraction
  if (conversation.workspaceId !== context.workspaceId || conversation.workflowId !== context.workflowId
    || conversation.workflowNodeId !== context.workflowNodeId || conversation.agentId !== context.agentId) return false
  if (context.runId ? conversation.origin.kind !== 'run_execution' || conversation.origin.runId !== context.runId
    : conversation.origin.kind !== 'fresh') return false
  if (state.sourceTranscript && conversation.origin.kind === 'run_execution'
    && state.sourceTranscript.executionId !== conversation.origin.executionId) return false
  return state.messages.every((message) => message.conversationId === conversation.id)
}

/** Full server projections replace, not append. Completed native text cannot become partial again. */
export function mergeChatMessages(...sources: readonly (readonly Message[])[]): Message[] {
  const messages = new Map<string, Message>()
  const order: string[] = []
  for (const source of sources) {
    for (const message of source) {
      const previous = messages.get(message.id)
      if (previous?.conversationId !== undefined && previous.conversationId !== message.conversationId) continue
      if (previous?.activityNative && message.activityNative
        && messageTextPartKey(previous) !== messageTextPartKey(message)) continue
      if (previous?.revision !== undefined) {
        if (message.revision === undefined || BigInt(message.revision) < BigInt(previous.revision)) continue
        if (message.revision === previous.revision) {
          if (message.content === previous.content && message.nativeMessageComplete === previous.nativeMessageComplete && (message.attachments !== undefined || message.originalInput !== undefined || message.acceptedModel !== undefined)) messages.set(message.id, { ...previous,
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            ...(message.acceptedModel !== undefined ? { acceptedModel: message.acceptedModel } : {}),
            ...(message.originalInput !== undefined ? { originalInput: message.originalInput } : {}) })
          continue
        }
      }
      if (previous?.nativeMessageComplete === true && message.nativeMessageComplete !== true) continue
      messages.set(message.id, message)
    }
    // Each source is an ordered server window. Anchor an unseen prefix before its overlap,
    // rather than letting Map insertion order move a newer subset ahead of older messages.
    let insertAt = order.length
    for (const id of [...new Set(source.map((message) => message.id))].reverse()) {
      const index = order.indexOf(id)
      if (index < 0) order.splice(insertAt, 0, id)
      else insertAt = index
    }
  }
  return order.map((id) => messages.get(id)!)
}
export function acceptAgentChatState(previous: AgentChatState | undefined, incoming: AgentChatState, source: 'read' | 'receipt' = 'receipt'): AgentChatState {
  if (source === 'receipt' && previous?.conversation && incoming.conversation
    && previous.conversation.id !== incoming.conversation.id) return previous
  const qualificationChanged = previous?.qualificationKey !== incoming.qualificationKey
  if (previous && sameAgentChatContext(previous.context, incoming.context) && source === 'receipt' && previous.qualificationKey !== incoming.qualificationKey) {
    incoming = { ...incoming, qualificationKey: previous.qualificationKey,
      capabilities: { ...previous.capabilities, resume: previous.capabilities.resume && incoming.capabilities.resume,
        queueNextTurn: previous.capabilities.queueNextTurn && incoming.capabilities.queueNextTurn,
        interruptAndSend: previous.capabilities.interruptAndSend && incoming.capabilities.interruptAndSend,
        steer: previous.capabilities.steer === incoming.capabilities.steer ? previous.capabilities.steer : 'unavailable' },
      availability: previous.availability.canSend && incoming.availability.canSend ? previous.availability : { ...incoming.availability, canSend: false },
      responseAvailability: incoming.responseAvailability?.available === false ? incoming.responseAvailability : previous.responseAvailability }
  }
  if (previous && sameAgentChatContext(previous.context, incoming.context)) {
    // A GET started before the first POST may still return `none` after its receipt arrived.
    if (previous.conversation && !incoming.conversation && incoming.revision <= previous.revision) return previous
    if (previous.conversation?.id === incoming.conversation?.id) {
      if (previous.activitySnapshot && !incoming.activitySnapshot) return previous
      const revisionOrder = previous.activitySnapshot && incoming.activitySnapshot
        ? BigInt(incoming.activitySnapshot.revision) < BigInt(previous.activitySnapshot.revision) ? -1 : BigInt(incoming.activitySnapshot.revision) > BigInt(previous.activitySnapshot.revision) ? 1 : 0
        : incoming.revision < previous.revision ? -1 : incoming.revision > previous.revision ? 1 : 0
      if (previous.activitySnapshot && incoming.activitySnapshot && activityScopeKey(previous.activitySnapshot.scope) !== activityScopeKey(incoming.activitySnapshot.scope)) return previous
      if (previous.activitySnapshot && incoming.activitySnapshot && sourceVectorIsStale(previous.activitySnapshot, incoming.activitySnapshot)) return previous
      if (revisionOrder < 0) {
        if (!incoming.activitySnapshot || !previous.activitySnapshot) return previous
        return { ...previous, activitySnapshot: reconcileActivitySnapshot(previous.activitySnapshot, incoming.activitySnapshot, previous.activitySnapshot.scope)! }
      }
      if (revisionOrder === 0) {
        // Conversation revisions cover persisted lifecycle, not current Run/setup qualification.
        // Only an authorized read can refresh those separately qualified facts; receipt replay cannot.
        if (source === 'receipt' && !incoming.activitySnapshot && !qualificationChanged) return previous
        const activitySnapshot = incoming.activitySnapshot ? reconcileActivitySnapshot(previous.activitySnapshot, incoming.activitySnapshot, incoming.activitySnapshot.scope) : previous.activitySnapshot
        const advanced = previous.activitySnapshot && incoming.activitySnapshot && sourceVectorHasAdvance(previous.activitySnapshot, incoming.activitySnapshot)
        const messages = advanced || source === 'read' ? mergeChatMessages(previous.messages, incoming.messages)
          .filter((message) => incoming.messages.some((entry) => entry.id === message.id)) : previous.messages
        if (source === 'receipt' && !qualificationChanged) return { ...previous, messages, ...(activitySnapshot ? { activitySnapshot } : {}) }
        let sourceTranscript = previous.sourceTranscript
        if (source === 'read' && (!sourceTranscript || !incoming.sourceTranscript
          || sourceTranscript.executionId !== incoming.sourceTranscript.executionId
          || BigInt(incoming.sourceTranscript.revision) >= BigInt(sourceTranscript.revision))) {
          sourceTranscript = incoming.sourceTranscript
        }
        return { ...previous, messages, ...(activitySnapshot ? { activitySnapshot } : {}),
          sourceTranscript, capabilities: incoming.capabilities, availability: incoming.availability,
          responseAvailability: incoming.responseAvailability, qualificationKey: incoming.qualificationKey }
      }
    }
  }
  const previousMessages = previous?.conversation?.id === incoming.conversation?.id ? previous?.messages : undefined
  const complete = new Map(previousMessages?.filter((message) => message.nativeMessageComplete === true).map((message) => [message.id, message]))
  const activitySnapshot = incoming.activitySnapshot ? reconcileActivitySnapshot(previous?.activitySnapshot, incoming.activitySnapshot, incoming.activitySnapshot.scope) : undefined
  return { ...incoming, ...(activitySnapshot ? { activitySnapshot } : {}), messages: mergeChatMessages(previousMessages ?? [], incoming.messages.map((message) =>
    message.nativeMessageComplete !== true && complete.has(message.id) ? complete.get(message.id)! : message)).filter((message) => incoming.messages.some((entry) => entry.id === message.id)),
    turns: [...new Map(incoming.turns.map((turn) => [turn.requestId, turn])).values()]
      .sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0) }
}

export const deliveryLabels: Record<AgentChatTurn['delivery'], string> = {
  queued: 'Queued', submitting: 'Sending', accepted: 'Delivered', completed: 'Completed', failed: 'Failed', canceled: 'Canceled', unknown: 'Unknown',
}
export const intentLabels: Record<AgentChatIntent, string> = { next_turn: 'Next turn', steer: 'Steer', interrupt_and_send: 'Interrupt and send' }
export function chatBusy(state: AgentChatState): boolean {
  return !!state.activeTurn || ['creating', 'active', 'interrupting', 'waiting_approval'].includes(state.sessionState)
}

/** UI affordances only; the server rechecks authority and native capability at admission. */
export function intentUnavailable(state: AgentChatState, intent: AgentChatIntent): string | undefined {
  if (!state.availability.canSend) return state.availability.message ?? 'Messaging is unavailable for this selection.'
  if (state.sessionState === 'unavailable') return state.availability.message ?? 'The native session is unavailable.'
  if (state.sessionState === 'creating' || state.sessionState === 'interrupting') return 'Wait for the current native operation to settle.'
  const capabilities = state.capabilities
  if (intent === 'steer') {
    if (capabilities.steer === 'unavailable') return capabilities.unavailable.steer ?? 'Steering is unavailable.'
    if (!state.activeTurn) return 'The turn has finished. Send as next turn instead.'
    if (capabilities.steer === 'native_expected_turn' && !state.activeTurn.nativeTurnId) return 'Waiting for the active native turn identity.'
  }
  if (intent === 'interrupt_and_send' && !capabilities.interruptAndSend) {
    return capabilities.unavailable.interruptAndSend ?? 'Interrupt and send is unavailable.'
  }
  if (intent === 'next_turn') {
    if (chatBusy(state) && !capabilities.queueNextTurn) return capabilities.unavailable.queueNextTurn ?? 'Queueing is unavailable.'
    if (!chatBusy(state) && state.conversation && !capabilities.resume) return capabilities.unavailable.resume ?? 'This conversation cannot continue.'
  }
  return undefined
}

/** A response must address the exact pending request in this conversation, not a workflow approval. */
export function approvalReplyAvailable(state: AgentChatState): boolean {
  const pending = state.pendingInteraction
  if (!state.responseAvailability?.available || state.responseAvailability.nativeRequestId !== pending?.turn.nativeRequestId
    || state.responseAvailability.nativeSessionId !== pending?.session.nativeSessionId
    || state.responseAvailability.nativeRequestType !== pending?.nativeRequestType
    || state.responseAvailability.nativeTurnId && state.responseAvailability.nativeTurnId !== pending?.turn.nativeTurnId) return false
  return !!pending?.turn.nativeRequestId && !!state.conversation?.nativeSession
    && pending.session.nativeSessionId === state.conversation.nativeSession.nativeSessionId
    && pending.session.harness === state.conversation.harness
    && (isSessionNativeInteraction(pending) || !state.activeTurn?.nativeTurnId
      || pending.turn.nativeTurnId === state.activeTurn.nativeTurnId)
}
