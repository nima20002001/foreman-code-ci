import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { agentChatFixtures, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { ApiError } from '../../../shared/api/client'
import { useConversationDraftStore } from '../conversationDraftStore'
import { completedFixture, startedFixture } from './f7.testSupport'
import { mountChat } from './testSupport'
import { commandMayHaveBeenAccepted } from './useAgentChat'

const clients: ReturnType<typeof mountChat>['client'][] = []
afterEach(() => {
  clients.splice(0).forEach(client => client.clear())
  useConversationDraftStore.getState().clearAllDrafts()
})

it.each([401, 403])('retains the original send across a post-acceptance %s and reload', async status => {
  const mounted = mountChat(agentChatFixtures.idleAfterCompletion)
  clients.push(mounted.client)
  await mounted.ready()
  const content = 'Recover this accepted message'
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: content } })
  let original: SendAgentChatMessageRequest | undefined
  let posts = 0
  server.use(
    http.post('/api/workspaces/:workspaceId/agent-chat/messages', async ({ request }) => {
      original = await request.json() as SendAgentChatMessageRequest
      posts++
      return HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Chat access revoked.' } }, { status })
    }),
    http.get('/api/workspaces/:workspaceId/agent-chat', () =>
      HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Chat access revoked.' } }, { status })),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await screen.findByText('Agent chat access unavailable')
  expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
  expect(screen.queryByText('It is a workflow engine.')).not.toBeInTheDocument()
  expect(original).toBeDefined()
  mounted.unmount()
  mounted.client.clear()

  // Access is restored, but the accepted receipt has not reached the readback yet.
  const reloaded = mountChat(agentChatFixtures.idleAfterCompletion)
  clients.push(reloaded.client)
  await reloaded.ready()
  expect(reloaded.client.getMutationCache().getAll()[0]?.state.variables).toMatchObject({
    kind: 'send', input: original,
  })
  await screen.findByLabelText('Unknown')
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' })
  await screen.findByText(/Delivery is unknown/)
  expect(posts).toBe(1)
  expect(reloaded.mock.calls.filter(call => call.method === 'POST')).toHaveLength(0)

  const accepted = structuredClone(agentChatFixtures.idleAfterCompletion)
  const turn = {
    ...accepted.turns[0]!,
    requestId: original!.requestId,
    messageId: 'recovered-message',
    sequence: '2',
    delivery: 'queued' as const,
    intent: original!.intent,
  }
  accepted.turns.push(turn)
  accepted.messages.push({
    id: turn.messageId,
    conversationId: accepted.conversation!.id,
    role: 'user',
    requestId: original!.requestId,
    content,
    createdAt: accepted.messages[0]!.createdAt,
  })
  reloaded.mock.setState(completedFixture(startedFixture(accepted, original!.requestId), 'Recovered answer'))
  await act(() => reloaded.refresh())
  await screen.findByText('Recovered answer')
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
  expect(posts).toBe(1)
  reloaded.unmount()
  reloaded.client.clear()
  const settled = mountChat(agentChatFixtures.idleAfterCompletion)
  clients.push(settled.client)
  await settled.ready()
  expect(settled.client.getMutationCache().getAll()).toHaveLength(0)
})

it('still treats a validation rejection before acceptance as definitive', () => {
  expect(commandMayHaveBeenAccepted(new ApiError({ code: 'INVALID_REQUEST', message: 'Invalid input' }, 400)))
    .toBe(false)
})
