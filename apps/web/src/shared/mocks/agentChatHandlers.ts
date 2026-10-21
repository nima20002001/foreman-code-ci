import { http, HttpResponse } from 'msw'
import {
  AgentChatContextSchema, AgentChatExecutionActivityPageSchema, AgentChatQuerySchema, AgentChatStateSchema, CancelQueuedAgentChatTurnRequestSchema,
  EnsureAgentChatConversationRequestSchema, InterruptAgentChatRequestSchema, RespondAgentChatInteractionRequestSchema, SendAgentChatMessageRequestSchema,
  SendAgentChatMessageResponseSchema, agentChatFixtures, type AgentChatContext, type AgentChatState,
  type AgentChatExecutionActivityPage, type AgentChatTurn,
} from '@foreman-code/contracts/agent-chat'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { agentChatContextKey } from '../../features/conversations/agentChat/model'

const at = '2026-09-27T12:00:00.000Z'
const root = '/api/workspaces/:workspaceId/agent-chat'
export const agentChatTestActions: ManagementAction[] = ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond']
const failure = (code: string, message: string, status = 409) => HttpResponse.json({ error: { code, message } }, { status })

/** Derive a distinct selection from the frozen fixtures, without making native runtime claims. */
export function agentChatFixtureFor(state: AgentChatState, context: AgentChatContext, conversationId = state.conversation?.id): AgentChatState {
  const result = structuredClone(state)
  result.context = { ...context }
  if (result.conversation) {
    const { runId, ...identity } = context
    result.conversation = { ...result.conversation, ...identity, id: conversationId!, origin: runId
      ? { kind: 'run_execution', runId, executionId: `execution-${runId}`, sourceNativeSessionId: `source-${runId}` } : { kind: 'fresh' } }
    result.messages = result.messages.map((message) => ({ ...message, conversationId: result.conversation!.id }))
  }
  return AgentChatStateSchema.parse(result)
}

