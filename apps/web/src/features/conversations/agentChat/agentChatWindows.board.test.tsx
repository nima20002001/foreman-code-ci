// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { LocalHumanAccessSchema } from '@foreman-code/contracts/management'
import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { agentChatFixtureFor, agentChatTestActions, createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { installBoardTestLifecycle, mountMeasuredBoard } from '../../workflow-board/eng05D.testSupport'
import { inspectionBoardFixture } from '../../workflow-board/inspect/inspectionFixtures'
import { useConversationDraftStore } from '../conversationDraftStore'
import { providerFixture } from './f7.testSupport'
import { installChatSource } from './testSupport'
import { findLoadedComposer } from '../loadedComposer.test-support'
import { outsideRunTargetHandler } from './outsideRunTarget.testSupport'
import { useChatWindowsStore } from './agentChatWindows'

installBoardTestLifecycle()
afterEach(() => {
  useConversationDraftStore.getState().clearAllDrafts()
  useChatWindowsStore.setState({ open: {}, frames: {}, focus: {} })
})

/** The mounted Board route keeps one selected chat body and each Agent's local draft. */
async function mountDraftBoard(suffix: string) {
  installChatSource()
  const fixture = await inspectionBoardFixture(suffix), saved = fixture.runs.before.scope
  const [first, second] = fixture.after.definition.nodes.map((node) => node as { id: string; name?: string; agentId: string })
  const contexts = [first!, second!].map((node): AgentChatContext => ({ workspaceId: saved.workspaceId,
    workflowId: saved.workflowId, workflowNodeId: node.id, agentId: node.agentId }))
  const chat = createAgentChatMock(agentChatFixtureFor(providerFixture('codex'), contexts[0]!))
  chat.setState(agentChatFixtureFor(providerFixture('codex'), contexts[1]!))
  server.use(...chat.handlers.slice(1), ...fixture.mock.handlers)
  server.use(outsideRunTargetHandler(saved, contexts, fixture.after.id))
  server.use(http.get('/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
    id: 'chat-windows-tester', name: 'Chat window tester', expiresAt: '2099-01-01T00:00:00.000Z', grants: [{
      scope: { workspaceIds: [saved.workspaceId] },
      actions: ['workspaces:read', 'workflows:read', 'agents:read', 'graph:read', 'interactions:read', 'runs:read', ...agentChatTestActions],
    }],
  } }))))
  const mounted = await mountMeasuredBoard(`/workspaces/${saved.workspaceId}?workflowId=${saved.workflowId}`)
  const names = { first: first!.name!, second: second!.name! }
  // fireEvent: user-event's mousedown has no window view, which React Flow's node drag handler requires.
  const node = (name: string) => screen.findByRole('button', { name: new RegExp(`^${name},`) })
  // The node's chat action is the only way a chat opens; selecting the node does not.
  const chatAction = (name: string) => screen.findByRole('button', { name: `Open ${name} chat` })
  const panelNamed = async (name: string) => {
    const panel = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    await within(panel).findByRole('heading', { name })
    return panel
  }
  return { names, node, chatAction, panelNamed, chat, contexts, mounted, fixture }
}
describe('Agent chats in the shared Board rail', () => {
  it.each(['rail', 'board'] as const)('loads the composer without stealing focus from the %s', async (focusTarget) => {
    const { names, node, chatAction, panelNamed, chat, contexts } = await mountDraftBoard(`chat-loading-${focusTarget}`)
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    server.use(http.get('/api/workspaces/:workspaceId/agent-chat', async () => {
      await pending
      return HttpResponse.json(chat.getState(contexts[0]!))
    }))
    const selectedNode = await node(names.first)
    fireEvent.click(await chatAction(names.first))
    const panel = await panelNamed(names.first)
    await waitFor(() => expect(panel).toHaveFocus())
    if (focusTarget === 'board') await act(async () => selectedNode.focus())
    await act(async () => release())
    const input = await findLoadedComposer(within(panel))
    expect(input).toBeEnabled()
    await waitFor(() => expect(focusTarget === 'rail' ? input : selectedNode).toHaveFocus())
  }, 30_000)

  it('switches the selected Agent while retaining both drafts and mounting only one transcript', async () => {
    const { names, chatAction, panelNamed, mounted, contexts } = await mountDraftBoard('chat-selection')
    await userEvent.click(await chatAction(names.first))
    const panel = await panelNamed(names.first)
    const firstInput = await findLoadedComposer(within(panel))
    fireEvent.change(firstInput, { target: { value: 'First unsent message' } })
    await userEvent.click(await chatAction(names.second))
    expect(await panelNamed(names.second)).toBe(panel)
    const secondInput = await findLoadedComposer(within(panel))
    expect(secondInput).not.toBe(firstInput)
    expect(secondInput).toHaveValue('')
    fireEvent.change(secondInput, { target: { value: 'Second unsent message' } })
    expect(screen.getAllByTestId('agent-conversation')).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: /chat$/ })).not.toBeInTheDocument()
    await userEvent.click(await chatAction(names.first))
    expect(await findLoadedComposer(within(await panelNamed(names.first))))
      .toHaveValue('First unsent message')
    expect(mounted.router.state.location.search).toMatchObject({ boardPanel: 'agent',
      boardAgentTab: 'chat', boardNodeId: contexts[0]!.workflowNodeId })
    await userEvent.click(await chatAction(names.second))
    expect(await findLoadedComposer(within(await panelNamed(names.second))))
      .toHaveValue('Second unsent message')
    expect(screen.getAllByTestId('agent-conversation')).toHaveLength(1)
  }, 30_000)

  it('stays open on Board clicks and closes through Back to Board without losing other drafts', async () => {
    const { names, chatAction, panelNamed } = await mountDraftBoard('chat-close')
    await userEvent.click(await chatAction(names.first))
    const panel = await panelNamed(names.first)
    fireEvent.change(await findLoadedComposer(within(panel)), { target: { value: 'Keep first' } })
    await userEvent.click(await chatAction(names.second))
    await panelNamed(names.second)
    fireEvent.click(document.querySelector<HTMLElement>('.react-flow__pane')!)
    fireEvent.mouseDown(document.body)
    expect(panel).toBeVisible()
    expect(screen.getAllByTestId('agent-conversation')).toHaveLength(1)
    await userEvent.click(within(panel).getByRole('button', { name: 'Back to Board' }))
    await waitFor(() => expect(panel).not.toBeVisible())
    expect(screen.queryByTestId('agent-conversation')).not.toBeInTheDocument()
    await userEvent.click(await chatAction(names.first))
    expect(await findLoadedComposer(within(await panelNamed(names.first)))).toHaveValue('Keep first')
  }, 30_000)

  it('retains the resized rail width across Agent changes and closing and reopening', async () => {
    const { names, chatAction, panelNamed } = await mountDraftBoard('chat-width')
    await userEvent.click(await chatAction(names.first))
    const panel = await panelNamed(names.first)
    fireEvent.change(within(panel).getByRole('slider', { name: 'Panel width' }), { target: { value: '510' } })
    expect(panel.style.getPropertyValue('--workflow-rail-width')).toBe('510px')
    expect(within(panel).getByRole('slider', { name: 'Panel width' })).toHaveAttribute('aria-valuetext', '510 px')
    await userEvent.click(await chatAction(names.second))
    await panelNamed(names.second)
    expect(panel.style.getPropertyValue('--workflow-rail-width')).toBe('510px')
    await userEvent.click(within(panel).getByRole('button', { name: 'Back to Board' }))
    await waitFor(() => expect(panel).not.toBeVisible())
    await userEvent.click(await chatAction(names.first))
    expect(await panelNamed(names.first)).toBe(panel)
    expect(panel.style.getPropertyValue('--workflow-rail-width')).toBe('510px')
  }, 30_000)

  it('closes the selected chat with Escape and restores its opener', async () => {
    const { names, chatAction, panelNamed } = await mountDraftBoard('chat-escape')
    const trigger = await chatAction(names.first)
    await userEvent.click(trigger)
    const panel = await panelNamed(names.first)
    const input = await findLoadedComposer(within(panel))
    fireEvent.change(input, { target: { value: 'Keep after Escape' } })
    await act(async () => input.focus())
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(panel).not.toBeVisible())
    await waitFor(() => expect(trigger).toHaveFocus())
    await userEvent.click(trigger)
    expect(await findLoadedComposer(within(await panelNamed(names.first)))).toHaveValue('Keep after Escape')
  }, 30_000)

  it('keeps keyboard focus and selection on the only mounted composer', async () => {
    const { names, chatAction, panelNamed, contexts, mounted } = await mountDraftBoard('chat-keyboard')
    await userEvent.click(await chatAction(names.first))
    const panel = await panelNamed(names.first)
    const firstInput = await findLoadedComposer(within(panel))
    await userEvent.click(await chatAction(names.second))
    const secondInput = await findLoadedComposer(within(await panelNamed(names.second)))
    expect(firstInput).not.toBeInTheDocument()
    await act(async () => secondInput.focus())
    expect(secondInput).toHaveFocus()
    expect(mounted.router.state.location.search.boardNodeId).toBe(contexts[1]!.workflowNodeId)
    expect(screen.getAllByRole('textbox', { name: 'Message' })).toEqual([secondInput])
    expect(screen.queryByRole('dialog', { name: /chat$/ })).not.toBeInTheDocument()
  }, 30_000)

  it('does not open a chat when an Agent node is selected or clicked', async () => {
    const { names, node } = await mountDraftBoard('chat-select-only')
    const first = await node(names.first)
    fireEvent.click(first)
    await waitFor(() => expect(first).toHaveAttribute('aria-pressed', 'true'))
    fireEvent.click(await node(names.second))
    fireEvent.click(document.querySelector<HTMLElement>('.react-flow__pane')!)
    expect(screen.queryByRole('complementary', { name: 'Workflow side panel' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('agent-conversation')).not.toBeInTheDocument()
  }, 30_000)

  it('opens a linked rail selection without moving the authored graph or adding floating frames', async () => {
    const { names, contexts, mounted, fixture, panelNamed } = await mountDraftBoard('chat-linked')
    const before = structuredClone(fixture.mock.drafts)
    const context = contexts[0]!
    await act(async () => { await mounted.router.navigate({ to: '/workspaces/$workspaceId',
      params: { workspaceId: context.workspaceId }, search: { workflowId: context.workflowId,
        boardPanel: 'agent', boardNodeId: context.workflowNodeId, boardAgentTab: 'chat' } }) })
    const panel = await panelNamed(names.first)
    expect(await findLoadedComposer(within(panel))).toBeEnabled()
    expect(screen.getAllByRole('complementary', { name: 'Workflow side panel' })).toEqual([panel])
    expect(screen.queryByRole('dialog', { name: /chat$/ })).not.toBeInTheDocument()
    expect(fixture.mock.drafts).toEqual(before)
    expect(fixture.mock.calls.filter(call => call.method !== 'GET')).toEqual([])
  }, 30_000)
})
