import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { ChatSendRequestSchema, DEFAULT_HARNESS_DEFAULTS, operatorChatSettings,
  type ChatDeliveryReceipt, type ChatSendRequest, type OperatorConversationState } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { clearRevisionedFormPersistence } from '../settings/revisionedForm'
import { OperatorChat } from './OperatorChat'
import { OperatorChatVisibilityProvider } from './visibility'
import { useOperatorChatStore } from './operatorChatStore'
import { operatorState } from './pr17-test-fixtures'
import { summarizeOperatorConversation } from './operatorChatStatus'
import { configuredOperatorSetup } from './operatorSetupTestFixture'

const api = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), create: vi.fn(), subscribe: vi.fn(), close: vi.fn() }))
vi.mock('../../shared/api/client', async original => ({ ...await original<typeof import('../../shared/api/client')>(),
  getOperatorConversation: api.get, createOperatorConversation: api.create }))
vi.mock('../../shared/api/operatorChatSummaries', async original => ({ ...await original<typeof import('../../shared/api/operatorChatSummaries')>(),
  listOperatorConversationSummaries: api.list }))
vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: api.subscribe }))

const clients: QueryClient[] = []
const id = 'retained-operator', target = { kind: 'operator_conversation' as const, conversationId: id }
const root = `/api/operator/conversations/${id}/deliveries`, body = 'Prepared input before native adoption'
let state: OperatorConversationState, command: ChatSendRequest | undefined, receipt: ChatDeliveryReceipt | undefined
let exactReceipt: ChatDeliveryReceipt | undefined
let denied: boolean, receiptOffline: boolean, inputReads: number, sends: number
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  return { ...render(<QueryClientProvider client={client}><OperatorChatVisibilityProvider enabled>
    <OperatorChat /></OperatorChatVisibilityProvider></QueryClientProvider>), client }
}
function save(input: ChatSendRequest) {
  command = input; receipt = { id: `receipt-${input.commandId}`, commandId: input.commandId!, target,
    requestedIntent: input.intent, appliedIntent: 'next_turn', state: 'failed', errorCode: 'OWNER_UNAVAILABLE',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }
}
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); clearRevisionedFormPersistence()
  useConversationDraftStore.getState().clearAllDrafts(); useOperatorChatStore.getState().reset()
  useOperatorChatStore.setState({ open: true, selectedConversationId: id })
  state = operatorState({ conversation: { ...operatorState().conversation, id, title: 'Retained chat' }, messages: [],
    turnState: 'idle', activeRequestId: null, settings: operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex) })
  command = undefined; receipt = undefined; exactReceipt = undefined; denied = false; receiptOffline = false; inputReads = 0; sends = 0
  api.get.mockImplementation(async () => state)
  api.list.mockImplementation(async () => ({ conversations: [summarizeOperatorConversation(state)] }))
  api.subscribe.mockReturnValue(api.close)
  server.use(http.get('/api/operator/setup', () => HttpResponse.json(configuredOperatorSetup('codex'))),
    http.post(`${root}/read`, async ({ request }) => {
      if (denied) return HttpResponse.json({ code: 'ACCESS_DENIED', message: 'This retained input is no longer authorized.' }, { status: 403 })
      const input = await request.json() as { deliveryInputs?: unknown; receiptId?: string; commandId?: string }
      if (input.deliveryInputs) {
        inputReads++
        return HttpResponse.json({ target, receipts: [], deliveryInputs: { items: command && receipt ? [{
          commandId: command.commandId, receiptId: receipt.id, target, origin: 'direct', content: command.content,
          attachments: command.attachments ?? [], intent: command.intent, createdAt: receipt.createdAt, truncated: false, bodyCursor: null,
        }] : [], nextCursor: null, hasMore: false, revision: state.revision } })
      }
      if (input.receiptId || input.commandId) return receiptOffline ? HttpResponse.error()
        : HttpResponse.json({ target, receipts: exactReceipt ? [exactReceipt] : receipt ? [receipt] : [] })
      return HttpResponse.json({ target, state, receipts: receipt ? [receipt] : [],
        delivery: { state: 'idle', capabilities: { steer: 'unavailable', queue: true, interruptAndSend: true } } })
    }), http.post(`${root}/send`, async ({ request }) => {
      save(ChatSendRequestSchema.parse(await request.json())); sends++
      return HttpResponse.json(receipt)
    }))
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks() })