/** Deterministic HTTP fixtures. This is a test server, never a native-session simulator. */
export function createAgentChatMock(initial: AgentChatState = agentChatFixtures.empty, actions: ManagementAction[] = agentChatTestActions) {
  const states = new Map<string, AgentChatState>(), activity = new Map<string, AgentChatExecutionActivityPage>(), receipts = new Map<string, { input: string; conversationId: string }>()
  const calls: { method: string; path: string; body?: unknown }[] = []
  let serial = 0
  const setState = (state: AgentChatState) => { states.set(agentChatContextKey(state.context), AgentChatStateSchema.parse(structuredClone(state))) }
  /** Explicit live activity for a context; otherwise derived from its sourceTranscript. */
  const setExecutionActivity = (context: AgentChatContext, page: AgentChatExecutionActivityPage) => {
    activity.set(agentChatContextKey(context), AgentChatExecutionActivityPageSchema.parse(structuredClone(page)))
  }
  const executionActivity = (context: AgentChatContext): AgentChatExecutionActivityPage => {
    const explicit = activity.get(agentChatContextKey(context))
    if (explicit) return explicit
    const source = getState(context).sourceTranscript
    if (!source) return { mode: 'snapshot', executions: [], hasEarlierExecutions: false, items: [], cursor: '{}', hasMoreChanges: false }
    return { mode: 'snapshot', hasEarlierExecutions: false, cursor: JSON.stringify({ [source.executionId]: source.revision }), hasMoreChanges: false,
      executions: [{ executionId: source.executionId, label: 'Execution', attempt: 1, state: source.state, createdAt: at, revision: source.revision }],
      items: source.messages.map((message) => ({ executionId: source.executionId, id: message.id, sequence: message.sequence ?? '1',
        revision: message.revision ?? source.revision, entry: { kind: 'message' as const, message } })) }
  }
  const reset = () => { activity.clear(); states.clear(); receipts.clear(); calls.length = 0; serial = 0; setState(initial) }
  reset()
  const getState = (context: AgentChatContext) => states.get(agentChatContextKey(context)) ?? agentChatFixtureFor(agentChatFixtures.empty, context)
  const find = (workspaceId: string, id: string) => [...states.values()].find((state) => state.context.workspaceId === workspaceId && state.conversation?.id === id)
  const record = (request: Request, body?: unknown) => calls.push({ method: request.method, path: new URL(request.url).pathname, body })
  const commandState = (state: AgentChatState) => { setState(state); return HttpResponse.json({ state: getState(state.context) }) }
  const handlers = [
    http.get('/api/local-human', () => HttpResponse.json({ principal: { id: 'chat-test-principal', name: 'Chat tester',
      expiresAt: '2099-01-01T00:00:00.000Z', grants: actions.length ? [{ actions, scope: {} }] : [] } })),
    http.get(root, ({ request, params }) => {
      record(request)
      const query = AgentChatQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams))
      return HttpResponse.json(getState(AgentChatContextSchema.parse({ workspaceId: params.workspaceId, ...query })))
    }),
    http.get(`${root}/execution-activity`, ({ request, params }) => {
      record(request)
      const search = new URL(request.url).searchParams
      const page = executionActivity(AgentChatContextSchema.parse({ workspaceId: params.workspaceId, workflowId: search.get('workflowId'),
        workflowNodeId: search.get('workflowNodeId'), agentId: search.get('agentId'), runId: search.get('runId') ?? undefined }))
      // A cursor read answers with changes, so it merges into what an earlier page already loaded.
      return HttpResponse.json(search.has('cursor') ? { ...page, mode: 'changes' } : page)
    }),
    http.post(`${root}/messages`, async ({ request, params }) => {
      const input = SendAgentChatMessageRequestSchema.parse(await request.json()); record(request, input)
      const context = AgentChatContextSchema.parse({ workspaceId: params.workspaceId, ...input.context })
      const key = `${agentChatContextKey(context)}:${input.requestId}`, previous = receipts.get(key)
      if (previous) {
        if (previous.input !== JSON.stringify(input)) return failure('AGENT_CHAT_REQUEST_CONFLICT', 'The requestId was used for different input.')
        const state = find(context.workspaceId, previous.conversationId)
        const turn = state?.turns.find((entry) => entry.requestId === input.requestId)
        if (!state || !turn) throw new Error('Replay receipt missing from the test fixture')
        return HttpResponse.json(SendAgentChatMessageResponseSchema.parse({ state, turn, replayed: true }))
      }
      const before = getState(context)
      if (input.expectedConversationId !== (before.conversation?.id ?? null)) return failure('AGENT_CHAT_CONTEXT_STALE', 'The conversation changed.')
      if (!before.availability.canSend) return failure('AGENT_CHAT_UNAVAILABLE', before.availability.message ?? 'Chat is unavailable.')
      if (input.intent === 'steer' && (!before.activeTurn || before.capabilities.steer === 'native_expected_turn' && input.expectedNativeTurnId !== before.activeTurn.nativeTurnId)) {
        return failure('AGENT_CHAT_TURN_NOT_ACTIVE', 'The targeted native turn finished.')
      }
      if (input.intent === 'steer' && before.capabilities.steer === 'unavailable') {
        return failure('AGENT_CHAT_STEER_UNAVAILABLE', before.capabilities.unavailable.steer ?? 'Steering is unavailable.')
      }
      if (input.intent === 'interrupt_and_send' && !before.conversation) return failure('AGENT_CHAT_TURN_NOT_ACTIVE', 'There is no active turn to interrupt.')
      const { runId, ...identity } = context
      // Admission is not native acceptance. Tests explicitly publish later state; no timer pretends
      // to start a harness. In particular a first Claude send must not acquire a Codex session.
      const conversation = before.conversation ?? { ...identity, id: `conversation-created-${++serial}`,
        agentConfigurationVersionId: `configuration-${context.agentId}`, harness: before.capabilities.harness,
        origin: runId ? { kind: 'run_execution' as const, runId, executionId: `execution-${runId}`, sourceNativeSessionId: `source-${runId}` } : { kind: 'fresh' as const },
        nativeSession: null, createdAt: at, updatedAt: at }
      const turn: AgentChatTurn = { requestId: input.requestId, messageId: `message-${input.requestId}`, intent: input.intent,
        sequence: String(before.turns.reduce((max, item) => Math.max(max, Number(item.sequence)), 0) + 1),
        delivery: input.intent === 'steer' ? 'accepted' : 'queued',
        ...(input.intent === 'steer' && before.activeTurn?.nativeTurnId ? { nativeTurnId: before.activeTurn.nativeTurnId } : {}),
        ...(input.expectedNativeTurnId ? { targetNativeTurnId: input.expectedNativeTurnId } : {}), createdAt: at, updatedAt: at }
      const state = AgentChatStateSchema.parse({ ...before, conversation, activeTurn: before.activeTurn,
        sessionState: input.intent === 'interrupt_and_send' && before.activeTurn ? 'interrupting' : before.conversation ? before.sessionState : 'idle',
        revision: before.revision + 1,
        turns: [...before.turns, turn], messages: [...before.messages, { id: turn.messageId, conversationId: conversation.id, requestId: turn.requestId,
          role: 'user', content: input.content, createdAt: at }] })
      setState(state)
      const response = SendAgentChatMessageResponseSchema.parse({ state, turn, replayed: false })
      receipts.set(key, { input: JSON.stringify(input), conversationId: conversation.id })
      return HttpResponse.json(response)
    }),
    http.post(`${root}/conversation`, async ({ request, params }) => {
      const input = EnsureAgentChatConversationRequestSchema.parse(await request.json()); record(request, input)
      const context = AgentChatContextSchema.parse({ workspaceId: params.workspaceId, ...input.context })
      const before = getState(context)
      if (before.conversation) return HttpResponse.json({ state: before })
      const { runId, ...identity } = context
      const state = AgentChatStateSchema.parse({ ...before, sessionState: 'idle', revision: before.revision + 1,
        conversation: { ...identity, id: `conversation-created-${++serial}`, agentConfigurationVersionId: `configuration-${context.agentId}`,
          harness: before.capabilities.harness,
          origin: runId ? { kind: 'run_execution' as const, runId, executionId: `execution-${runId}`, sourceNativeSessionId: `source-${runId}` } : { kind: 'fresh' as const },
          nativeSession: null, createdAt: at, updatedAt: at } })
      return commandState(state)
    }),
    http.post(`${root}/conversations/:id/interrupt`, async ({ request, params }) => {
      const input = InterruptAgentChatRequestSchema.parse(await request.json()); record(request, input)
      const state = find(String(params.workspaceId), String(params.id))
      if (!state) return failure('NOT_FOUND', 'Conversation not found.', 404)
      if (input.expectedNativeTurnId && state.activeTurn?.nativeTurnId && input.expectedNativeTurnId !== state.activeTurn.nativeTurnId) {
        return failure('AGENT_CHAT_TURN_NOT_ACTIVE', 'That turn already finished.')
      }
      const next = { ...state, revision: state.revision + 1, sessionState: 'idle' as const, activeTurn: null,
        turns: state.turns.map((turn) => ['queued', 'accepted', 'submitting'].includes(turn.delivery) ? { ...turn, delivery: 'canceled' as const } : turn) }
      delete next.pendingInteraction
      return commandState(next)
    }),
    http.post(`${root}/conversations/:id/turns/:turnRequestId/cancel`, async ({ request, params }) => {
      const input = CancelQueuedAgentChatTurnRequestSchema.parse(await request.json()); record(request, input)
      const state = find(String(params.workspaceId), String(params.id))
      if (!state) return failure('NOT_FOUND', 'Conversation not found.', 404)
      const turn = state.turns.find((turn) => turn.requestId === params.turnRequestId)
      if (!turn) return failure('AGENT_CHAT_TURN_NOT_FOUND', 'That message was not found.', 404)
      if (!['queued', 'canceled'].includes(turn.delivery)) return failure('AGENT_CHAT_TURN_STARTED', 'That message was already sent to the Agent.')
      return commandState({ ...state, revision: state.revision + 1, turns: state.turns.map((turn) => turn.requestId === params.turnRequestId ? { ...turn, delivery: 'canceled' } : turn) })
    }),
    http.post(`${root}/conversations/:id/responses`, async ({ request, params }) => {
      const input = RespondAgentChatInteractionRequestSchema.parse(await request.json()); record(request, input)
      const state = find(String(params.workspaceId), String(params.id))
      if (!state) return failure('NOT_FOUND', 'Conversation not found.', 404)
      if (!actions.includes('agent_chat:respond')) return failure('FORBIDDEN', 'Approval access denied.', 403)
      if (!state.activeTurn || !state.conversation?.nativeSession || state.pendingInteraction?.turn.nativeRequestId !== input.nativeRequestId) {
        return failure('AGENT_CHAT_INTERACTION_NOT_PENDING', 'This approval is no longer pending.')
      }
      if (!state.pendingInteraction.responseOptions.some((option) => option.optionId === input.optionId)) {
        return failure('AGENT_CHAT_INTERACTION_OPTION_INVALID', 'That option was not offered.', 422)
      }
      const next = { ...state, revision: state.revision + 1, sessionState: 'active' as const }
      delete next.pendingInteraction
      return commandState(next)
    }),
    http.get(`${root}/conversations/:id/history`, ({ request, params }) => {
      record(request)
      if (!find(String(params.workspaceId), String(params.id))) return failure('NOT_FOUND', 'Conversation not found.', 404)
      return HttpResponse.json({ conversationId: params.id, messages: [], nextCursor: null })
    }),
    http.get(`${root}/conversations/:id/events`, ({ request, params }) => {
      record(request)
      const state = find(String(params.workspaceId), String(params.id))
      if (!state) return failure('NOT_FOUND', 'Conversation not found.', 404)
      const event = { id: 0, conversationId: params.id, type: 'snapshot', data: state }
      return new HttpResponse(`event: snapshot\nid: 0\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    }),
  ]
  return { handlers, calls, getState, setState, setExecutionActivity, reset }
}

const defaultMock = createAgentChatMock()
/** Authentication remains owned by the existing global mock; individual chat tests opt into grants. */
export const agentChatHandlers = defaultMock.handlers.slice(1)
export const resetAgentChatFixtures = defaultMock.reset
