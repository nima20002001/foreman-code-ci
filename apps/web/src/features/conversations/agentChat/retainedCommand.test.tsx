import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse, type RequestHandler } from 'msw'
import { agentChatFixtures, SendAgentChatMessageRequestSchema, type AgentChatContext, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import type { ChatDeliveryReceipt, DeliveryTarget } from '@foreman-code/contracts'
import { server } from '../../../mocks/server'
import { useConversationDraftStore } from '../conversationDraftStore'
import { agentChatFixtureFor, createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { AgentChatTestSource, installChatSource } from './testSupport'
import { AgentConversation } from './AgentConversation'
import { LiveAgentConversation } from './LiveAgentConversation'
import { agentChatContextKey } from './model'

const clients: QueryClient[] = []
const releases: Array<() => void> = []
const initial = { ...structuredClone(agentChatFixtures.active), messages: [], turns: [], activeTurn: null,
  sessionState: 'idle' as const }
const target: DeliveryTarget = { kind: 'agent_conversation', conversationId: initial.conversation!.id,
  agent: { workspaceId: initial.context.workspaceId, workflowId: initial.context.workflowId,
    workflowNodeId: initial.context.workflowNodeId, agentId: initial.context.agentId } }
const root = `/api/workspaces/${initial.context.workspaceId}/agent-chat`
const body = 'Original retained command\nsecond line'
function receipt(input: SendAgentChatMessageRequest, state: ChatDeliveryReceipt['state']): ChatDeliveryReceipt {
  return { id: `delivery-${input.requestId}`, commandId: input.requestId, target,
    requestedIntent: input.intent, appliedIntent: input.intent === 'auto' ? 'next_turn' : input.intent,
    state, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }
}
function mount(options: { live?: boolean; handlers?: RequestHandler[] } = {}) {
  server.use(...createAgentChatMock(structuredClone(initial)).handlers)
  if (options.handlers) server.use(...options.handlers)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  const Panel = options.live ? LiveAgentConversation : AgentConversation
  const tree = (context: AgentChatContext) => <QueryClientProvider client={client}><Panel name="Coder" context={context} /></QueryClientProvider>
  const view = render(tree(initial.context))
  return { ...view, client, switchContext: (context: AgentChatContext) => view.rerender(tree(context)) }
}
async function open() {
  const mounted = mount(); await screen.findByRole('list', { name: 'Conversation history' })
  return mounted
}
function send() {
  const input = screen.getByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: body } })
  fireEvent.keyDown(input, { key: 'Enter' })
  return input
}
beforeEach(() => { localStorage.clear(); useConversationDraftStore.getState().clearAllDrafts(); installChatSource() })
afterEach(() => {
  releases.splice(0).forEach(release => release()); cleanup(); clients.splice(0).forEach(client => client.clear())
  useConversationDraftStore.getState().clearAllDrafts(); vi.unstubAllGlobals()
})

it('acknowledges a canonical receipt without inventing a native turn and keeps its original input after reopening', async () => {
  const mounted = await open(); let saved: ChatDeliveryReceipt | undefined
  let sends = 0
  server.use(http.post(`${root}/messages`, async ({ request }) => {
    const command = SendAgentChatMessageRequestSchema.parse(await request.json()); sends++
    saved = receipt(command, 'queued')
    return HttpResponse.json({ state: initial, receipt: saved, replayed: false })
  }), http.post(`${root}/deliveries/read`, () => HttpResponse.json({ target, receipts: saved ? [saved] : [] })))
  const input = send()
  const retained = await screen.findByRole('article', { name: 'Retained input' })
  expect(within(retained).getByText('Original retained command second line')).toBeVisible()
  expect(within(retained).getByText('Queued')).toBeVisible()
  await waitFor(() => expect(input).toHaveValue(''))
  expect(within(screen.getByRole('list', { name: 'Conversation history' })).queryByText('Original retained command second line')).not.toBeInTheDocument()
  mounted.unmount(); mounted.client.clear()
  await open()
  expect(await screen.findByRole('article', { name: 'Retained input' })).toHaveTextContent('Original retained command')
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
  expect(sends).toBe(1)
})

