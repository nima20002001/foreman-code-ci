import { useRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentChatFixtures, codexChatCapabilities, claudeChatCapabilities, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { AgentPopover } from '../../../shared/ui/nocturne'
import { AgentChatPanel } from '../../graph/AgentPanels'
import { useConversationDraftStore } from '../conversationDraftStore'
import { AgentChatTestSource, installChatSource } from './testSupport'
import { agentChatStateKey } from './useAgentChat'

const clients: QueryClient[] = []
type Harness = 'codex' | 'claude'
type Readback = 'GET' | 'SSE'

function toolState(harness: Harness, completed = false, boundaries = true): AgentChatState {
  const state: AgentChatState = structuredClone(agentChatFixtures.active)
  const template = state.turns[0]!
  state.conversation!.harness = harness
  state.capabilities = structuredClone(harness === 'codex' ? codexChatCapabilities : claudeChatCapabilities)
  state.conversation!.nativeSession!.providerVersion = state.capabilities.providerVersion!
  state.messages = []; state.turns = []; state.activities = []
  state.sessionState = completed ? 'idle' : 'active'
  state.activeTurn = completed ? null : { ...state.activeTurn!, requestId: 'g6-request-3' }
  state.revision = completed ? 101 : 100
  for (let turn = 1; turn <= 3; turn++) {
    const requestId = `g6-request-${turn}`, messageId = `g6-user-${turn}`
    const terminal = turn < 3 || completed
    state.turns.push({ ...template, requestId, messageId, sequence: String(turn), delivery: terminal ? 'completed' : 'accepted' })
    state.messages.push({ id: messageId, conversationId: state.conversation!.id, requestId, role: 'user', content: `G6 prompt ${turn}` })
    if (terminal) state.messages.push({ id: `g6-reply-${turn}`, conversationId: state.conversation!.id, requestId,
      role: 'assistant', content: `G6 reply ${turn}`, nativeMessageComplete: true,
      ...(boundaries ? { afterActivitySequence: String(turn * 24) } : {}) })
    for (let tool = 1; tool <= 24; tool++) state.activities.push({
      // Deliberately repeat provider-local ids across requests: row identity must include requestId.
      id: `g6-tool-${tool}`, requestId, sequence: String((turn - 1) * 24 + tool), revision: terminal ? 2 : 1,
      kind: 'tool', title: `G6 tool ${turn}/${tool}`, status: terminal ? 'completed' : 'running',
      input: `Inspect public input ${turn}/${tool}`, output: terminal ? `Public result ${turn}/${tool}` : undefined,
    })
  }
  return state
}

function ChatPopover({ client, state }: { client: QueryClient; state: AgentChatState }) {
  const anchor = useRef<HTMLButtonElement>(null)
  return <QueryClientProvider client={client}><button ref={anchor}>Agent node</button>
    <AgentPopover open anchor={anchor} title="Coder" panel="chat" onClose={() => {}}
      settings={null} info={null} chat={<AgentChatPanel name="Coder" context={state.context} activity="Current activity" running />} />
  </QueryClientProvider>
}

async function mountPopover(initial: AgentChatState) {
  installChatSource()
  const mock = createAgentChatMock(initial)
  server.use(...mock.handlers)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<ChatPopover client={client} state={initial} />)
  await screen.findByText('G6 prompt 3')
  await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
  const source = AgentChatTestSource.instances[0]!
  act(() => { source.open(); source.snapshot(initial) })
  let eventId = 0
  return {
    async publish(next: AgentChatState, readback: Readback) {
      mock.setState(next)
      await act(async () => {
        if (readback === 'GET') await client.invalidateQueries({ queryKey: agentChatStateKey(initial.context) })
        else source.snapshot(next, ++eventId)
      })
      await waitFor(() => expect(client.getQueryData<AgentChatState>(agentChatStateKey(initial.context))?.revision).toBe(next.revision))
    },
    async replay(next: AgentChatState) {
      await act(async () => {
        source.snapshot(structuredClone(next), ++eventId)
        source.snapshot(structuredClone(next), eventId)
        source.snapshot(structuredClone(next), ++eventId)
      })
    },
  }
}

function disclosure(label: string) {
  const summary = screen.getByText(label).closest('summary')!
  const details = summary.closest('details')!
  return { summary, details }
}

function jumpButton() {
  const button = screen.getByText('Jump to latest').closest('button')!
  expect(button).toHaveAccessibleName('Jump to latest')
  expect(button).toBeVisible()
  return button
}

function openFromKeyboard(summary: HTMLElement) {
  // JSDOM does not implement the browser's summary/Enter default action. Dispatch
  // the keyboard-generated activation click (detail 0), with real DOM focus and
  // native <details> toggling. Physical keyboard/browser geometry remain a live check.
  act(() => { summary.focus(); fireEvent.click(summary, { detail: 0 }) })
}

