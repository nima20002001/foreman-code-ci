import { useRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { Message } from '@foreman-code/contracts'
import { agentChatFixtures, type AgentChatState, type AgentChatTurn, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { AgentPopover } from '../../../shared/ui/nocturne'
import { AgentChatPanel } from '../../graph/AgentPanels'
import { getConversationDraft, useConversationDraftStore } from '../conversationDraftStore'
import { agentChatContextKey } from './model'
import { agentChatStateKey } from './useAgentChat'
import { AgentChatTestSource, approvalState, installChatSource, mountChat } from './testSupport'

const root = '/api/workspaces/:workspaceId/agent-chat'
const messagePath = `${root}/messages`, historyPath = `${root}/conversations/:id/history`
const write = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value } })
const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
const receiptState = (input: SendAgentChatMessageRequest, delivery: AgentChatTurn['delivery']): AgentChatState => {
  const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  const turn: AgentChatTurn = { ...state.turns[0]!, requestId: input.requestId, messageId: `message-${input.requestId}`,
    sequence: '2', intent: input.intent, delivery }
  state.turns.push(turn)
  state.messages.push({ id: turn.messageId, requestId: turn.requestId, conversationId: state.conversation!.id, role: 'user', content: input.content })
  state.revision += 10
  if (delivery === 'accepted') {
    state.sessionState = 'active'
    state.activeTurn = { requestId: turn.requestId, nativeTurnId: 'accepted-turn', startedAt: turn.createdAt }
  } else if (delivery === 'queued') {
    state.sessionState = 'active'
    state.activeTurn = structuredClone(agentChatFixtures.active.activeTurn)
    state.turns[0]!.delivery = 'accepted'
  } else if (delivery === 'unknown') state.sessionState = 'uncertain'
  return state
}

afterEach(() => { useConversationDraftStore.getState().clearAllDrafts(); localStorage.clear(); vi.unstubAllGlobals() })
function toolHeavyState(turnCount: number, completed: boolean): AgentChatState {
  const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  state.messages = []; state.activities = []; state.turns = []; state.revision += turnCount * 2 + Number(completed)
  for (let turn = 1; turn <= turnCount; turn++) {
    const requestId = `request-heavy-${turn}`
    state.messages.push({ id: `user-heavy-${turn}`, conversationId: state.conversation!.id, requestId, role: 'user', content: `Heavy prompt ${turn}` })
    if (turn < turnCount || completed) state.messages.push({ id: `reply-heavy-${turn}`, conversationId: state.conversation!.id, requestId,
      role: 'assistant', nativeMessageComplete: true, content: `Completed reply ${turn}` })
    for (let tool = 1; tool <= 24; tool++) state.activities.push({ id: `activity-${turn}-${tool}`, requestId,
      sequence: String((turn - 1) * 24 + tool), revision: 1, kind: 'tool', title: `Public tool ${turn}/${tool}`, status: 'completed' })
  }
  state.sessionState = completed ? 'idle' : 'active'
  state.activeTurn = completed ? null : { requestId: `request-heavy-${turnCount}`, nativeTurnId: 'heavy-native-turn', startedAt: state.conversation!.createdAt }
  return state
}
function ChatPopover({ client, state }: { client: QueryClient; state: AgentChatState }) {
  const anchor = useRef<HTMLButtonElement>(null)
  return <QueryClientProvider client={client}><button ref={anchor}>Agent node</button>
    <AgentPopover open anchor={anchor} title="Coder" panel="chat" onClose={() => {}}
      settings={null} info={null} chat={<AgentChatPanel name="Coder" context={state.context} activity="Current activity" running />} />
  </QueryClientProvider>
}

describe('F6 B-R04 completed replies remain the following target', () => {
  it.each([320, 1280])('places tool-heavy turns before their replies in the real popover at width %s; follow/jump work without moving a browsing user', async (width) => {
    vi.stubGlobal('innerWidth', width)
    const initial = toolHeavyState(3, false), mock = createAgentChatMock(initial)
    server.use(...mock.handlers)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<ChatPopover client={client} state={initial} />)
    await screen.findByText('Heavy prompt 3')
    const scroll = screen.getByRole('region', { name: 'Agent conversation transcript' })
    expect(scroll.closest('.n-agent-popover')).not.toBeNull()
    // jsdom supplies no layout: these metrics exercise the real scroll handler, not browser geometry.
    const rows = () => [...scroll.querySelectorAll('.agent-chat-tool, .conversation-message-content')]
    const height = width === 320 ? 160 : 240
    let top = 0
    const sets: number[][] = []
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, get: () => rows().length * 40 },
      clientHeight: { configurable: true, value: height },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { sets.push([value, scroll.scrollHeight]); top = Math.max(0, Math.min(value, scroll.scrollHeight - height)) } },
    })
    const refresh = (state: AgentChatState) => {
      mock.setState(state)
      return client.invalidateQueries({ queryKey: agentChatStateKey(state.context) })
    }
    const assertLatestAtBottom = (text: string) => {
      const reply = within(scroll).getByText(text, { selector: '.conversation-message-content, .conversation-message-content p' })
        .closest('.conversation-message-content')!
      for (const tool of scroll.querySelectorAll('.agent-chat-tool')) {
        expect(tool.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      }
      expect(rows().at(-1)).toBe(reply)
      const replyTop = rows().indexOf(reply) * 40
      expect(replyTop).toBeGreaterThanOrEqual(top)
      expect(replyTop + 40).toBeLessThanOrEqual(top + height)
    }
    await act(() => refresh(toolHeavyState(3, true)))
    await within(scroll).findByText('Completed reply 3', { selector: '.conversation-message-content, .conversation-message-content p' })
    console.error('DBGF6', JSON.stringify({ sets, top, rows: rows().length, tools: scroll.querySelectorAll('.agent-chat-tool').length, jump: !!screen.queryByRole('button', { name: 'Jump to latest' }) }))
    assertLatestAtBottom('Completed reply 3')
    scroll.scrollTop = 0; fireEvent.scroll(scroll)
    await act(() => refresh(toolHeavyState(4, true)))
    expect(scroll.scrollTop).toBe(0)
    await userEvent.click(await screen.findByRole('button', { name: 'Jump to latest' }))
    await within(scroll).findByText('Completed reply 4', { selector: '.conversation-message-content, .conversation-message-content p' })
    assertLatestAtBottom('Completed reply 4')
  })
})
