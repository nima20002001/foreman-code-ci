// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
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
import { AgentChatTestSource, installChatSource } from '../conversations/agentChat/testSupport'
import { useApprovalInboxStore } from '../approvals'
import { createMemoryBoardHandlers } from '../memory-boards/mocks'
import { createMemoryTestPort, memoryTestCard } from '../memory-boards/testing'
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
  const root = `/api/workspaces/${saved.workspaceId}/workflows/${saved.workflowId}`
  server.use(http.get(`${root}/execution-chat/target`, ({ request }) => {
    const nodeId = new URL(request.url).searchParams.get('workflowNodeId')
    const context = contexts.find(item => item.workflowNodeId === nodeId)
    return context ? HttpResponse.json({ kind: 'outside_run', agent: context,
      workflowVersionId: fixture.after.id, reason: 'NO_LIVE_RUN' }) : HttpResponse.json({ error: {
        code: 'CHAT_NODE_UNAVAILABLE', message: 'The selected Agent is unavailable.' }, }, { status: 404 })
  }), http.get(`${root}/chat`, () => HttpResponse.json({ items: [], nextCursor: null, hasMore: false, revision: 0 })),
  http.get(`${root}/chat/deliveries`, () => HttpResponse.json({ items: [], nextCursor: null, hasMore: false, revision: 0 })))
  server.use(http.get('/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
    id: 'board-containers-tester', name: 'Board container tester', expiresAt: '2099-01-01T00:00:00.000Z', grants: [{
      scope: { workspaceIds: [saved.workspaceId] },
      actions: ['workspaces:read', 'workflows:read', 'agents:read', 'graph:read', 'interactions:read', 'runs:read', ...agentChatTestActions],
    }],
  } }))))
  const { router } = await mountMeasuredBoard(`/workspaces/${saved.workspaceId}?workflowId=${saved.workflowId}`)
  return { router, scope: saved, names: { first: first!.name!, second: second!.name! } }
}
const rail = () => screen.getByRole('complementary', { name: 'Workflow side panel' })
const z = (element: Element) => Number((element as HTMLElement).style.zIndex)
const openChat = async (name: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Open ${name} chat` }))
  await screen.findByRole('complementary', { name: 'Workflow side panel' })
  return rail()
}

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
    await user.click(screen.getByRole('button', { name: 'Group chat' }))
    const group = await screen.findByRole('dialog', { name: 'Group chat' })
    expect(within(group).getByRole('region', { name: 'Group chat' })).toBeVisible()
    expect(screen.queryByRole('complementary', { name: 'Workflow side panel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    await user.click(within(group).getByRole('button', { name: 'Close group chat' }))
    await openChat(names.second)
    expect(await within(rail()).findByRole('textbox', { name: 'Message' })).toHaveValue('Retain the second Agent draft')
    await openChat(names.first)
    expect(await within(rail()).findByRole('textbox', { name: 'Message' })).toHaveValue('Retain the first Agent draft')
  }, 30_000)

  it('hides the Agent body beneath Memory board and restores the Board opener after closing', async () => {
    const user = userEvent.setup()
    const { names, scope, router } = await mountBoard('containers-memory')
    const memory = createMemoryTestPort({ cards: [memoryTestCard({ title: 'Keep the conversation draft' })],
      scope: { kind: 'workflow', workspaceId: scope.workspaceId, workflowId: scope.workflowId } })
    server.use(...createMemoryBoardHandlers(memory.port))
    const opener = await screen.findByRole('button', { name: `Open ${names.first} chat` })
    await user.click(opener)
    await user.type(await within(rail()).findByRole('textbox', { name: 'Message' }), 'Retain through modal')
    // The URL owns the memory dialog; the Board opens it from a Kanban card.
    await act(async () => {
      const { pathname, searchStr } = router.state.location
      router.history.push(`${pathname}${searchStr}&boardMemory=true`)
    })
    expect(await screen.findByRole('dialog', { name: 'Memory board' })).toBeVisible()
    const stream = await waitFor(() => {
      const source = AgentChatTestSource.instances.find(item => item.url.startsWith('/api/memory-boards/'))
      expect(source).toBeDefined()
      return source!
    })
    act(() => stream.open())
    expect(await screen.findByText('Keep the conversation draft')).toBeVisible()
    expect(screen.queryByRole('complementary', { name: 'Workflow side panel' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close memory board' }))
    expect(await within(rail()).findByRole('textbox', { name: 'Message' })).toHaveValue('Retain through modal')
    await user.click(within(rail()).getByRole('button', { name: 'Back to Board' }))
    await waitFor(() => expect(opener).toHaveFocus())
  }, 30_000)
})

describe('floating Board containers', () => {
  it('preserves opening and focus stacking for the approval inbox and Activities', async () => {
    const user = userEvent.setup()
    await mountBoard('containers-remaining-stack')
    await user.click(await screen.findByRole('button', { name: /^Open human approval inbox/ }))
    const inbox = await screen.findByRole('dialog', { name: 'Human approval inbox' })
    const inboxRoot = inbox.closest<HTMLElement>('.approval-inbox-root')!
    await user.click(await screen.findByRole('button', { name: 'Activities' }))
    const activities = await screen.findByRole('region', { name: 'Activities popover' })
    expect(z(activities)).toBeGreaterThan(z(inboxRoot))
    fireEvent.focus(within(inbox).getAllByRole('button')[0]!)
    expect(z(inboxRoot)).toBeGreaterThan(z(activities))
  }, 30_000)
})
