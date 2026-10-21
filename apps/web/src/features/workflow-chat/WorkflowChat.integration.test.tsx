import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { WorkflowChatPostRequestSchema, type AgentIdentity, type ChatDeliveryReceipt, type WorkflowChatPost,
  type WorkflowChatPostRequest } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { WorkflowChatPanel, type WorkflowChatPanelProps } from './WorkflowChatPanel'
import { useWorkflowDraftStore } from './draft'
import type { WorkflowTargetResolver } from './RecipientTargetPicker'

const scope = { workspaceId: 'workspace-a', workflowId: 'workflow-a' }
const root = '/api/workspaces/workspace-a/workflows/workflow-a/chat'
const date = '2026-10-01T00:00:00Z'
const ava: AgentIdentity = { ...scope, workflowNodeId: 'node-a', agentId: 'agent-a',
  productRole: 'master', displayName: 'Ava', configurationVersionId: 'config-a' }
const bea: AgentIdentity = { ...ava, workflowNodeId: 'node-b', agentId: 'agent-b', productRole: 'coder', displayName: 'Bea' }
const agentRef = (agent: AgentIdentity) => ({ ...scope, workflowNodeId: agent.workflowNodeId, agentId: agent.agentId })
const outside = (agent: AgentIdentity) => ({ kind: 'agent_conversation' as const, agent: agentRef(agent), conversationId: `chat-${agent.workflowNodeId}` })
const execution = { runId: 'run-a', workflowVersionId: 'version-a', executionId: 'execution-b', activationId: 'activation-b', attempt: 1 }
const presentation = { state: 'idle' as const, capabilities: { steer: 'unavailable' as const, queue: true, interruptAndSend: true } }
const clients: QueryClient[] = []

class GroupWire extends EventTarget {
  static instances: GroupWire[] = []
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 2
  readyState = 0
  close = vi.fn(() => { this.readyState = 2 })
  constructor(readonly url: string) { super(); GroupWire.instances.push(this) }
  change(revision: number) { this.dispatchEvent(new MessageEvent('change', { data: JSON.stringify({ revision, snapshotRequired: true }) })) }
}

function post(body: string, values: Partial<WorkflowChatPost> = {}): WorkflowChatPost {
  return { ...scope, id: 'post-a', channelId: 'channel-a', sequence: 1,
    author: { kind: 'user', principalId: 'human-a', displayName: 'You' }, kind: 'message', body,
    mentions: [], cardIds: [], createdAt: date, ...values }
}
function receipt(agent: AgentIdentity, values: Partial<ChatDeliveryReceipt> = {}): ChatDeliveryReceipt {
  return { id: `receipt-${agent.workflowNodeId}`, commandId: `command-${agent.workflowNodeId}`, postId: 'post-a', target: outside(agent),
    requestedIntent: 'auto', appliedIntent: 'next_turn', state: 'accepted', createdAt: date, updatedAt: date, ...values }
}
function channel(initial: WorkflowChatPost[] = [], initialReceipts: ChatDeliveryReceipt[] = []) {
  const state = { posts: initial, receipts: initialReceipts, reads: 0, commands: [] as WorkflowChatPostRequest[] }
  server.use(
    http.get(root, ({ request }) => {
      state.reads++
      const query = new URL(request.url).searchParams, id = query.get('postId')
      return HttpResponse.json({ items: id ? state.posts.filter(item => item.id === id) : state.posts,
        nextCursor: null, hasMore: false, revision: state.posts.length })
    }),
    http.get(`${root}/deliveries`, ({ request }) => {
      const query = new URL(request.url).searchParams
      return HttpResponse.json({ items: state.receipts.filter(item => (!query.has('postId') || item.postId === query.get('postId'))
        && (!query.has('receiptId') || item.id === query.get('receiptId'))), nextCursor: null, hasMore: false, revision: state.posts.length })
    }),
    http.post(`${root}/posts`, async ({ request }) => {
      const command = WorkflowChatPostRequestSchema.parse(await request.json())
      state.commands.push(command)
      const created = post(command.body, { id: `post-${state.posts.length + 1}`, sequence: state.posts.length + 1,
        mentions: command.mentions, replyToPostId: command.replyToPostId })
      const receipts = command.deliveries.map(delivery => receipt(ava, { id: `receipt-${created.id}-${delivery.workflowNodeId}`,
        commandId: `${command.commandId}:${delivery.workflowNodeId}`, postId: created.id, target: delivery.target,
        requestedIntent: delivery.intent, appliedIntent: delivery.intent === 'auto' ? 'next_turn' : delivery.intent }))
      state.posts.push(created); state.receipts.push(...receipts)
      return HttpResponse.json({ post: created, receipts, replayed: false })
    }),
  )
  return state
}
function mount(overrides: Partial<WorkflowChatPanelProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const resolver: WorkflowTargetResolver = async agent => [{ target: outside(agent), label: 'Outside run', presentation }]
  function Panel({ visible }: { visible: boolean }) {
    const [selection, setSelection] = useState<WorkflowChatPanelProps['selection']>(overrides.selection ?? {})
    return <WorkflowChatPanel {...scope} visible={visible} participants={[ava, bea]} resolveTargets={resolver}
      selection={selection} onSelectionChange={setSelection} {...overrides} />
  }
  const tree = (visible: boolean) => <QueryClientProvider client={client}><Panel visible={visible} /></QueryClientProvider>
  const rendered = render(tree(overrides.visible ?? true))
  return { ...rendered, visible: (value: boolean) => rendered.rerender(tree(value)) }
}
function typeAtEnd(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value, selectionStart: value.length } })
}

