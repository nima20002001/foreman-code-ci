import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentChatFixtures, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { agentChatApi } from '../../../shared/api/agentChat'
import { deferred } from '../../../test/deferred'
import { useConversationDraftStore } from '../conversationDraftStore'
import { AgentChatTestSource, approvalState, installChatSource, mountChat } from './testSupport'

const clients: ReturnType<typeof mountChat>['client'][] = []
beforeEach(installChatSource)
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  useConversationDraftStore.getState().clearAllDrafts()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['completed', 'failed', 'canceled'])('stops responding immediately on a %s turn and stays stopped across refetch', async delivery => {
  const running = structuredClone(agentChatFixtures.active)
  const mounted = mountChat(running)
  clients.push(mounted.client)
  await mounted.ready()
  const source = AgentChatTestSource.instances[0]!
  act(() => source.snapshot(running))
  expect(screen.getByRole('status', { name: 'Coder is working' })).toBeVisible()
  await waitFor(() => expect(mounted.client.isFetching()).toBe(0))
  const response = deferred<AgentChatState>()
  vi.spyOn(agentChatApi, 'read').mockImplementationOnce(() => response.promise)
  const refetch = mounted.refresh()
  await waitFor(() => expect(mounted.client.isFetching()).toBeGreaterThan(0))
  try {
    act(() => source.event({ id: 1, conversationId: running.conversation!.id, type: 'state',
      data: { requestId: running.activeTurn!.requestId, delivery } }))
    expect(screen.queryByRole('status', { name: 'Coder is working' })).not.toBeInTheDocument()
  } finally {
    await act(async () => { response.resolve(running); await refetch })
  }
  expect(screen.queryByRole('status', { name: 'Coder is working' })).not.toBeInTheDocument()
  const finished = { ...running, revision: running.revision + 1, sessionState: 'idle' as const, activeTurn: null }
  mounted.mock.setState(finished)
  await act(async () => { await mounted.refresh() })
  expect(screen.queryByRole('status', { name: 'Coder is working' })).not.toBeInTheDocument()
  mounted.mock.setState(running)
  await act(async () => { await mounted.refresh() })
  expect(screen.queryByRole('status', { name: 'Coder is working' })).not.toBeInTheDocument()
  const next = { ...running, revision: finished.revision + 1,
    activeTurn: { ...running.activeTurn!, requestId: 'next-turn' } }
  mounted.mock.setState(next)
  await act(async () => { await mounted.refresh() })
  await waitFor(() => {
    expect(screen.getByRole('status', { name: 'Coder is working' })).toBeVisible()
  })
  act(() => source.event({ id: 2, conversationId: running.conversation!.id, type: 'state',
    data: { requestId: running.activeTurn!.requestId, delivery } }))
  expect(screen.getByRole('status', { name: 'Coder is working' })).toBeVisible()
})

it('does not animate responding dots while waiting for an approval', async () => {
  const mounted = mountChat(approvalState())
  clients.push(mounted.client)
  await mounted.ready()
  expect(screen.getByRole('region', { name: 'Agent approval request' })).toBeVisible()
  expect(screen.queryByRole('status', { name: 'Coder is working' })).not.toBeInTheDocument()
})

it.each(['queued', 'waiting'] as const)('does not animate responding dots for a %s execution', async state => {
  const initial = structuredClone(agentChatFixtures.empty)
  initial.context.runId = 'selected-run'
  initial.sourceTranscript = { executionId: 'selected-execution', state, revision: '1',
    messages: [], hasEarlierMessages: false }
  const mounted = mountChat(initial)
  clients.push(mounted.client)
  await mounted.ready()
  expect(screen.queryByRole('status', { name: 'Coder is working' })).not.toBeInTheDocument()
})
