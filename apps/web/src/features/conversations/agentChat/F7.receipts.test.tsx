import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { agentChatFixtures, type AgentChatState, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { AgentChatPanel } from '../../graph/AgentPanels'
import { server } from '../../../mocks/server'
import { useConversationDraftStore } from '../conversationDraftStore'
import { agentChatContextKey, deliveryLabels } from './model'
import { AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT, compactAgentChatResult, retireAgentChatAcknowledgements } from './commandRecords'
import { AgentChatTestSource, installChatSource, mountChat } from './testSupport'
import { completedFixture, startedFixture } from './f7.testSupport'

const clients: ReturnType<typeof mountChat>['client'][] = []
const write = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value } })
const sends = (mounted: ReturnType<typeof mountChat>) => mounted.mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/messages'))
const reopen = (mounted: ReturnType<typeof mountChat>) => render(<QueryClientProvider client={mounted.client}>
  <AgentChatPanel name="Coder" context={agentChatFixtures.empty.context} />
</QueryClientProvider>)
afterEach(() => { clients.splice(0).forEach((client) => client.clear()); useConversationDraftStore.getState().clearAllDrafts(); vi.unstubAllGlobals() })

describe('F7 B-R07 compact command retention', () => {
  it.each(['missing', 'completed'] as const)('recovers the original send after a lost response and full client recreation (%s receipt)', async receipt => {
    const mounted = mountChat(agentChatFixtures.idleAfterCompletion)
    clients.push(mounted.client)
    await mounted.ready()
    write('Keep original request after reload')
    let original: SendAgentChatMessageRequest | undefined
    let posts = 0
    server.use(http.post('/api/workspaces/:workspaceId/agent-chat/messages', async ({ request }) => {
      posts++
      original = await request.json() as SendAgentChatMessageRequest
      return HttpResponse.error()
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByLabelText('Unknown')
    expect(original).toBeDefined()
    const queued = structuredClone(agentChatFixtures.idleAfterCompletion)
    const turn = { ...queued.turns[0]!, requestId: original!.requestId, messageId: 'reload-message',
      sequence: '2', delivery: 'queued' as const, intent: original!.intent }
    queued.turns.push(turn)
    queued.messages.push({ id: turn.messageId, conversationId: queued.conversation!.id, role: 'user',
      requestId: original!.requestId, content: original!.content, createdAt: queued.messages[0]!.createdAt })
    const next = receipt === 'completed'
      ? completedFixture(startedFixture(queued, original!.requestId), 'Recovered reply')
      : agentChatFixtures.idleAfterCompletion
    mounted.unmount()
    mounted.client.clear()
    const reloaded = mountChat(next)
    clients.push(reloaded.client)
    await reloaded.ready()
    expect(reloaded.client.getMutationCache().getAll()[0]?.state.variables).toMatchObject({
      kind: 'send', input: { requestId: original!.requestId, content: original!.content },
    })
    if (receipt === 'completed') {
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
    } else {
      await screen.findByLabelText('Unknown')
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' })
      await screen.findByText(/Delivery is unknown/)
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(original!.content)
    }
    expect(posts).toBe(1)
    expect(sends(reloaded)).toHaveLength(0)
  })
  it('bounds completed commands across close/reopen without retaining complete response snapshots', async () => {
    const mounted = mountChat(agentChatFixtures.idleAfterCompletion); clients.push(mounted.client)
    await mounted.ready()
    const total = AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT + 5
    for (let index = 0; index < total; index++) {
      write(`Acknowledged command ${index}`)
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
      await waitFor(() => expect(sends(mounted)).toHaveLength(index + 1))
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
      const input = sends(mounted)[index]!.body as SendAgentChatMessageRequest
      mounted.mock.setState(completedFixture(startedFixture(mounted.mock.getState(agentChatFixtures.empty.context), input.requestId), `Reply ${index}`))
      await act(() => mounted.refresh())
      await screen.findAllByLabelText('Completed').then(items => items.at(-1)!)
    }
    await waitFor(() => expect(mounted.client.getMutationCache().getAll()).toHaveLength(AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT))
    for (const command of mounted.client.getMutationCache().getAll()) {
      expect(command.state.status).toBe('success')
      expect(command.state.data).not.toHaveProperty('state')
      expect(Object.keys(command.state.data as object).sort()).toEqual(['conversationId', 'replayed', 'turn'])
    }
    mounted.unmount(); reopen(mounted)
    await screen.findAllByLabelText('Completed').then(items => items.at(-1)!)
    expect(sends(mounted)).toHaveLength(total)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    expect(mounted.client.getMutationCache().getAll()).toHaveLength(AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT)
  }, 30_000)

  it('keeps a pending then lost-acknowledgement command across close/reopen without auto-resubmission', async () => {
    const mounted = mountChat(); clients.push(mounted.client); await mounted.ready(); write('Keep uncertain input')
    let release!: () => void, posts = 0
    const gate = new Promise<void>((resolve) => { release = resolve })
    server.use(http.post('/api/workspaces/:workspaceId/agent-chat/messages', async () => {
      posts++; await gate; return HttpResponse.error()
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(posts).toBe(1))
    const command = mounted.client.getMutationCache().getAll()[0]!
    mounted.unmount(); retireAgentChatAcknowledgements(mounted.client)
    expect(command.state.status).toBe('pending')
    expect(mounted.client.getMutationCache().getAll()).toContain(command)
    release()
    await waitFor(() => expect(command.state.status).toBe('error'))
    retireAgentChatAcknowledgements(mounted.client); reopen(mounted)
    await screen.findByLabelText('Unknown')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep uncertain input')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' })
    await screen.findByText('Delivery is unknown. Use “Send again as new message” and review the warning.')
    expect(posts).toBe(1)
    expect(command.state.variables).toMatchObject({ kind: 'send', input: { content: 'Keep uncertain input' } })
  })

  it('retains unknown input with no message text in state while bounding acknowledged controls', async () => {
    const state: AgentChatState = { ...structuredClone(agentChatFixtures.unknownDelivery), messages: [] }
    const mounted = mountChat(state); clients.push(mounted.client); await mounted.ready()
    const key = ['agent-chat', 0, agentChatContextKey(state.context), 'command'] as const
    const result = compactAgentChatResult({ state, turn: state.turns[0]!, replayed: false })
    const original = mounted.client.getMutationCache().build(mounted.client, { mutationKey: key, mutationFn: async (input: unknown) => { void input; return result } })
    await original.execute({ kind: 'send', clearDraft: true, input: { requestId: 'request-1', content: 'Original unknown input' } })
    for (let index = 0; index < 40; index++) {
      const control = mounted.client.getMutationCache().build(mounted.client, { mutationKey: key, mutationFn: async () => compactAgentChatResult({ state }) })
      await control.execute(undefined)
      retireAgentChatAcknowledgements(mounted.client)
    }
    expect(mounted.client.getMutationCache().getAll()).toContain(original)
    expect(original.state.variables).toMatchObject({ input: { content: 'Original unknown input' } })
    expect(original.state.data).not.toHaveProperty('state')
    expect(mounted.client.getMutationCache().getAll()).toHaveLength(AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT + 1)
    expect(sends(mounted)).toHaveLength(0)
  })
})

describe('F7 B-R08 current receipt status', () => {
  for (const transport of ['GET', 'SSE'] as const) {
    it.each(['completed', 'failed', 'canceled', 'unknown'] as const)(`${transport}: queued acknowledgement follows current %s delivery`, async (delivery) => {
      if (transport === 'SSE') installChatSource()
      const mounted = mountChat(agentChatFixtures.active); clients.push(mounted.client); await mounted.ready(); write('Later turn')
      await userEvent.click(screen.getByRole('button', { name: 'Queue message' }))
      await screen.findAllByLabelText('Queued').then(items => items.at(-1)!)
      const input = sends(mounted)[0]!.body as SendAgentChatMessageRequest
      const next = structuredClone(mounted.mock.getState(agentChatFixtures.empty.context))
      next.turns = next.turns.map((turn) => ({ ...turn, delivery: turn.requestId === input.requestId ? delivery : 'completed' }))
      next.activeTurn = null; next.sessionState = delivery === 'unknown' ? 'uncertain' : 'idle'; next.revision++
      mounted.mock.setState(next)
      if (transport === 'GET') await act(() => mounted.refresh())
      else {
        await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
        act(() => AgentChatTestSource.instances[0]!.snapshot(next, 20))
      }
      await screen.findAllByLabelText(deliveryLabels[delivery]).then(items => items.at(-1)!)
      expect(screen.queryAllByLabelText('Queued')).toHaveLength(0)
      expect(sends(mounted)).toHaveLength(1)
    })
  }

  it('labels the acknowledgement as historical when the matching receipt leaves the state window', async () => {
    const mounted = mountChat(agentChatFixtures.idleAfterCompletion); clients.push(mounted.client); await mounted.ready(); write('An old receipt')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findAllByLabelText('Queued').then(items => items.at(-1)!)
    const input = sends(mounted)[0]!.body as SendAgentChatMessageRequest
    const next = completedFixture(startedFixture(mounted.mock.getState(agentChatFixtures.empty.context), input.requestId), 'Completed before aging out')
    mounted.mock.setState(next); await act(() => mounted.refresh())
    await screen.findAllByLabelText('Completed').then(items => items.at(-1)!)
    next.turns = []; next.revision++
    mounted.mock.setState(next); await act(() => mounted.refresh())
    await userEvent.hover((await screen.findAllByLabelText('Completed')).at(-1)!)
    expect(await screen.findByText(/Initial acknowledgement: Queued/, { selector: '[role=tooltip]' })).toBeInTheDocument()
    expect(screen.queryAllByLabelText('Queued')).toHaveLength(0)
  })
})