function scrollMetrics(scroll: HTMLElement, height: number) {
  // Deliberately modeled metrics, not a claim about real phone/browser layout.
  const rows = () => [...scroll.querySelectorAll('article, details')]
  let top = 0
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, get: () => rows().length * 40 },
    clientHeight: { configurable: true, get: () => height },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, rows().length * 40 - height)) } },
  })
  return { rows, bottom: () => scroll.scrollHeight - scroll.clientHeight }
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  useConversationDraftStore.getState().clearAllDrafts()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('G6 B2-PF-03 stable activity disclosure identity', () => {
  for (const harness of ['codex', 'claude'] as const) {
    it.each(['GET', 'SSE'] as const)(`${harness}: first assistant reply via %s and replay preserve the open, focused disclosure and browsing position`, async (readback) => {
      const initial = toolState(harness, false, readback === 'GET')
      const mounted = await mountPopover(initial)
      const scroll = screen.getByRole('region', { name: 'Agent conversation transcript' })
      expect(scroll.closest('.n-agent-popover')).not.toBeNull()
      const metrics = scrollMetrics(scroll, 240)
      // Start at the bottom; opening a disclosure alone must stop following.
      scroll.scrollTop = metrics.bottom(); fireEvent.scroll(scroll)
      const { summary, details } = disclosure('Ran G6 tool 3/12')
      openFromKeyboard(summary)
      expect(details).toHaveAttribute('open')
      expect(summary).toHaveFocus()
      const top = scroll.scrollTop
      const completed = toolState(harness, true, readback === 'GET')
      await mounted.publish(completed, readback)
      await screen.findByText('G6 reply 3')
      const assertPreserved = () => {
        expect(disclosure('Ran G6 tool 3/12').summary).toBe(summary)
        expect(disclosure('Ran G6 tool 3/12').details).toBe(details)
        expect(summary.isConnected).toBe(true)
        expect(details).toHaveAttribute('open')
        expect(summary).toHaveFocus()
        expect(scroll.scrollTop).toBe(top)
        expect(screen.getAllByText('Ran G6 tool 3/12')).toHaveLength(1)
        expect(screen.getAllByText('G6 reply 3')).toHaveLength(1)
        expect(metrics.rows().at(-1)).toHaveTextContent('G6 reply 3')
      }
      assertPreserved()
      await mounted.replay(completed)
      assertPreserved()
      expect(jumpButton()).toBeInTheDocument()
      await userEvent.click(jumpButton())
      expect(scroll.scrollTop).toBe(metrics.bottom())
      expect(details).toHaveAttribute('open')
    })
  }

  it('preserves individual open tools when multiple reply boundaries split the activity list', async () => {
    const initial = toolState('codex'), mounted = await mountPopover(initial)
    const first = disclosure('Ran G6 tool 3/4'), last = disclosure('Ran G6 tool 3/20')
    openFromKeyboard(first.summary); openFromKeyboard(last.summary)
    expect(first.details).toHaveAttribute('open'); expect(last.details).toHaveAttribute('open')
    const partial = structuredClone(initial)
    partial.revision++
    partial.messages.push({ id: 'g6-intermediate', conversationId: partial.conversation!.id, requestId: 'g6-request-3',
      role: 'assistant', content: 'G6 intermediate reply', nativeMessageComplete: true, afterActivitySequence: '60' })
    await mounted.publish(partial, 'SSE')
    expect(disclosure('Ran G6 tool 3/4').details).toBe(first.details)
    expect(disclosure('Ran G6 tool 3/20').details).toBe(last.details)
    const final = toolState('codex', true)
    final.revision = partial.revision + 1
    final.messages.splice(final.messages.length - 1, 0, partial.messages.at(-1)!)
    await mounted.publish(final, 'SSE')
    expect(disclosure('Ran G6 tool 3/4').details).toBe(first.details)
    expect(disclosure('Ran G6 tool 3/20').details).toBe(last.details)
    expect(first.details).toHaveAttribute('open'); expect(last.details).toHaveAttribute('open')
    expect(last.summary).toHaveFocus()
    expect(first.summary.compareDocumentPosition(screen.getByText('G6 intermediate reply')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('G6 intermediate reply').compareDocumentPosition(last.summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(last.summary.compareDocumentPosition(screen.getByText('G6 reply 3')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('G6 B-R04 activity/reply ordering and bottom-following', () => {
  it.each([320, 1280])('follows the latest reply, pauses while browsing and resumes only on Jump at modeled width %s', async (width) => {
    vi.stubGlobal('innerWidth', width)
    const initial = toolState('codex'), mounted = await mountPopover(initial)
    const scroll = screen.getByRole('region', { name: 'Agent conversation transcript' })
    const metrics = scrollMetrics(scroll, width === 320 ? 160 : 240)
    scroll.scrollTop = metrics.bottom(); fireEvent.scroll(scroll)
    const complete = toolState('codex', true)
    await mounted.publish(complete, 'GET')
    const history = within(scroll).getByRole('list', { name: 'Conversation history' })
    expect(history.lastElementChild).toHaveTextContent('G6 reply 3')
    expect(scroll.scrollTop).toBe(metrics.bottom())
    expect(screen.queryByText('Jump to latest')).not.toBeInTheDocument()
    for (let turn = 1; turn <= 3; turn++) {
      const reply = within(scroll).getByText(`G6 reply ${turn}`)
      const tool = within(scroll).getByText(`Ran G6 tool ${turn}/24`)
      expect(tool.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    scroll.scrollTop = 120; fireEvent.scroll(scroll)
    const next = structuredClone(complete)
    next.revision++
    next.messages.push({ id: 'g6-later-reply', conversationId: next.conversation!.id, requestId: 'g6-request-4',
      role: 'assistant', content: 'G6 later reply', nativeMessageComplete: true, afterActivitySequence: '72' })
    await mounted.publish(next, 'SSE')
    expect(scroll.scrollTop).toBe(120)
    await mounted.replay(next)
    expect(scroll.scrollTop).toBe(120)
    await userEvent.click(jumpButton())
    expect(scroll.scrollTop).toBe(metrics.bottom())
    expect(metrics.rows().at(-1)).toHaveTextContent('G6 later reply')
    expect(history.lastElementChild).toHaveTextContent('G6 later reply')
    await mounted.replay(next)
    expect(screen.queryByText('Jump to latest')).not.toBeInTheDocument()
  })
})
