import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { ChatSendRequestSchema, ChatStopRequestSchema, type ChatDeliveryReceipt, type ChatSendRequest,
  type ChatStopRequest, type EngineChatMessage, type EngineChatReadback } from '@foreman-code/contracts'
import { server } from '../../../mocks/server'
import { ApiError } from '../../../shared/api/client'
import type { ConversationAttachments } from '../../attachments'
import { useConversationDraftStore } from '../conversationDraftStore'
import { ExecutionChatPanel } from './ExecutionChatPanel'
import type { ExecutionChatNotice, ExecutionChatSource, ExecutionChatTarget } from './executionChatSource'

const target: ExecutionChatTarget = { kind: 'workflow_execution',
  agent: { workspaceId: 'workspace-a', workflowId: 'workflow-a', workflowNodeId: 'node-a', agentId: 'agent-a' },
  execution: { runId: 'run-a', workflowVersionId: 'version-a', executionId: 'execution-a', activationId: 'activation-a', attempt: 2 } }
const root = '/api/workspaces/workspace-a/agent-chat/deliveries'
const initialMessage: EngineChatMessage = { id: 'original-native-row', role: 'assistant', content: 'Selected native answer',
  revision: '1', sequence: '1', nativeMessageComplete: false, nativeMessageId: 'native-item-a',
  activityNative: { harness: 'codex', sessionId: 'native-session-a', turnId: 'native-turn-a', itemId: 'native-item-a' },
  provenance: { kind: 'execution', execution: target.execution } }
const initial: EngineChatReadback = { target, state: 'active', capabilities: { steer: 'native_expected_turn', queue: true, interruptAndSend: true },
  messages: [initialMessage], receipts: [], nextCursor: null, hasMore: false, revision: 1 }
const date = '2026-10-01T00:00:00Z'
const clients: QueryClient[] = []