it.each(['failed', 'unknown'] as const)('preserves the exact draft for a no-turn %s receipt and revokes retained text on definite denial', async status => {
  const mounted = await open(); let saved: ChatDeliveryReceipt | undefined, denied = false, sends = 0
  server.use(http.post(`${root}/messages`, async ({ request }) => {
    saved = receipt(SendAgentChatMessageRequestSchema.parse(await request.json()), status); sends++
    return HttpResponse.json({ state: initial, receipt: saved, replayed: false })
  }), http.post(`${root}/deliveries/read`, () => denied
    ? HttpResponse.json({ code: 'ACCESS_DENIED', message: 'The original input is no longer authorized.' }, { status: 403 })
    : HttpResponse.json({ target, receipts: saved ? [saved] : [] })))
  const input = send()
  await screen.findByRole('article', { name: 'Retained input' })
  expect(input).toHaveValue(body)
  mounted.unmount(); mounted.client.clear()
  await open()
  const retained = await screen.findByRole('article', { name: 'Retained input' })
  expect(retained).toHaveTextContent('Original retained command')
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(body)
  const source = AgentChatTestSource.instances.at(-1)
  denied = true
  const refresh = within(retained).getByRole('button', { name: status === 'unknown' ? 'Check status' : 'Refresh delivery status' })
  await waitFor(() => expect(refresh).toBeEnabled()); fireEvent.click(refresh)
  expect(await screen.findByText('Agent chat access unavailable')).toBeVisible()
  expect(screen.queryByRole('article', { name: 'Retained input' })).not.toBeInTheDocument()
  expect(screen.queryByText('Original retained command', { exact: false })).not.toBeInTheDocument()
  if (source) await waitFor(() => expect(source.close).toHaveBeenCalled())
  expect(sends).toBe(1)
})

it.each(['command', 'target'] as const)('does not clear the draft for a response confirming a different %s', async mismatch => {
  await open()
  server.use(http.post(`${root}/messages`, async ({ request }) => {
    const saved = receipt(SendAgentChatMessageRequestSchema.parse(await request.json()), 'accepted')
    return HttpResponse.json({ state: initial, replayed: false, receipt: mismatch === 'command'
      ? { ...saved, commandId: 'another-command' }
      : { ...saved, target: { ...target, conversationId: 'another-conversation' } } })
  }))
  const input = send()
  expect(await screen.findByText('The delivery receipt did not confirm this exact command and target.')).toBeVisible()
  expect(input).toHaveValue(body)
  expect(screen.queryByRole('article', { name: 'Retained input' })).not.toBeInTheDocument()
})

it('does not clear an edit-away-and-back draft when a delayed no-turn receipt arrives', async () => {
  await open(); let release!: () => void, started = false
  const gate = new Promise<void>(resolve => { release = resolve }); releases.push(release)
  let saved: ChatDeliveryReceipt | undefined
  server.use(http.post(`${root}/messages`, async ({ request }) => {
    saved = receipt(SendAgentChatMessageRequestSchema.parse(await request.json()), 'accepted'); started = true
    await gate; return HttpResponse.json({ state: initial, receipt: saved, replayed: false })
  }), http.post(`${root}/deliveries/read`, () => HttpResponse.json({ target, receipts: saved ? [saved] : [] })))
  const input = send(); await waitFor(() => expect(started).toBe(true))
  fireEvent.change(input, { target: { value: 'A newer draft' } })
  fireEvent.change(input, { target: { value: body } })
  await act(async () => release())
  await screen.findByRole('article', { name: 'Retained input' })
  expect(input).toHaveValue(body)
})

it('keeps an authorized receipt-only replay readable when the target no longer has a conversation snapshot', async () => {
  const mounted = await open(); let saved: ChatDeliveryReceipt | undefined, sends = 0
  server.use(http.post(`${root}/messages`, async ({ request }) => {
    saved = receipt(SendAgentChatMessageRequestSchema.parse(await request.json()), 'failed'); sends++
    return HttpResponse.json({ receipt: saved, replayed: true })
  }), http.post(`${root}/deliveries/read`, () => HttpResponse.json({ target, receipts: saved ? [saved] : [] })))
  const input = send()
  expect(await screen.findByRole('article', { name: 'Retained input' })).toHaveTextContent('Original retained command')
  expect(input).toHaveValue(body)
  mounted.unmount(); mounted.client.clear()
  mount({ handlers: [http.get(root, () => HttpResponse.json({ code: 'CHAT_TARGET_REMOVED', message: 'The target no longer has a snapshot.' }, { status: 404 }))] })
  expect(await screen.findByRole('article', { name: 'Retained input' })).toHaveTextContent('Original retained command')
  await waitFor(() => expect(screen.queryByRole('list', { name: 'Conversation history' })).not.toBeInTheDocument())
  expect(screen.getByRole('region', { name: 'Retained commands' })).toHaveTextContent('The conversation snapshot is unavailable.')
  expect(sends).toBe(1)
})

