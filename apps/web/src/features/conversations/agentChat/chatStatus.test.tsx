import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentChatFixtures, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { useConversationDraftStore } from '../conversationDraftStore'
import { AgentChatTestSource, installChatSource, mountChat } from './testSupport'
import { server } from '../../../mocks/server'

const clients: ReturnType<typeof mountChat>['client'][] = []
beforeEach(installChatSource)
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  useConversationDraftStore.getState().clearAllDrafts()
  vi.unstubAllGlobals()
})

it.each([
  ['interrupting', 'Stopping chat'],
  ['uncertain', 'Delivery unconfirmed'],
  ['waiting_approval', 'Approval pending'],
] as const)('visibly explains Board chat %s even when sending is unavailable', async (phase, label) => {
  const state: AgentChatState = structuredClone(agentChatFixtures.active)
  state.sessionState = phase
  state.availability = { canSend: false, reason: 'harness_unavailable', message: 'Native delivery not confirmed' }
  const mounted = mountChat(state)
  clients.push(mounted.client)
  await mounted.ready()
  expect(screen.getByText(label)).toBeVisible()
  await userEvent.hover(screen.getByRole('status', { name: 'Agent state' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Native delivery not confirmed')
})

it('keeps readable chat quiet while polling is available', async () => {
  const mounted = mountChat(agentChatFixtures.idleAfterCompletion)
  clients.push(mounted.client)
  await mounted.ready()
  await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
  const stream = AgentChatTestSource.instances[0]!
  act(() => stream.open())
  act(() => stream.fail())
  expect(await screen.findByText('Reconnecting to live updates')).toBeVisible()
  expect(screen.getByText('It is a workflow engine.', { selector: '.conversation-message-content, .conversation-message-content p' })).toBeVisible()
})

it('keeps unfinished work as the chat status while live updates reconnect', async () => {
  const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  state.activitySnapshot = { schemaVersion: 1, scope: { kind: 'agent_chat', conversationId: state.conversation!.id,
    workspaceId: state.context.workspaceId, workflowId: state.context.workflowId, nodeId: state.context.workflowNodeId,
    agentId: state.context.agentId }, revision: String(state.revision),
  active: [{ ref: { kind: 'tool', itemId: 'running-tool' }, phase: 'active', outcome: null, delivery: null, evidence: 'confirmed', startedAt: null }],
  queued: [], latest: null, pendingInteractions: [], activities: [], page: { before: null, nextCursor: null, hasMore: false } }
  const mounted = mountChat(state)
  clients.push(mounted.client)
  await mounted.ready()
  await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
  const stream = AgentChatTestSource.instances[0]!
  act(() => stream.open())
  act(() => stream.fail())
  expect(await screen.findByText('Background work continues')).toBeVisible()
  expect(screen.queryByText('Reconnecting to live updates')).not.toBeInTheDocument()
})

it.each([
  [503, 'The selected computer is disconnected.'],
  [500, 'The selected computer is disconnected.'],
  ['restart', 'Updating — reconnecting…'],
] as const)('shows the Board chat command error inline after HTTP %s', async (failure, message) => {
  const mounted = mountChat(agentChatFixtures.idleAfterCompletion)
  clients.push(mounted.client)
  await mounted.ready()
  server.use(http.post('/api/workspaces/:workspaceId/agent-chat/messages', () => failure === 'restart'
    ? new HttpResponse(null, { status: 502 })
    : HttpResponse.json({
      error: { code: 'HARNESS_UNAVAILABLE', message: 'The selected computer is disconnected.' },
    }, { status: failure })))
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'A follow-up' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  expect(await screen.findByText(message)).toBeVisible()
})