beforeEach(() => {
  GroupWire.instances = []; vi.stubGlobal('EventSource', GroupWire)
  localStorage.clear(); useConversationDraftStore.getState().clearAllDrafts()
  useWorkflowDraftStore.setState({ records: {}, scroll: {} })
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })

describe('Group chat public surface', () => {
  it('posts a plain message through the mounted panel using only the workflow request fields', async () => {
    const state = channel()
    mount()
    typeAtEnd(screen.getByRole('combobox', { name: 'Message this workflow' }), 'Report progress')
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(state.commands).toHaveLength(1))
    expect(state.commands[0]).toEqual({ ...scope, commandId: expect.any(String), body: 'Report progress',
      mentions: [], deliveries: [], cardIds: [] })
    expect(await screen.findByText('Report progress')).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Message this workflow' })).toHaveValue('')
  })

  it('performs no hidden reads and closes its single channel stream on hide and unmount', async () => {
    const state = channel(), view = mount({ visible: false })
    expect(state.reads).toBe(0); expect(GroupWire.instances).toHaveLength(0)
    // Mount a visible destination independently: the shell disposes the hidden panel.
    view.unmount()
    const opened = mount()
    await screen.findByText('No messages yet. Mention an agent to start a conversation.')
    expect(GroupWire.instances).toHaveLength(1)
    const source = GroupWire.instances[0]!
    opened.visible(false)
    expect(source.close).toHaveBeenCalledOnce()
    const reads = state.reads
    act(() => source.change(10))
    expect(state.reads).toBe(reads)
    opened.visible(true)
    await waitFor(() => expect(GroupWire.instances).toHaveLength(2))
    opened.unmount()
    expect(GroupWire.instances[1]!.close).toHaveBeenCalledOnce()
  })

  it('posts exact UTF-16 resolved chips once per node, and selecting delivery never submits', async () => {
    const state = channel(); mount()
    const input = screen.getByRole('combobox', { name: 'Message this workflow' })
    typeAtEnd(input, '  😀 hello @')
    fireEvent.click(await screen.findByRole('option', { name: 'Ava · Master · node-a' }))
    typeAtEnd(input, `${(input as HTMLTextAreaElement).value}and @`)
    fireEvent.click(await screen.findByRole('option', { name: 'Ava · Master · node-a' }))
    typeAtEnd(input, `${(input as HTMLTextAreaElement).value} \n`)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Post' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Delivery for Ava'), { target: { value: 'next_turn' } })
    expect(state.commands).toHaveLength(0)
    const body = (input as HTMLTextAreaElement).value
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(state.commands).toHaveLength(1))
    expect(state.commands[0]).toMatchObject({ body, deliveries: [{ workflowNodeId: ava.workflowNodeId, target: outside(ava), intent: 'next_turn' }],
      mentions: [{ workflowNodeId: ava.workflowNodeId, start: body.indexOf('@Ava'), end: body.indexOf('@Ava') + 4 },
        { workflowNodeId: ava.workflowNodeId, start: body.lastIndexOf('@Ava'), end: body.lastIndexOf('@Ava') + 4 }] })
    expect(body.startsWith('  😀')).toBe(true); expect(body.endsWith(' \n')).toBe(true)
    expect(state.commands[0]!.deliveries).toHaveLength(1)
  })

  it('keeps unresolved @ text as a plain post with no recipient', async () => {
    const state = channel(); mount()
    typeAtEnd(screen.getByRole('combobox', { name: 'Message this workflow' }), '  notes for @unresolved  ')
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(state.commands).toHaveLength(1))
    expect(state.commands[0]).toMatchObject({ body: '  notes for @unresolved  ', mentions: [], deliveries: [] })
  })

  it('recovers only the settled recipient, keeps Group origin, and preserves a separate draft', async () => {
    const original = post('@Ava and @Bea', { mentions: [{ workflowNodeId: ava.workflowNodeId, start: 0, end: 4 },
      { workflowNodeId: bea.workflowNodeId, start: 9, end: 13 }] })
    const failed = receipt(bea, { state: 'failed', errorCode: 'TARGET_SETTLED',
      target: { kind: 'workflow_execution', agent: agentRef(bea), execution } })
    const state = channel([original], [receipt(ava), failed])
    const resolveTargets = vi.fn<WorkflowTargetResolver>(async agent => [{ target: outside(agent), label: 'Outside run', presentation }])
    mount({ resolveTargets })
    typeAtEnd(screen.getByRole('combobox', { name: 'Message this workflow' }), 'Separate pending draft')
    fireEvent.click(await screen.findByRole('button', { name: 'Send outside run' }))
    expect(screen.getByText(/Reply will appear in Group chat/)).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Post' })).toBeEnabled())
    expect(resolveTargets).toHaveBeenCalledWith(bea, expect.objectContaining({ recovery: 'outside_run', sourceTarget: failed.target }))
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(state.commands).toHaveLength(1))
    expect(state.commands[0]).toMatchObject({ body: original.body, replyToPostId: original.id,
      mentions: [original.mentions[1]], deliveries: [{ workflowNodeId: bea.workflowNodeId, target: outside(bea), intent: 'auto' }] })
    expect(state.commands[0]!.deliveries).toHaveLength(1)
    expect(state.receipts.find(item => item.id === 'receipt-node-a')?.state).toBe('accepted')
    fireEvent.click(screen.getByRole('button', { name: 'Back to saved draft' }))
    expect(screen.getByRole('combobox', { name: 'Message this workflow' })).toHaveValue('Separate pending draft')
  })

  it('refreshes a receipt-only selected post from the same channel invalidation', async () => {
    const original = post('A pinned post'), delivery = receipt(ava)
    const state = channel([original], [delivery])
    mount({ selection: { receiptId: delivery.id } })
    await screen.findByLabelText('Selected post')
    await screen.findByText('A pinned post')
    state.receipts = [{ ...delivery, state: 'failed', errorCode: 'TARGET_SETTLED' }]
    act(() => GroupWire.instances[0]!.change(2))
    expect(await screen.findByText('Not sent — selected turn ended')).toBeVisible()
  })

  it('preserves an edit-away-and-back draft when an earlier post is confirmed', async () => {
    const state = channel()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    server.use(http.post(`${root}/posts`, async ({ request }) => {
      const command = WorkflowChatPostRequestSchema.parse(await request.json())
      state.commands.push(command)
      const created = post(command.body); state.posts.push(created)
      await gate
      return HttpResponse.json({ post: created, receipts: [], replayed: false })
    }))
    mount()
    const input = screen.getByRole('combobox', { name: 'Message this workflow' })
    typeAtEnd(input, 'Exact draft')
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(state.commands).toHaveLength(1))
    typeAtEnd(input, 'New revision of draft'); typeAtEnd(input, 'Exact draft')
    await act(async () => release())
    await waitFor(() => expect(screen.queryByText('Posting is not yet confirmed.')).not.toBeInTheDocument())
    expect(input).toHaveValue('Exact draft')
    expect(state.commands[0]!.body).toBe('Exact draft')
  })

  it('reads retained status before explicitly retrying a lost response with the original command', async () => {
    const state = channel(), operations: string[] = []
    server.use(
      http.get(root, ({ request }) => {
        const query = new URL(request.url).searchParams
        if (query.has('commandId')) operations.push(`read:${query.get('commandId')}`)
        return HttpResponse.json({ items: state.posts, nextCursor: null, hasMore: false, revision: state.posts.length })
      }),
      http.get(`${root}/deliveries`, ({ request }) => {
        const query = new URL(request.url).searchParams
        if (query.has('commandId')) operations.push(`receipts:${query.get('commandId')}`)
        return HttpResponse.json({ items: [], nextCursor: null, hasMore: false, revision: 0 })
      }),
      http.post(`${root}/posts`, async ({ request }) => {
        const command = WorkflowChatPostRequestSchema.parse(await request.json())
        operations.push(`post:${command.commandId}`); state.commands.push(command)
        if (state.commands.length === 1) return HttpResponse.error()
        const created = post(command.body); state.posts.push(created)
        return HttpResponse.json({ post: created, receipts: [], replayed: false })
      }),
    )
    mount()
    const input = screen.getByRole('combobox', { name: 'Message this workflow' })
    typeAtEnd(input, 'Retain this uncertain input')
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry original message' })).toBeEnabled())
    expect(input).toHaveValue('Retain this uncertain input')
    fireEvent.click(screen.getByRole('button', { name: 'Retry original message' }))
    await waitFor(() => expect(state.commands).toHaveLength(2))
    expect(state.commands[0]).toEqual(state.commands[1])
    const command = state.commands[0]!.commandId
    expect(operations[0]).toBe(`post:${command}`)
    expect(operations.slice(1, -1).sort()).toEqual([`read:${command}`, `receipts:${command}`].sort())
    expect(operations.at(-1)).toBe(`post:${command}`)
  })
})