class NativeSource implements ExecutionChatSource {
  subscriptions: Array<{ target: ExecutionChatTarget; receive: (notice: ExecutionChatNotice) => void;
    options: Parameters<ExecutionChatSource['subscribe']>[2]; close: ReturnType<typeof vi.fn> }> = []
  full: (message: EngineChatMessage) => Promise<EngineChatMessage> = async message => ({ ...message, truncation: undefined })
  subscribe(selected: ExecutionChatTarget, receive: (notice: ExecutionChatNotice) => void,
    options: Parameters<ExecutionChatSource['subscribe']>[2]) {
    const close = vi.fn()
    this.subscriptions.push({ target: selected, receive, options, close })
    return close
  }
  readMessage(_target: ExecutionChatTarget, message: EngineChatMessage) { return this.full(message) }
  message(message: EngineChatMessage, revision: number) { this.subscriptions.at(-1)!.receive({ target, message, revision }) }
}
function endpoints(value: EngineChatReadback = structuredClone(initial)) {
  const state = { value, reads: 0, commands: [] as ChatSendRequest[], stops: [] as ChatStopRequest[], loseStop: false }
  const receipt = (command: ChatSendRequest): ChatDeliveryReceipt => ({ id: 'delivery-a', commandId: command.commandId!, target: command.target,
    requestedIntent: command.intent, appliedIntent: command.intent === 'auto' ? 'steer' : command.intent,
    state: 'accepted', nativeTurnId: 'native-turn-a', createdAt: date, updatedAt: date })
  server.use(
    http.post(`${root}/read`, async ({ request }) => {
      const input = await request.json() as { deliveryInputs?: unknown; commandId?: string; receiptId?: string }
      if (input.deliveryInputs) return HttpResponse.json({ target, deliveryInputs: { items: [], nextCursor: null, hasMore: false, revision: state.value.revision } })
      if (input.commandId || input.receiptId) return HttpResponse.json({ target, receipts: state.value.receipts })
      state.reads++; return HttpResponse.json(state.value)
    }),
    http.post(`${root}/send`, async ({ request }) => {
      const input = ChatSendRequestSchema.parse(await request.json()); state.commands.push(input)
      const accepted = receipt(input); state.value = { ...state.value, receipts: [...state.value.receipts, accepted] }
      return HttpResponse.json(accepted)
    }),
    http.post(`${root}/stop`, async ({ request }) => {
      const input = ChatStopRequestSchema.parse(await request.json()); state.stops.push(input)
      if (state.loseStop) { state.loseStop = false; return HttpResponse.error() }
      return HttpResponse.json({ commandId: input.commandId, target, operation: 'stop_active', state: 'completed', affectedReceiptIds: [], replayed: state.stops.length > 1 })
    }),
  )
  return state
}
function mount(source: NativeSource, options: { visible?: boolean; nativeTurnId?: string; attachments?: ConversationAttachments;
  onOpenContinuation?: (receipt: ChatDeliveryReceipt) => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const tree = (visible = true) => <QueryClientProvider client={client}><ExecutionChatPanel visible={visible}
    target={target} name="Ava" source={source} nativeTurnId={options.nativeTurnId} attachments={options.attachments}
    onOpenContinuation={options.onOpenContinuation} /></QueryClientProvider>
  const view = render(tree(options.visible ?? true))
  return { ...view, visible: (value: boolean) => view.rerender(tree(value)) }
}
beforeEach(() => { localStorage.clear(); useConversationDraftStore.getState().clearAllDrafts() })
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

describe('exact Execution chat public surface', () => {
  it('does not observe a hidden panel and coalesces qualified native replacements without per-token reads', async () => {
    const state = endpoints(), source = new NativeSource(), view = mount(source, { visible: false })
    expect(state.reads).toBe(0); expect(source.subscriptions).toHaveLength(0)
    view.visible(true)
    await screen.findByText('Selected native answer')
    await waitFor(() => expect(state.reads).toBeGreaterThanOrEqual(2))
    expect(source.subscriptions).toHaveLength(1)
    const reads = state.reads
    act(() => { for (let revision = 2; revision <= 20; revision++) source.message({ ...initialMessage, content: `Streaming ${revision}`, revision: String(revision) }, revision) })
    expect(await screen.findByText('Streaming 20')).toBeVisible()
    expect(screen.queryByText('Selected native answer')).not.toBeInTheDocument()
    expect(state.reads).toBe(reads)
    act(() => source.message({ ...initialMessage, content: 'Stale native answer', revision: '3' }, 3))
    expect(screen.queryByText('Stale native answer')).not.toBeInTheDocument()
    view.visible(false)
    expect(source.subscriptions[0]!.close).toHaveBeenCalledOnce()
    expect(source.subscriptions[0]!.options.signal.aborted).toBe(true)
  })

  it('pins the original execution and qualified turn, selects interruption without sending, and follows successors only explicitly', async () => {
    const state = endpoints(), source = new NativeSource(), open = vi.fn()
    state.value.receipts = [{ id: 'previous-delivery', commandId: 'previous-command', target, requestedIntent: 'interrupt_and_send',
      appliedIntent: 'interrupt_and_send', state: 'completed', continuationId: 'continuation-a',
      continuationExecution: { ...target.execution, executionId: 'successor', attempt: 3 }, createdAt: date, updatedAt: date }]
    mount(source, { nativeTurnId: 'native-turn-a', onOpenContinuation: open })
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: '  change direction  ' } })
    await screen.findByRole('button', { name: 'Steer now' })
    fireEvent.change(screen.getByLabelText('Delivery action'), { target: { value: 'interrupt_and_send' } })
    expect(state.commands).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt and send' }))
    await waitFor(() => expect(state.commands).toHaveLength(1))
    expect(state.commands[0]).toMatchObject({ target, intent: 'interrupt_and_send', content: '  change direction  ', expectedNativeTurnId: 'native-turn-a' })
    expect(source.subscriptions.every(subscription => subscription.target.kind === 'workflow_execution'
      && subscription.target.execution.executionId === 'execution-a')).toBe(true)
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open continuation' }))
    expect(open).toHaveBeenCalledOnce()
  })

  it('never treats a historical native turn as current and keeps unsupported session commands as draft text', async () => {
    const state = endpoints(), source = new NativeSource(); mount(source)
    await screen.findByText('Selected native answer')
    const input = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'next message' } })
    expect(screen.getByRole('button', { name: 'Queue next' })).toBeEnabled()
    fireEvent.change(input, { target: { value: '/compact' } })
    expect(screen.queryByRole('listbox', { name: 'Chat commands' })).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(state.commands).toHaveLength(0)
    expect(input).toHaveValue('/compact')
    expect(screen.getAllByText(/Session commands are unavailable for this selected execution/).length).toBeGreaterThan(0)
  })

  it('discards an older expansion after newer committed text and immediately revokes on known source denial', async () => {
    const truncated = { ...initialMessage, content: 'Preview', truncation: { truncated: true, originalBytes: 300_000 } }
    const state = endpoints({ ...initial, messages: [truncated] }), source = new NativeSource()
    let resolve!: (value: EngineChatMessage) => void
    source.full = () => new Promise(done => { resolve = done })
    mount(source)
    fireEvent.click(await screen.findByRole('button', { name: 'Show full message' }))
    act(() => source.message({ ...initialMessage, content: 'New committed answer', revision: '2' }, 2))
    await screen.findByText('New committed answer')
    await act(async () => resolve({ ...initialMessage, content: 'Older full body' }))
    expect(screen.queryByText('Older full body')).not.toBeInTheDocument()
    server.use(http.post(`${root}/read`, () => HttpResponse.error()))
    const subscription = source.subscriptions[0]!
    act(() => subscription.options.error(new ApiError({ code: 'ACCESS_DENIED', message: 'Selected source denied' }, 403)))
    expect(await screen.findByText('Chat access unavailable')).toBeVisible()
    expect(screen.queryByText('New committed answer')).not.toBeInTheDocument()
    await waitFor(() => expect(subscription.close).toHaveBeenCalledOnce())
    expect(subscription.options.signal.aborted).toBe(true)
    const reads = state.reads
    act(() => subscription.receive({ target, revision: 3, message: { ...initialMessage, content: 'Late protected content', revision: '3' } }))
    expect(screen.queryByText('Late protected content')).not.toBeInTheDocument(); expect(state.reads).toBe(reads)
  })

  it('retries a lost active-only Stop using the identical command even without a native turn ID', async () => {
    const state = endpoints(), source = new NativeSource(); state.loseStop = true; mount(source)
    fireEvent.click(await screen.findByRole('button', { name: 'Stop active turn' }))
    await screen.findByText('Control is not confirmed.')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry original control' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Retry original control' }))
    await waitFor(() => expect(state.stops).toHaveLength(2))
    expect(state.stops[0]).toEqual(state.stops[1])
    expect(state.stops[0]).toMatchObject({ target, scope: 'active_turn', commandId: expect.any(String) })
    expect(state.stops[0]!.expectedNativeTurnId).toBeUndefined()
  })

  it('keeps newer committed rows when an ordinary read started before the stream update finishes late', async () => {
    const state = endpoints(), source = new NativeSource(); mount(source)
    await screen.findByText('Selected native answer')
    await waitFor(() => expect(state.reads).toBeGreaterThanOrEqual(2))
    let release!: () => void, waiting = false
    const gate = new Promise<void>(resolve => { release = resolve })
    server.use(http.post(`${root}/read`, async ({ request }) => {
      const input = await request.json() as { deliveryInputs?: unknown }
      if (input.deliveryInputs) return HttpResponse.json({ target, deliveryInputs: { items: [], nextCursor: null, hasMore: false, revision: 1 } })
      const snapshot = structuredClone(state.value)
      waiting = true; await gate
      return HttpResponse.json(snapshot)
    }))
    act(() => source.subscriptions[0]!.options.reconnect())
    await waitFor(() => expect(waiting).toBe(true))
    const message = { ...initialMessage, id: 'new-native-row', sequence: '2', revision: '1',
      nativeMessageId: 'native-item-b', activityNative: { ...initialMessage.activityNative!, itemId: 'native-item-b' },
      content: 'New committed native row' }
    act(() => source.message(message, 2))
    await screen.findByText('New committed native row')
    await act(async () => release())
    await screen.findByText('Could not refresh this execution.')
    expect(screen.getByText('New committed native row')).toBeVisible()
    state.value = { ...state.value, revision: 2, messages: [initialMessage, message], hasMore: true, nextCursor: 'authoritative-earlier' }
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText('Could not refresh this execution.')).not.toBeInTheDocument())
    expect(screen.getByText('New committed native row')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeEnabled()
  })

  it.each(['failed', 'unknown'] as const)('keeps the exact editable draft and file pins for a %s canonical receipt', async status => {
    const state = endpoints(), source = new NativeSource(), pins = [{ fileId: 'original-file', revisionId: 'original-revision' }]
    const acknowledge = vi.fn()
    const attachments: ConversationAttachments = {
      items: [{ id: 'selection-a', requestId: 'upload-a', filename: 'report.txt', file: new File(['body'], 'report.txt'),
        status: 'ready', statusLabel: 'Ready', canRetry: false, progress: null, ref: pins[0] }],
      readyRefs: pins, hasAttachments: true, hasBlockingAttachments: false, isUploading: false, canAdd: true, available: true,
      addFiles: vi.fn(), remove: vi.fn(), retry: vi.fn(), prepareSend: () => ({ attachments: pins }), acknowledgeSent: acknowledge,
    }
    server.use(http.post(`${root}/send`, async ({ request }) => {
      const command = ChatSendRequestSchema.parse(await request.json()); state.commands.push(command)
      const receipt: ChatDeliveryReceipt = { id: 'unadopted-receipt', commandId: command.commandId!, target,
        requestedIntent: command.intent, appliedIntent: 'next_turn', state: status, createdAt: date, updatedAt: date }
      state.value = { ...state.value, receipts: [receipt] }
      return HttpResponse.json(receipt)
    }))
    const view = mount(source, { attachments })
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: '  Keep this exact draft\nsecond line  ' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Queue next' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Queue next' }))
    await screen.findByText(status === 'failed' ? 'Failed' : 'Delivery unconfirmed')
    expect(input).toHaveValue('  Keep this exact draft\nsecond line  ')
    expect(acknowledge).not.toHaveBeenCalled()
    expect(state.commands[0]?.attachments).toEqual(pins)
    fireEvent.change(input, { target: { value: 'A newer local edit' } })
    expect(input).toHaveValue('A newer local edit')
    if (status === 'unknown') {
      fireEvent.click(screen.getByRole('button', { name: 'Retry original message' }))
      await screen.findByText('Delivery is unconfirmed. Your draft is kept; check the original command before sending again.')
      expect(state.commands).toHaveLength(1)
      expect(screen.getByRole('button', { name: 'Queue next' })).toBeDisabled()
      view.unmount(); mount(source, { attachments })
      expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('A newer local edit')
      expect(screen.getByRole('button', { name: 'Retry original message' })).toBeVisible()
      expect(state.commands).toHaveLength(1)
    }
    expect(acknowledge).not.toHaveBeenCalled()
  })
})
