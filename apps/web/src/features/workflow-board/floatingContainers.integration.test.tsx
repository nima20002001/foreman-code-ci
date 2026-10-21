// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { LocalHumanAccessSchema } from '@foreman-code/contracts/management'
import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { server } from '../../mocks/server'
import { agentChatFixtureFor, agentChatTestActions, createAgentChatMock } from '../../shared/mocks/agentChatHandlers'
import { useChatWindowsStore } from '../conversations/agentChat/agentChatWindows'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { providerFixture } from '../conversations/agentChat/f7.testSupport'
import { installChatSource } from '../conversations/agentChat/testSupport'
import { useApprovalInboxStore } from '../approvals'
import { installBoardTestLifecycle, mountMeasuredBoard } from './eng05D.testSupport'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'

installBoardTestLifecycle()
afterEach(() => {
  useConversationDraftStore.getState().clearAllDrafts()
  useChatWindowsStore.setState({ open: {}, frames: {}, focus: {} })
  useApprovalInboxStore.setState({ open: false, workspaceId: '', workflowId: undefined })
})

/** The mounted Board route with MSW and two Agent nodes whose chats can be opened. */
async function mountBoard(suffix: string) {
  installChatSource()
  const fixture = await inspectionBoardFixture(suffix), saved = fixture.runs.before.scope
  const [first, second] = fixture.after.definition.nodes.map((node) => node as { id: string; name?: string; agentId: string })
  const contexts = [first!, second!].map((node): AgentChatContext => ({ workspaceId: saved.workspaceId,
    workflowId: saved.workflowId, workflowNodeId: node.id, agentId: node.agentId }))
  const chat = createAgentChatMock(agentChatFixtureFor(providerFixture('codex'), contexts[0]!))
  chat.setState(agentChatFixtureFor(providerFixture('codex'), contexts[1]!))
  server.use(...chat.handlers.slice(1), ...fixture.mock.handlers)
  server.use(http.get('/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
    id: 'board-containers-tester', name: 'Board container tester', expiresAt: '2099-01-01T00:00:00.000Z', grants: [{
      scope: { workspaceIds: [saved.workspaceId] },
      actions: ['workspaces:read', 'workflows:read', 'agents:read', 'graph:read', 'interactions:read', 'runs:read', ...agentChatTestActions],
    }],
  } }))))
  await mountMeasuredBoard(`/workspaces/${saved.workspaceId}?workflowId=${saved.workflowId}`)
  return { names: { first: first!.name!, second: second!.name! } }
}
const rail = () => screen.getByRole('complementary', { name: 'Workflow side panel' })
const z = (element: Element) => Number((element as HTMLElement).style.zIndex)
const openChat = async (name: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Open ${name} chat` }))
  await screen.findByRole('complementary', { name: 'Workflow side panel' })
  return rail()
}
const addNodePanel = () => screen.getByRole('complementary', { name: 'Add node' })

describe('Board conversation components share one rail', () => {
  it('shows one Agent body and preserves unsent drafts when switching nodes and destinations', async () => {
    const user = userEvent.setup()
    const { names } = await mountBoard('containers-single-rail')
    await openChat(names.first)
    const firstDraft = await within(rail()).findByRole('textbox', { name: 'Message' })
    await user.type(firstDraft, 'Retain the first Agent draft')
    await openChat(names.second)
    expect(screen.getAllByRole('complementary', { name: 'Workflow side panel' })).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: / chat$/ })).not.toBeInTheDocument()
    const secondDraft = await within(rail()).findByRole('textbox', { name: 'Message' })
    expect(secondDraft).toHaveValue('')
    await user.type(secondDraft, 'Retain the second Agent draft')
    await user.click(within(rail()).getByRole('button', { name: /^Group chat$/ }))
    expect(await screen.findByText('Group chat is not available yet.')).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    await user.click(within(rail()).getByRole('button', { name: /^Agent$/ }))
    expect(await within(rail()).findByRole('textbox', { name: 'Message' })).toHaveValue('Retain the second Agent draft')
    await openChat(names.first)
    expect(await within(rail()).findByRole('textbox', { name: 'Message' })).toHaveValue('Retain the first Agent draft')
  }, 30_000)

  it('hides the Agent body beneath Memory board and restores the Board opener after closing', async () => {
    const user = userEvent.setup()
    const { names } = await mountBoard('containers-memory')
    const opener = await screen.findByRole('button', { name: `Open ${names.first} chat` })
    await user.click(opener)
    await user.type(await within(rail()).findByRole('textbox', { name: 'Message' }), 'Retain through modal')
    await user.click(screen.getByRole('button', { name: /^Memory board$/ }))
    expect(await screen.findByRole('dialog', { name: 'Memory board' })).toBeVisible()
    expect(screen.queryByRole('complementary', { name: 'Workflow side panel' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close Memory board' }))
    expect(await within(rail()).findByRole('textbox', { name: 'Message' })).toHaveValue('Retain through modal')
    await user.click(within(rail()).getByRole('button', { name: 'Back to Board' }))
    await waitFor(() => expect(opener).toHaveFocus())
  }, 30_000)
})

describe('the add-Agent panel on the Board', () => {
  it('preserves opening, pointer and focus stacking for the picker, approval inbox and Activities', async () => {
    const user = userEvent.setup()
    await mountBoard('containers-remaining-stack')
    await user.click(await screen.findByRole('button', { name: 'Add agent or job to graph' }))
    const panel = addNodePanel()
    await user.click(screen.getByRole('button', { name: /^Open human approval inbox/ }))
    const inbox = await screen.findByRole('dialog', { name: 'Human approval inbox' })
    const inboxRoot = inbox.closest<HTMLElement>('.approval-inbox-root')!
    expect(z(inboxRoot)).toBeGreaterThan(z(panel))
    fireEvent.pointerDown(within(panel).getByRole('heading', { name: 'Add node' }), {
      pointerId: 1, button: 0, clientX: 1, clientY: 1,
    })
    expect(z(panel)).toBeGreaterThan(z(inboxRoot))
    fireEvent.focus(within(inbox).getAllByRole('button')[0]!)
    expect(z(inboxRoot)).toBeGreaterThan(z(panel))
    await user.click(await screen.findByRole('button', { name: 'Activities' }))
    const activities = await screen.findByRole('region', { name: 'Activities popover' })
    for (const other of [inboxRoot, panel]) expect(z(activities)).toBeGreaterThan(z(other))
  }, 30_000)

  it('lists only available Agents to add and stays open when the Board is clicked or a node is selected', async () => {
    const user = userEvent.setup()
    const { names } = await mountBoard('containers-picker')
    await user.click(await screen.findByRole('button', { name: 'Add agent or job to graph' }))
    const panel = addNodePanel()
    expect(within(panel).queryByText(/Saved jobs|one-pass|Existing agent|Choose a node/i)).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Worker' })).not.toBeInTheDocument()
    expect(within(panel).getAllByRole('button', { name: /^Add / }).length).toBeGreaterThan(0)
    fireEvent.click(document.querySelector<HTMLElement>('.react-flow__pane')!)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${names.first},`) }))
    await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(`^${names.first},`) })).toHaveAttribute('aria-pressed', 'true'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(panel).toBeInTheDocument()
    expect(panel).toBeVisible()
    await user.click(within(panel).getByRole('button', { name: 'Close node picker' }))
    await waitFor(() => expect(panel).not.toBeInTheDocument())
  }, 30_000)
})