it('keeps the durable prepared body visible after failure and reload, then clears it immediately on definite denial', async () => {
  const first = mount(), input = await screen.findByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: body } })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  const card = await screen.findByRole('article', { name: 'Retained input' })
  expect(within(card).getByText(body)).toBeVisible(); expect(within(card).getByText('Failed')).toBeVisible()
  await waitFor(() => expect(input).toHaveValue(body))
  expect(state.messages).toHaveLength(0)
  first.unmount(); first.client.clear()
  mount()
  const retained = await screen.findByRole('article', { name: 'Retained input' })
  expect(retained).toHaveTextContent(body)
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(body)
  expect(sends).toBe(1)
  denied = true
  fireEvent.click(within(retained).getByRole('button', { name: 'Refresh delivery status' }))
  expect(await screen.findByText('Operator access unavailable')).toBeVisible()
  expect(screen.queryByText(body)).not.toBeInTheDocument()
  expect(screen.queryByRole('article', { name: 'Retained input' })).not.toBeInTheDocument()
  await waitFor(() => expect(api.close).toHaveBeenCalled())
})

it('does not duplicate a retained input already represented by its native user row', async () => {
  save({ target, commandId: 'existing-command', intent: 'next_turn', content: body, attachments: [] })
  state = { ...state, messages: [{ id: 'original-native-user-row', conversationId: id, requestId: command!.commandId, role: 'user', content: body }] }
  mount(); expect(await screen.findByText(body)).toBeVisible()
  await waitFor(() => expect(inputReads).toBeGreaterThan(0))
  await waitFor(() => expect(screen.queryByText('Loading original inputs…')).not.toBeInTheDocument())
  expect(screen.queryByRole('article', { name: 'Retained input' })).not.toBeInTheDocument()
  expect(screen.getAllByText(body)).toHaveLength(1)
  expect(sends).toBe(0)
})

it('refreshes the exact retained receipt even when the parent readback still contains its older state', async () => {
  save({ target, commandId: 'queued-before-adoption', intent: 'next_turn', content: body, attachments: [] })
  receipt = { ...receipt!, state: 'queued', errorCode: undefined }
  mount()
  const retained = await screen.findByRole('article', { name: 'Retained input' })
  expect(within(retained).getByText('Queued')).toBeVisible()
  exactReceipt = { ...receipt, state: 'accepted', updatedAt: '2026-10-01T00:01:00Z' }
  fireEvent.click(within(retained).getByRole('button', { name: 'Refresh delivery status' }))
  expect(await within(retained).findByText('Delivered')).toBeVisible()
  expect(within(retained).queryByText('Queued')).not.toBeInTheDocument()
  expect(within(retained).getByText(body)).toBeVisible()
  expect(sends).toBe(0)
})

it('labels a failed status refresh while retaining the last receipt and retries without sending', async () => {
  save({ target, commandId: 'status-retry-command', intent: 'next_turn', content: body, attachments: [] })
  receipt = { ...receipt!, state: 'queued', errorCode: undefined }
  mount()
  const retained = await screen.findByRole('article', { name: 'Retained input' })
  expect(within(retained).getByText('Queued')).toBeVisible()
  receiptOffline = true
  fireEvent.click(within(retained).getByRole('button', { name: 'Refresh delivery status' }))
  expect(await within(retained).findByRole('alert')).toHaveTextContent('Delivery status could not be refreshed. The last known receipt is shown.')
  expect(within(retained).getByText('Queued')).toBeVisible()
  expect(within(retained).getByText(body)).toBeVisible()
  receiptOffline = false
  exactReceipt = { ...receipt, state: 'accepted', updatedAt: '2026-10-01T00:01:00Z' }
  fireEvent.click(within(retained).getByRole('button', { name: 'Retry status' }))
  expect(await within(retained).findByText('Delivered')).toBeVisible()
  expect(within(retained).queryByRole('alert')).not.toBeInTheDocument()
  expect(sends).toBe(0)
})

it('keeps the selected local draft editable when its initial snapshot cannot be read', async () => {
  useConversationDraftStore.getState().setDraft(id, 'Persisted local draft')
  api.get.mockRejectedValue(new Error('Offline'))
  mount()
  const input = await screen.findByRole('textbox', { name: 'Message' })
  expect(input).toHaveValue('Persisted local draft')
  await screen.findByText('The selected chat could not be read. Your draft is kept; refresh its target before sending.')
  fireEvent.change(input, { target: { value: 'Edited without changing target' } })
  expect(input).toHaveValue('Edited without changing target')
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  expect(sends).toBe(0); expect(api.create).not.toHaveBeenCalled()
})
