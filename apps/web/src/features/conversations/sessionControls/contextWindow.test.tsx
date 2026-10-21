import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { SessionControlStateSchema, unavailableSessionControls } from '@foreman-code/contracts'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { OperatorChat } from '../../operator-chat/OperatorChat'
import { OperatorChatVisibilityProvider } from '../../operator-chat/visibility'
import { useOperatorChatStore } from '../../operator-chat/operatorChatStore'
import { mountChat } from '../agentChat/testSupport'

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  useOperatorChatStore.getState().reset()
})

it.each(['Operator', 'Agent'] as const)('shows the full catalog window before the first %s turn', async role => {
  const controls = SessionControlStateSchema.parse({ conversationId: null, revision: 0, profileKey: 'profile',
    desiredMode: 'regular', appliedMode: null, defaults: {}, desired: {}, applied: null, applicability: 'next-turn',
    context: null, nativeSessionId: null, nativeProviderVersion: null, compaction: null, compactions: [], busyReason: null,
    capabilities: { ...unavailableSessionControls('profile'), model: 'selected-model', modelCapacity: 272000 } })
  const response = () => HttpResponse.json(controls)
  server.use(http.get('/api/operator/conversations/:conversationId/session-controls', ({ params }) =>
    HttpResponse.json({ ...controls, conversationId: String(params.conversationId) })),
    http.get('/api/workspaces/:workspaceId/agent-chat/session-controls', response))
  if (role === 'Operator') {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    useOperatorChatStore.setState({ open: true, selectedConversationId: 'fresh-context-chat' })
    render(<QueryClientProvider client={client}><OperatorChatVisibilityProvider enabled>
      <OperatorChat />
    </OperatorChatVisibilityProvider></QueryClientProvider>)
  } else {
    const mounted = mountChat(structuredClone(agentChatFixtures.empty))
    clients.push(mounted.client)
    await mounted.ready()
  }
  const meter = await screen.findByRole('button', { name: '0% context' })
  expect(meter).toHaveTextContent('272,000 of 272,000 left')
  fireEvent.click(meter)
  expect(screen.getByText('0 tokens in context / 272,000 native context window')).toBeInTheDocument()
  expect(within(screen.getByRole('form', { name: 'Conversation composer' })).getByRole('textbox', { name: 'Message' }))
    .toHaveValue('')
})
