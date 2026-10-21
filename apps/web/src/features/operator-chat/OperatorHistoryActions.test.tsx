import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '../../shared/api/client'
import { OperatorHistoryActions } from './OperatorHistoryActions'
import { operatorState } from './pr17-test-fixtures'
import { summarizeOperatorConversation } from './operatorChatStatus'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../shared/api/client', async original => ({
  ...await original<typeof import('../../shared/api/client')>(), getOperatorConversation: get,
}))
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.clearAllMocks() })

function mount(state = operatorState({ turnState: 'idle', activeRequestId: null })) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const remove = vi.fn()
  render(<QueryClientProvider client={client}>
    <OperatorHistoryActions summary={summarizeOperatorConversation(state)}
      queryKey={['operator-history-actions', state.conversation.id]} enabled removing={false} onRemove={remove} />
  </QueryClientProvider>)
  return remove
}

it('shows an unselected retired chat as read-only without offering deletion', async () => {
  const state = operatorState({ turnState: 'idle', activeRequestId: null,
    settings: { harness: 'opencode', model: 'provider/historical-model', variant: '', showThinking: false } })
  get.mockResolvedValue(state)
  const remove = mount(state)
  expect(await screen.findByText('Retired harness (OpenCode): read-only')).toBeVisible()
  expect(screen.queryByRole('button', { name: /Chat options:/ })).not.toBeInTheDocument()
  expect(remove).not.toHaveBeenCalled()
})

it('keeps deletion available for supported idle chats after reading their harness', async () => {
  get.mockResolvedValue(operatorState({ turnState: 'idle', activeRequestId: null }))
  const remove = mount()
  fireEvent.click(await screen.findByRole('button', { name: /Chat options:/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
  expect(remove).toHaveBeenCalledOnce()
})

it('offers no write action when the harness readback is denied', async () => {
  get.mockRejectedValue(new ApiError({ code: 'ACCESS_DENIED', message: 'Denied' }, 403))
  const remove = mount()
  await waitFor(() => expect(get).toHaveBeenCalledOnce())
  expect(screen.queryByRole('button', { name: /Chat options:/ })).not.toBeInTheDocument()
  expect(remove).not.toHaveBeenCalled()
})
