import { describe, expect, it } from 'vitest'
import { agentChatFixtures, codexChatCapabilities, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { acceptAgentChatState, agentChatContextKey, approvalReplyAvailable, intentUnavailable, mergeChatMessages, stateBelongsToContext } from './model'
import type { Message } from '@foreman-code/contracts'
import { approvalState } from './testSupport'

it('refreshes an accepted model projection at the same message revision without accepting changed content', () => {
  const previous: Message = { id: 'accepted-message', conversationId: 'operator-chat', requestId: 'accepted-turn',
    role: 'assistant', revision: '1', content: 'Recorded answer', nativeMessageComplete: true }
  const projected: Message = { ...previous, acceptedModel: { harness: 'claude', model: 'claude-opus-5-5' } }
  expect(mergeChatMessages([previous], [projected])).toEqual([projected])
  expect(mergeChatMessages([projected], [previous])).toEqual([projected])
  expect(mergeChatMessages([previous], [{ ...projected, content: 'Changed answer' }])).toEqual([previous])
})

describe('Agent chat identity and state projection', () => {
  it('refreshes a source transcript independently of the conversation revision and rejects older text', () => {
    const previous: AgentChatState = { ...structuredClone(agentChatFixtures.empty),
      context: { ...agentChatFixtures.empty.context, runId: 'source-run' },
      sourceTranscript: { executionId: 'source-execution', state: 'running', revision: '1',
        messages: [{ id: 'source-item', role: 'assistant', content: 'Partial output' }], hasEarlierMessages: false } }
    const incoming: AgentChatState = { ...previous, sourceTranscript: { ...previous.sourceTranscript!, revision: '2',
      messages: [{ id: 'source-item', role: 'assistant', content: 'Completed output', nativeMessageComplete: true }] } }
    const accepted = acceptAgentChatState(previous, incoming, 'read')
    expect(accepted.sourceTranscript?.messages[0]?.content).toBe('Completed output')
    expect(acceptAgentChatState(accepted, previous, 'read').sourceTranscript).toEqual(accepted.sourceTranscript)
    expect(stateBelongsToContext(previous, previous.context)).toBe(true)
    expect(stateBelongsToContext({ ...previous, context: agentChatFixtures.empty.context }, agentChatFixtures.empty.context)).toBe(false)
  })

  it.each(Object.entries(agentChatFixtures))('accepts the exact context of fixture %s', (_name, state) => {
    expect(stateBelongsToContext(state, state.context)).toBe(true)
  })
  it('keys all five identities and never collapses absent Run into a real Run', () => {
    const context = agentChatFixtures.empty.context
    const keys = [agentChatContextKey(context), ...(['workspaceId', 'workflowId', 'workflowNodeId', 'agentId', 'runId'] as const)
      .map((key) => agentChatContextKey({ ...context, [key]: 'other' }))]
    expect(new Set(keys).size).toBe(6)
    expect(agentChatContextKey({ ...context, workflowId: 'x:y', workflowNodeId: 'z' }))
      .not.toBe(agentChatContextKey({ ...context, workflowId: 'x', workflowNodeId: 'y:z' }))
  })
  it('rejects another key, an inconsistent conversation, a wrong Run origin, and foreign messages', () => {
    const state: AgentChatState = structuredClone(agentChatFixtures.active)
    expect(stateBelongsToContext(state, { ...state.context, agentId: 'other' })).toBe(false)
    state.conversation!.agentId = 'other'; expect(stateBelongsToContext(state, state.context)).toBe(false)
    state.conversation!.agentId = state.context.agentId
    state.context.runId = 'some-run'; expect(stateBelongsToContext(state, state.context)).toBe(false)
    delete state.context.runId
    state.messages[0]!.conversationId = 'foreign'; expect(stateBelongsToContext(state, state.context)).toBe(false)
  })
  it('an old GET or out-of-order snapshot cannot undo a receipt or completed reply', () => {
    const newer = agentChatFixtures.idleAfterCompletion
    expect(acceptAgentChatState(newer, agentChatFixtures.active)).toBe(newer)
    expect(acceptAgentChatState(newer, agentChatFixtures.empty)).toBe(newer)
    const partial: AgentChatState = { ...structuredClone(agentChatFixtures.active), revision: newer.revision }
    expect(acceptAgentChatState(newer, partial).messages[1]?.nativeMessageComplete).toBe(true)
  })
  it('overlapping history pages and replayed messages appear exactly once', () => {
    const messages = agentChatFixtures.idleAfterCompletion.messages
    expect(mergeChatMessages(messages, messages, messages)).toEqual(messages)
    expect(mergeChatMessages(messages, agentChatFixtures.active.messages).find((message) => message.role === 'assistant')?.content)
      .toBe('It is a workflow engine.')
  })
  it('orders turn sequences as decimal integers, not lexically or floating point', () => {
    const state: AgentChatState = structuredClone(agentChatFixtures.activeWithQueue)
    state.turns[0]!.sequence = '9007199254740993'
    state.turns[1]!.sequence = '9007199254740992'
    state.turns[2]!.sequence = '9'
    expect(acceptAgentChatState(undefined, state).turns.map((turn) => turn.requestId)).toEqual(['request-3', 'request-2', 'request-1'])
  })
  it('gates first send, continuation, steering and queueing from capabilities', () => {
    expect(intentUnavailable(agentChatFixtures.empty, 'next_turn')).toBeUndefined()
    expect(intentUnavailable(agentChatFixtures.idleAfterCompletion, 'next_turn')).toBeUndefined()
    expect(intentUnavailable(agentChatFixtures.runActive, 'next_turn')).toBe(agentChatFixtures.runActive.availability.message)
    expect(intentUnavailable(agentChatFixtures.sessionMissing, 'next_turn')).toBe(agentChatFixtures.sessionMissing.availability.message)
    expect(intentUnavailable(agentChatFixtures.steerUnavailable, 'steer')).toBe(agentChatFixtures.steerUnavailable.capabilities.unavailable.steer)
    const state: AgentChatState = structuredClone(agentChatFixtures.active)
    delete state.activeTurn!.nativeTurnId
    expect(intentUnavailable(state, 'steer')).toMatch(/native turn identity/)
    state.capabilities = { ...codexChatCapabilities, steer: 'cooperative_next_step', providerVersion: 'mock' }
    expect(intentUnavailable(state, 'steer')).toBeUndefined()
    state.capabilities = { ...state.capabilities, queueNextTurn: false, unavailable: { queueNextTurn: 'Queue is full.' } }
    expect(intentUnavailable(state, 'next_turn')).toBe('Queue is full.')
  })
  it('requires the authorized native request/session/turn identities for approval replies', () => {
    const state = approvalState(); expect(approvalReplyAvailable(state)).toBe(true)
    state.pendingInteraction!.turn.nativeTurnId = 'wrong-turn'; expect(approvalReplyAvailable(state)).toBe(false)
    state.pendingInteraction!.turn.nativeTurnId = 'turn-1'
    delete state.pendingInteraction!.turn.nativeRequestId; expect(approvalReplyAvailable(state)).toBe(false)
  })
})

describe('equal-revision canonical readback', () => {
  it('cannot erase active A, queued B or elevate capabilities from a cached receipt at the same revision', () => {
    const current = agentChatFixtures.activeWithQueue
    const cached = { ...agentChatFixtures.idleAfterCompletion, revision: current.revision,
      capabilities: { ...current.capabilities, queueNextTurn: true } }
    expect(acceptAgentChatState(current, cached)).toBe(current)
  })
  it('cannot replace a completed message with a legacy partial field omitted', () => {
    const complete = agentChatFixtures.idleAfterCompletion.messages[1]!
    const partial = { ...complete, nativeMessageComplete: undefined, content: 'partial' }
    expect(mergeChatMessages([complete], [partial])).toEqual([complete])
    const previous = agentChatFixtures.idleAfterCompletion
    const incoming = { ...previous, revision: previous.revision + 1, messages: [partial] }
    expect(acceptAgentChatState(previous, incoming).messages).toEqual([complete])
  })
})


describe('independently qualified read facts', () => {
  it('refreshes same-revision Run availability from authorized reads while retaining lifecycle and ignoring receipt replay', () => {
    const current = agentChatFixtures.activeWithQueue
    const read = { ...agentChatFixtures.runActive, context: current.context, conversation: current.conversation, revision: current.revision }
    const merged = acceptAgentChatState(current, read, 'read')
    expect(merged.availability).toEqual(read.availability)
    expect(merged.activeTurn).toEqual(current.activeTurn)
    expect(merged.turns).toEqual(current.turns)
    expect(acceptAgentChatState(merged, current, 'receipt')).toBe(merged)
  })
})

it('real message reconciliation compares durable entity revisions and preserves canonical empty finals', () => {
  const base = agentChatFixtures.idleAfterCompletion.messages[1]!
  const final = { ...base, revision: '9007199254740993', content: '', nativeMessageComplete: true }
  const stale = { ...base, revision: '9007199254740992', content: 'older', nativeMessageComplete: true }
  expect(mergeChatMessages([final], [stale])).toEqual([final])
  expect(mergeChatMessages([final], [{ ...final, content: 'conflicting equal revision' }])).toEqual([final])
})
it('an old qualified receipt/SSE cannot elevate capability while fresh authorized read can update qualification', () => {
  const previous = { ...agentChatFixtures.activeWithQueue, qualificationKey: 'a'.repeat(64), availability: { ...agentChatFixtures.activeWithQueue.availability, canSend: false } }
  const incoming = { ...previous, qualificationKey: 'b'.repeat(64), availability: { ...previous.availability, canSend: true } }
  expect(acceptAgentChatState(previous, incoming, 'receipt').availability.canSend).toBe(false)
  const read = acceptAgentChatState(previous, incoming, 'read')
  expect(read.availability.canSend).toBe(true); expect(read.qualificationKey).toBe(incoming.qualificationKey)
  expect(read.activeTurn).toEqual(previous.activeTurn); expect(read.turns).toEqual(previous.turns)
})
it('actual state acceptance uses decimal scoped revisions beyond numeric legacy precision', () => {
  const previous = structuredClone(agentChatFixtures.activeWithQueue)
  const scope = { kind: 'agent_chat' as const, conversationId: previous.conversation.id, workspaceId: previous.context.workspaceId,
    workflowId: previous.context.workflowId, nodeId: previous.context.workflowNodeId, agentId: previous.context.agentId }
  previous.activitySnapshot = { schemaVersion: 1, scope, revision: '9007199254740993', active: [], queued: [], latest: null,
    pendingInteractions: [], activities: [], page: { before: null, nextCursor: null, hasMore: false } }
  const old = { ...previous, activeTurn: null, activitySnapshot: { ...previous.activitySnapshot, revision: '9007199254740992' } }
  expect(acceptAgentChatState(previous, old).activeTurn).toEqual(previous.activeTurn)
})

it('accepts independent canonical message advances from equal-scope authorized readback and receipt replay', () => {
  const previous: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion), base = previous.messages[1]!
  previous.messages = [{ ...base, revision: '1', content: 'long provisional', nativeMessageComplete: false }]
  const scope = { kind: 'agent_chat' as const, conversationId: previous.conversation!.id, workspaceId: previous.context.workspaceId,
    workflowId: previous.context.workflowId, nodeId: previous.context.workflowNodeId, agentId: previous.context.agentId }
  previous.activitySnapshot = { schemaVersion: 1, scope, revision: String(previous.revision), sourceRevisions: [{ source: 'message', id: base.id, revision: '1' }],
    active: [], queued: [], latest: null, pendingInteractions: [], activities: [], page: { before: null, nextCursor: null, hasMore: false } }
  const incoming = { ...previous, messages: [{ ...previous.messages[0]!, revision: '2', content: '', nativeMessageComplete: true }],
    activitySnapshot: { ...previous.activitySnapshot, sourceRevisions: [{ source: 'message' as const, id: base.id, revision: '2' }] } }
  for (const source of ['read', 'receipt'] as const) {
    const accepted = acceptAgentChatState(previous, incoming, source)
    expect(accepted.messages[0]).toMatchObject({ revision: '2', content: '', nativeMessageComplete: true })
    expect(accepted.activitySnapshot?.sourceRevisions).toEqual(incoming.activitySnapshot.sourceRevisions)
  }
})

it('keeps native-item identity when the Board adapter merges a canonical empty final and a distinct child at part zero', () => {
  const native = { harness: 'codex', sessionId: 'session', turnId: 'turn', itemId: 'item', partId: '0' }
  const partial: Message = { id: 'message', conversationId: 'chat', requestId: 'request', role: 'assistant',
    content: 'Provisional', revision: '1', activityNative: native, nativeMessageId: 'item', nativeMessageComplete: false }
  const final = { ...partial, revision: '2', content: '', nativeMessageComplete: true }
  const child = { ...partial, id: 'child', nativeMessageId: 'child', activityNative: { ...native, itemId: 'child' },
    content: 'Child answer' }
  expect(mergeChatMessages([partial], [final, child], [partial])).toEqual([final, child])
  expect(mergeChatMessages([final], [{ ...child, id: final.id, revision: '3' }])).toEqual([final])
})