it('scopes receipt denial to the old Agent when the public panel changes selection', async () => {
  const mounted = await open(); let saved: ChatDeliveryReceipt | undefined
  server.use(http.post(`${root}/messages`, async ({ request }) => {
    saved = receipt(SendAgentChatMessageRequestSchema.parse(await request.json()), 'unknown')
    return HttpResponse.json({ receipt: saved, replayed: false })
  }), http.post(`${root}/deliveries/read`, () => HttpResponse.json({ code: 'ACCESS_DENIED', message: 'Old target denied.' }, { status: 403 })))
  send(); await screen.findByText('Agent chat access unavailable')
  const next = { ...initial.context, agentId: 'another-agent', workflowNodeId: 'another-node' }
  const nextState = agentChatFixtureFor(initial, next, 'another-conversation')
  server.use(http.get(root, () => HttpResponse.json(nextState)))
  mounted.switchContext(next)
  await screen.findByRole('list', { name: 'Conversation history' })
  expect(screen.queryByText('Agent chat access unavailable')).not.toBeInTheDocument()
  expect(screen.queryByRole('article', { name: 'Retained input' })).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'New target draft' } })
  expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
})

it('keeps a persisted draft editable when the first selected-chat read is offline', async () => {
  useConversationDraftStore.getState().setDraft(agentChatContextKey(initial.context), body)
  mount({ handlers: [http.get(root, () => HttpResponse.error())] })
  const input = await screen.findByRole('textbox', { name: 'Message' })
  expect(input).toHaveValue(body)
  await screen.findByText('The selected chat could not be read. Your draft is kept; refresh its target before sending.')
  fireEvent.change(input, { target: { value: 'Edited while unavailable' } })
  expect(input).toHaveValue('Edited while unavailable')
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  expect(screen.queryByRole('list', { name: 'Conversation history' })).not.toBeInTheDocument()
})

it.each([false, true])('keeps only the local draft editable when first access read fails (live=%s)', async live => {
  useConversationDraftStore.getState().setDraft(agentChatContextKey(initial.context), body)
  mount({ live, handlers: [http.get('/api/local-human', () => HttpResponse.error())] })
  await screen.findByText('Chat access could not be checked. Your local draft remains editable.')
  const input = screen.getByRole('textbox', { name: 'Message' })
  expect(input).toHaveValue(body)
  fireEvent.change(input, { target: { value: 'Edited while access is offline' } })
  expect(input).toHaveValue('Edited while access is offline')
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  expect(screen.queryByRole('list', { name: 'Conversation history' })).not.toBeInTheDocument()
  expect(screen.queryByRole('article', { name: 'Retained input' })).not.toBeInTheDocument()
  expect(AgentChatTestSource.instances).toHaveLength(0)
})

it.each([['failed', 'Failed'], ['completed', 'Completed'], ['unknown', 'Delivery unconfirmed']] as const)(
  'persists a queued command’s newer %s receipt without requiring a native journal', async (status, label) => {
    const mounted = await open(); let saved: ChatDeliveryReceipt | undefined, offline = false, sends = 0
    server.use(http.post(`${root}/messages`, async ({ request }) => {
      saved = receipt(SendAgentChatMessageRequestSchema.parse(await request.json()), 'queued'); sends++
      return HttpResponse.json({ receipt: saved, replayed: false })
    }), http.post(`${root}/deliveries/read`, () => offline ? HttpResponse.error()
      : HttpResponse.json({ target, receipts: saved ? [saved] : [] })))
    send(); await screen.findByText('Queued')
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
    saved = { ...saved!, state: status, updatedAt: '2026-10-01T00:01:00Z' }
    const refresh = screen.getByRole('button', { name: 'Refresh delivery status' })
    await waitFor(() => expect(refresh).toBeEnabled()); fireEvent.click(refresh)
    expect(await within(screen.getByRole('article', { name: 'Retained input' })).findByText(label)).toBeVisible()
    mounted.unmount(); mounted.client.clear(); offline = true
    await open()
    const retained = await screen.findByRole('article', { name: 'Retained input' })
    expect(within(retained).getByText(label)).toBeVisible()
    await screen.findByText('Delivery status could not be refreshed.')
    expect(within(retained).queryByText('Queued')).not.toBeInTheDocument()
    if (status === 'unknown') {
      const input = send()
      await screen.findByText('Delivery is unknown. Use “Send again as new message” and review the warning.')
      expect(input).toHaveValue(body)
    }
    expect(sends).toBe(1)
  },
)
