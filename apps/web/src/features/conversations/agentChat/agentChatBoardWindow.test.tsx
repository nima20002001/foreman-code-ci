// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { LocalHumanAccessSchema } from '@foreman-code/contracts/management'
import { agentChatFixtures, type AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { agentChatFixtureFor, agentChatTestActions, createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { installBoardTestLifecycle, mountMeasuredBoard } from '../../workflow-board/eng05D.testSupport'
import { inspectionBoardFixture } from '../../workflow-board/inspect/inspectionFixtures'
import { useConversationDraftStore } from '../conversationDraftStore'
import { providerFixture } from './f7.testSupport'
import { installChatSource } from './testSupport'
import { outsideRunTargetHandler } from './outsideRunTarget.testSupport'
import { useChatWindowsStore } from './agentChatWindows'

installBoardTestLifecycle()
afterEach(() => {
  useConversationDraftStore.getState().clearAllDrafts()
  useChatWindowsStore.setState({ open: {}, frames: {}, focus: {} })
})

/** Actual Board route/editor/canvas/chat rail with MSW. JSDOM has no layout engine: the viewport
 * dimensions below exercise placement branches and structure, NOT real pixel visibility. */
describe('mounted Board chat rail action area', () => {
  it.each([[1400, 812], [320, 568], [390, 844]])('keeps actions outside transcript scrolling at %ix%i', async (width, height) => {
    vi.stubGlobal('innerWidth', width); vi.stubGlobal('innerHeight', height); installChatSource()
    const viewport = Object.assign(new EventTarget(), { width, height, offsetTop: 0, offsetLeft: 0 })
    vi.stubGlobal('visualViewport', viewport)
    const fixture = await inspectionBoardFixture(`g7-${width}-${height}`), scope = fixture.runs.before.scope
    const context: AgentChatContext = { workspaceId: scope.workspaceId, workflowId: scope.workflowId,
      workflowNodeId: fixture.first.id, agentId: fixture.first.agentId }
    const state = agentChatFixtureFor(providerFixture('codex', agentChatFixtures.active), context)
    state.messages = state.messages.filter((message) => message.role !== 'assistant')
    const chat = createAgentChatMock(state)
    server.use(...chat.handlers.slice(1), ...fixture.mock.handlers)
    server.use(outsideRunTargetHandler(scope, [context], fixture.after.id))
    server.use(http.get('/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
      id: 'g7-board-chat-reader-writer', name: 'G7 tester', expiresAt: '2099-01-01T00:00:00.000Z', grants: [{
        scope: { workspaceIds: [scope.workspaceId] },
        actions: ['workspaces:read', 'workflows:read', 'agents:read', 'graph:read', 'interactions:read', 'runs:read', ...agentChatTestActions],
      }],
    } }))))
    const mounted = await mountMeasuredBoard(`/workspaces/${scope.workspaceId}?workflowId=${scope.workflowId}`)
    const trigger = await screen.findByRole('button', { name: `Open ${fixture.first.name!} chat` })
    await userEvent.click(trigger)
    const rail = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    expect(within(rail).getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true')
    expect(rail.closest('[role=dialog]')).toBeNull()
    expect(mounted.router.state.location.search).toMatchObject({ boardPanel: 'agent', boardAgentTab: 'chat', boardNodeId: fixture.first.id })
    const input = await within(rail).findByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(input).toHaveFocus())
    fireEvent.change(input, { target: { value: 'Control input at a narrow width' } })
    const transcript = within(rail).getByRole('region', { name: 'Agent conversation transcript' })
    const actions = within(rail).getByRole('group', { name: 'Chat actions' })
    expect(rail.querySelectorAll('.conversation-viewport-scroll')).toHaveLength(1)
    expect(transcript).not.toContainElement(actions)
    expect(actions.parentElement).toBe(transcript.closest('.conversation-viewport')!.parentElement)
    expect(within(transcript).getByRole('status', { name: `${fixture.first.name!} is working` })).toBeInTheDocument()
    // Plan mode is entered only by typing /plan, so the action area has no session options.
    expect(within(rail).queryByLabelText('Session options')).not.toBeInTheDocument()
    for (const name of ['Attach files', 'Queue message', 'Steer', 'Interrupt and send', 'Stop chat']) {
      expect(within(actions).getByRole('button', { name })).toBeEnabled()
    }
    for (let step = 0; step < 16 && document.activeElement !== within(actions).getByRole('button', { name: 'Stop chat' }); step++) {
      await userEvent.tab()
    }
    expect(within(actions).getByRole('button', { name: 'Stop chat' })).toHaveFocus()
    // Inspecting history or clicking the Board keeps the non-modal chat rail open.
    fireEvent.scroll(transcript, { target: { scrollTop: 10 } })
    fireEvent.click(document.querySelector<HTMLElement>('.react-flow__pane')!)
    fireEvent.mouseDown(document.body)
    expect(within(actions).getByRole('button', { name: 'Stop chat' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Workflow side panel' })).toBe(rail)
    await waitFor(() => expect(rail.style.maxHeight).toBe(`${Math.max(0, height - rail.getBoundingClientRect().top)}px`))
    // Synthetic visual viewport resize/pan, modelling keyboard appearance without claiming geometry.
    await act(async () => { viewport.height = 400; viewport.offsetTop = 31; viewport.dispatchEvent(new Event('resize')) })
    await waitFor(() => expect(rail.style.maxHeight).toBe(`${Math.max(0, 431 - Math.max(31, rail.getBoundingClientRect().top))}px`))
    expect(within(actions).getByRole('button', { name: 'Stop chat' })).toHaveFocus()
    await userEvent.click(within(actions).getByRole('button', { name: 'Stop chat' }))
    await waitFor(() => expect(chat.getState(context).activeTurn).toBeNull())
    expect(chat.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    expect(chat.calls.find((call) => call.method === 'POST')!.path).toMatch(/\/interrupt$/)
    expect(fixture.mock.calls.filter((call) => call.method !== 'GET')).toEqual([])
    expect(screen.getByRole('complementary', { name: 'Workflow side panel' })).toBe(rail)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Workflow side panel' })).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  }, 30_000)
})
