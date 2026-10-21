import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentChatFixtures, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { agentChatApi } from '../../../shared/api/agentChat'
import { ApiError } from '../../../shared/api/client'
import { agentChatFixtureFor } from '../../../shared/mocks/agentChatHandlers'
import { useConversationDraftStore } from '../conversationDraftStore'
import { AgentChatTestSource, installChatSource, mountChat } from './testSupport'
import { agentChatStateKey } from './useAgentChat'
import { deferred } from '../../../test/deferred'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'

const clients: QueryClient[] = []
const releases: (() => void)[] = []

beforeEach(installChatSource)
afterEach(() => {
  releases.splice(0).forEach(release => release())
  clients.splice(0).forEach(client => client.clear())
  useConversationDraftStore.getState().clearAllDrafts()
  vi.unstubAllGlobals()
})

async function openChat() {
  const initial = structuredClone(agentChatFixtures.active)
  const mounted = mountChat(initial)
  clients.push(mounted.client)
  await mounted.ready()
  await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
  return { initial, mounted, source: AgentChatTestSource.instances[0]! }
}

it('keeps one stream for scalar-equivalent Board contexts and replaces it when the selected Agent changes', async () => {
  const { initial, mounted, source } = await openChat()
  for (let index = 0; index < 4; index++) {
    mounted.switchContext({ ...initial.context })
  }
  expect(AgentChatTestSource.instances).toHaveLength(1)
  expect(source.close).not.toHaveBeenCalled()

  const nextContext = { ...initial.context, agentId: 'another-agent', workflowNodeId: 'another-node' }
  const nextState = agentChatFixtureFor(initial, nextContext, 'another-conversation')
  mounted.mock.setState(nextState)
  mounted.switchContext(nextContext)
  await waitFor(() => expect(source.close).toHaveBeenCalledOnce())
  await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(2))
  act(() => source.snapshot(initial))
  expect(mounted.client.getQueryData<AgentChatState>(agentChatStateKey(nextContext))?.conversation?.id)
    .toBe('another-conversation')
})

it('accepts a slow state read during activity traffic and coalesces one trailing read', async () => {
  const { initial, source } = await openChat()
  const first = deferred<void>()
  const trailing = deferred<void>()
  releases.push(() => first.resolve(), () => trailing.resolve())
  const updated: AgentChatState = { ...initial, revision: initial.revision + 1,
    messages: initial.messages.map(message => ({ ...message, content: 'Readback accepted during activity' })) }
  const signals: (AbortSignal | undefined)[] = []
  vi.spyOn(agentChatApi, 'read').mockImplementation(async (_context, options) => {
    signals.push(options?.signal)
    await (signals.length === 1 ? first.promise : trailing.promise)
    return updated
  })
  act(() => source.snapshot(initial))
  await waitFor(() => expect(signals).toHaveLength(1))
  for (let id = 1; id <= 4; id++) {
    act(() => source.event({ id, conversationId: initial.conversation!.id, type: 'activity',
      data: { requestId: initial.activeTurn!.requestId } }))
  }
  expect(signals[0]?.aborted).toBe(false)
  await act(async () => first.resolve())
  expect((await screen.findAllByText('Readback accepted during activity')).length).toBeGreaterThan(0)
  await waitFor(() => expect(signals).toHaveLength(2))
  expect(signals[0]?.aborted).toBe(false)
  expect(AgentChatTestSource.instances).toHaveLength(1)
  await act(async () => trailing.resolve())
})

it('closes the stream and withdraws private state when the event readback is denied', async () => {
  const { initial, mounted, source } = await openChat()
  const read = vi.spyOn(agentChatApi, 'read').mockRejectedValue(
    new ApiError({ code: 'ACCESS_DENIED', message: 'No access to this chat.' }, 403),
  )
  act(() => source.snapshot(initial))
  await screen.findByText('No access to this chat.')
  await waitFor(() => expect(source.close).toHaveBeenCalledOnce())
  const reads = read.mock.calls.length
  act(() => source.event({ id: 1, conversationId: initial.conversation!.id, type: 'activity', data: {} }))
  expect(read).toHaveBeenCalledTimes(reads)
  expect(screen.queryByTestId('agent-conversation')).not.toBeInTheDocument()
  mounted.unmount()
})

it('refreshes a loaded oversized provisional answer when the accepted conversation revision advances', async () => {
  const { initial, mounted, source } = await openChat()
  const provisional = 'Provisional ' + 'a'.repeat(270_000)
  const finalized = 'Finalized ' + 'b'.repeat(270_000)
  const message = { id: 'oversized-answer', conversationId: initial.conversation!.id,
    role: 'assistant' as const, content: provisional, revision: '1', nativeMessageComplete: false }
  let current = message
  const cursors: Array<string | null> = []
  server.use(http.get('/api/workspaces/:workspaceId/agent-chat/conversations/:id/history', ({ request }) => {
    cursors.push(new URL(request.url).searchParams.get('before'))
    return HttpResponse.json({ conversationId: initial.conversation!.id, messages: [current], nextCursor: null })
  }))
  const state = { ...initial, revision: initial.revision + 1, messages: [], hasEarlierMessages: true }
  mounted.mock.setState(state)
  await act(async () => { await mounted.refresh() })
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier messages' }))
  expect(await screen.findByText(provisional)).toBeVisible()
  current = { ...message, content: finalized, revision: '2', nativeMessageComplete: true }
  const finished = { ...state, revision: state.revision + 1 }
  mounted.mock.setState(finished)
  act(() => source.snapshot(finished))
  expect(await screen.findByText(finalized)).toBeVisible()
  expect(screen.queryByText(provisional)).not.toBeInTheDocument()
  const batches = mounted.client.getQueriesData<{ pages: Array<{ pages: Array<{ messages: typeof message[] }> }> }>({
    predicate: query => query.queryKey.at(-1) === 'history'
      && query.queryKey.at(-2) === initial.conversation!.id,
  })[0]?.[1]
  expect(batches?.pages[0]?.pages[0]?.messages[0]).toMatchObject({ revision: '2', nativeMessageComplete: true })
  expect(cursors.every(cursor => cursor === null)).toBe(true)
})
