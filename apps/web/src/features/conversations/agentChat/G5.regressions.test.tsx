import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { AgentChatStateSchema, agentChatFixtures, type AgentChatState, type AgentChatTurn, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { AgentChatPanel } from '../../graph/AgentPanels'
import { useConversationDraftStore } from '../conversationDraftStore'
import { agentChatStateKey } from './useAgentChat'
import { claimDraftReadback, receiptForCommand } from './receiptReadback'
import { AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT, agentChatReadbacksKey, compactAgentChatResult, confirmedCommandReceipt,
  isRetirableAcknowledgement, rememberAgentChatReadback, retireAgentChatAcknowledgements,
  type AgentChatCommand, type AgentChatCommandRecord, type AgentChatReadbacks } from './commandRecords'
import { AgentChatTestSource, chatTooltip, installChatSource, mountChat } from './testSupport'

const messagePath = '/api/workspaces/:workspaceId/agent-chat/messages'
const clients: QueryClient[] = []
const write = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value } })
const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
function sendCommand(state: AgentChatState, requestId: string, intent: SendAgentChatMessageRequest['intent'] = 'next_turn'): Extract<AgentChatCommand, { kind: 'send' }> {
  const { workflowId, workflowNodeId, agentId, runId } = state.context
  return { kind: 'send', clearDraft: true, input: { requestId, intent, content: `Input ${requestId}`,
    context: { workflowId, workflowNodeId, agentId, ...(runId ? { runId } : {}) }, expectedConversationId: state.conversation!.id,
    ...(intent === 'steer' ? { expectedNativeTurnId: state.activeTurn!.nativeTurnId! } : {}) } }
}
function withReceipt(initial: AgentChatState, input: SendAgentChatMessageRequest, delivery: AgentChatTurn['delivery']): AgentChatState {
  const state = structuredClone(initial)
  const turn: AgentChatTurn = { ...state.turns[0]!, requestId: input.requestId, messageId: `message-${input.requestId}`,
    intent: input.intent, delivery, sequence: '10' }
  state.turns.push(turn)
  state.messages.push({ id: turn.messageId, requestId: input.requestId, conversationId: state.conversation!.id, role: 'user', content: input.content })
  state.revision += 10
  return AgentChatStateSchema.parse(state)
}
/** A valid latest-50-terminal / latest-100-message window, after other callers have finished turns. */
function laterWindow(initial: AgentChatState): AgentChatState {
  const state = structuredClone(initial), template = state.turns[0]!
  state.turns = Array.from({ length: 50 }, (_, index): AgentChatTurn => ({ ...template, requestId: `later-${index}`,
    messageId: `later-message-${index}`, sequence: String(index + 100), intent: 'next_turn', delivery: 'completed' }))
  state.messages = state.turns.flatMap((turn) => [
    { id: turn.messageId, requestId: turn.requestId, conversationId: state.conversation!.id, role: 'user' as const, content: `Later input ${turn.sequence}` },
    { id: `reply-${turn.messageId}`, requestId: turn.requestId, conversationId: state.conversation!.id, role: 'assistant' as const, content: `Later reply ${turn.sequence}`, nativeMessageComplete: true },
  ])
  state.activeTurn = null; state.activities = []; state.sessionState = 'idle'; state.hasEarlierMessages = true; state.revision += 100
  return AgentChatStateSchema.parse(state)
}
const proofFor = (client: QueryClient, id: number) => client.getQueryData<AgentChatReadbacks>(agentChatReadbacksKey)?.[id]
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear())
  useConversationDraftStore.getState().clearAllDrafts()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('G5 B2-PF-01 / B-R01 provisional steer', () => {
  it.each([false, true])('GET submitting -> definite 409 keeps the draft (edited during wait: %s)', async (edited) => {
    const initial = structuredClone(agentChatFixtures.active), mounted = mountChat(initial)
    clients.push(mounted.client); await mounted.ready()
    const post = gate(), sent: SendAgentChatMessageRequest[] = []
    server.use(http.post(messagePath, async ({ request }) => {
      sent.push(await request.json() as SendAgentChatMessageRequest)
      await post.promise
      return HttpResponse.json({ error: { code: 'AGENT_CHAT_TURN_NOT_ACTIVE', message: 'The turn finished before the steer arrived.' } }, { status: 409 })
    }))
    try {
      write('Original steering instruction')
      await userEvent.click(screen.getByRole('button', { name: /^Steer$/ }))
      await waitFor(() => expect(sent).toHaveLength(1))
      expect(sent[0]).toMatchObject({ intent: 'steer', expectedNativeTurnId: initial.activeTurn!.nativeTurnId })
      if (edited) write('A newer draft written while waiting')
      const pending = withReceipt(initial, sent[0]!, 'submitting')
      mounted.mock.setState(pending); await act(() => mounted.refresh())
      await screen.findAllByLabelText('Sending').then(items => items.at(-1)!)
      const expectedDraft = edited ? 'A newer draft written while waiting' : 'Original steering instruction'
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(expectedDraft)
      const rejected = structuredClone(agentChatFixtures.idleAfterCompletion)
      rejected.revision = pending.revision + 1
      mounted.mock.setState(rejected)
      await act(async () => { post.release() })
      await screen.findByRole('button', { name: 'Send as next turn' })
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send as next turn' })).toBeEnabled())
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(expectedDraft)
      expect(screen.queryByRole('button', { name: 'Send again as new message' })).not.toBeInTheDocument()
      expect(mounted.client.getQueryData<AgentChatState>(agentChatStateKey(initial.context))?.turns.some((turn) => turn.requestId === sent[0]!.requestId)).toBe(false)
      expect(sent).toHaveLength(1)
    } finally { post.release() }
  })

  it('provisional readback does not consume the later accepted-steer draft claim', () => {
    const state = agentChatFixtures.active, command = sendCommand(state, 'accepted-steer', 'steer')
    const receipt = withReceipt(state, command.input, 'submitting').turns.at(-1)!
    expect(claimDraftReadback(command, receipt)).toBe(false)
    expect(claimDraftReadback(command, receipt)).toBe(false)
    expect(claimDraftReadback(command, { ...receipt, delivery: 'accepted' })).toBe(true)
    expect(claimDraftReadback(command, { ...receipt, delivery: 'completed' })).toBe(false)
  })
})

describe('G5 B2-PF-02 / B-R01 terminal readback survives eviction', () => {
  for (const transport of ['GET', 'SSE'] as const) {
    it.each([false, true])(`${transport}: no resurrected Unknown or resend after eviction (HTTP error arrives last: %s)`, async (lateError) => {
      if (transport === 'SSE') installChatSource()
      const initial = structuredClone(agentChatFixtures.idleAfterCompletion), mounted = mountChat(initial)
      clients.push(mounted.client); await mounted.ready()
      if (transport === 'SSE') await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
      const post = gate(), sent: SendAgentChatMessageRequest[] = []
      server.use(http.post(messagePath, async ({ request }) => {
        sent.push(await request.json() as SendAgentChatMessageRequest)
        await post.promise; return HttpResponse.error()
      }))
      try {
        write('Completed despite a lost HTTP response')
        await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
        await waitFor(() => expect(sent).toHaveLength(1))
        if (!lateError) {
          await act(async () => { post.release() })
          await screen.findByLabelText('Unknown')
        }
        const recovered = withReceipt(initial, sent[0]!, 'completed')
        mounted.mock.setState(recovered)
        if (transport === 'GET') await act(() => mounted.refresh())
        else act(() => AgentChatTestSource.instances[0]!.snapshot(recovered, 20))
        await screen.findAllByLabelText('Completed').then(items => items.at(-1)!)
        await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
        const command = mounted.client.getMutationCache().getAll()[0]!
        expect(proofFor(mounted.client, command.mutationId)).toMatchObject({ conversationId: initial.conversation!.id,
          turn: { requestId: sent[0]!.requestId, delivery: 'completed' } })
        const later = laterWindow(recovered)
        mounted.mock.setState(later); await act(() => mounted.refresh())
        if (lateError) await act(async () => { post.release() })
        await waitFor(() => expect(command.state.status).toBe('error'))
        await screen.findAllByLabelText('Completed').then(items => items.at(-1)!)
        expect(screen.queryAllByLabelText('Unknown')).toHaveLength(0)
        expect(screen.queryAllByLabelText('Unknown')).toHaveLength(0)
        expect(screen.queryAllByLabelText('Unknown')).toHaveLength(0)
        expect(screen.queryByRole('button', { name: 'Send again as new message' })).not.toBeInTheDocument()
        expect(command.state.data).toBeUndefined() // Retain the actual HTTP outcome, not a fabricated success.
        expect(sent).toHaveLength(1)
        mounted.unmount()
        render(<QueryClientProvider client={mounted.client}><AgentChatPanel name="Coder" context={initial.context} /></QueryClientProvider>)
        await screen.findAllByLabelText('Completed').then(items => items.at(-1)!)
        expect(screen.queryAllByLabelText('Unknown')).toHaveLength(0)
        expect(screen.queryAllByLabelText('Unknown')).toHaveLength(0)
        // A new equal-text draft is intentional; replayed proof must not erase it or warn as unknown.
        write(sent[0]!.content)
        mounted.mock.setState({ ...later, revision: later.revision + 1 }); await act(() => mounted.refresh())
        expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(sent[0]!.content)
        expect(sent).toHaveLength(1)
      } finally { post.release() }
    })
  }

  it('captures terminal SSE proof even when completion and eviction are batched before a render', async () => {
    installChatSource()
    const initial = structuredClone(agentChatFixtures.idleAfterCompletion), mounted = mountChat(initial)
    clients.push(mounted.client); await mounted.ready()
    await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
    const sent: SendAgentChatMessageRequest[] = []
    server.use(http.post(messagePath, async ({ request }) => { sent.push(await request.json() as SendAgentChatMessageRequest); return HttpResponse.error() }))
    write('Recovered between renders'); await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByLabelText('Unknown')
    const terminal = withReceipt(initial, sent[0]!, 'completed'), later = laterWindow(terminal)
    mounted.mock.setState(later)
    act(() => {
      AgentChatTestSource.instances[0]!.snapshot(terminal, 20)
      AgentChatTestSource.instances[0]!.snapshot(later, 21)
    })
    await screen.findAllByLabelText('Completed').then(items => items.at(-1)!)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
    expect(screen.queryAllByLabelText('Unknown')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Send again as new message' })).not.toBeInTheDocument()
    expect(sent).toHaveLength(1)
  })

  it('keeps initial queued acknowledgement historical while displaying retained completion after eviction', async () => {
    const initial = structuredClone(agentChatFixtures.idleAfterCompletion), mounted = mountChat(initial)
    clients.push(mounted.client); await mounted.ready()
    const sent: SendAgentChatMessageRequest[] = []
    server.use(http.post(messagePath, async ({ request }) => {
      const input = await request.json() as SendAgentChatMessageRequest; sent.push(input)
      const state = withReceipt(initial, input, 'queued'); mounted.mock.setState(state)
      return HttpResponse.json({ state, turn: state.turns.at(-1), replayed: false })
    }))
    write('Initially queued'); await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findAllByLabelText('Queued').then(items => items.at(-1)!)
    const completed = withReceipt(initial, sent[0]!, 'completed'); completed.revision++
    mounted.mock.setState(completed); await act(() => mounted.refresh())
    // After eviction the retired queued acknowledgement stays hidden; the retained completion is shown.
    const later = laterWindow(completed); mounted.mock.setState(later); await act(() => mounted.refresh())
    const history = await screen.findByRole('region', { name: 'Messages outside the current history page' })
    const original = within(history).getByText('Initially queued').closest('article')!
    expect(await chatTooltip(within(original).getByLabelText('Completed')))
      .toHaveTextContent('Initial acknowledgement: Queued')
    expect(screen.queryAllByLabelText('Queued')).toHaveLength(0)
    const mutation = mounted.client.getMutationCache().getAll()[0]!
    expect(isRetirableAcknowledgement({ status: mutation.state.status, result: mutation.state.data as AgentChatCommandRecord['result'],
      readback: proofFor(mounted.client, mutation.mutationId) }, later)).toBe(true)
    expect(sent).toHaveLength(1)
  })
})

describe('G5 B2-PF-02 / B-R07 compact recovered-command retirement', () => {
  it('bounds more than 20 recovered errors and queued successes after eviction, preserving genuinely unresolved commands', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false, gcTime: Infinity } } })
    clients.push(client)
    const initial = structuredClone(agentChatFixtures.idleAfterCompletion), key = agentChatStateKey(initial.context)
    const mutationKey = [...key.slice(0, 3), 'command']
    const failedTransport = async (command: AgentChatCommand) => { void command; throw new Error('HTTP response lost') }
    const unresolved = client.getMutationCache().build(client, { mutationKey, mutationFn: failedTransport })
    await unresolved.execute(sendCommand(initial, 'still-unconfirmed')).catch(() => undefined)
    const unknownCommand = sendCommand(initial, 'still-unknown'), unknownState = withReceipt(initial, unknownCommand.input, 'unknown')
    const unknown = client.getMutationCache().build(client, { mutationKey, mutationFn: async (input: AgentChatCommand) => { void input; return compactAgentChatResult({
      state: unknownState, turn: unknownState.turns.at(-1)!, replayed: false }) } })
    await unknown.execute(unknownCommand)
    rememberAgentChatReadback(client, key, unknownState)
    const pendingGate = gate(), pendingCommand = sendCommand(initial, 'still-pending')
    const pending = client.getMutationCache().build(client, { mutationKey, mutationFn: async (input: AgentChatCommand) => { void input; await pendingGate.promise; throw new Error('Unconfirmed') } })
    const pendingResult = pending.execute(pendingCommand).catch(() => undefined)
    try {
      for (let index = 0; index < AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT + 13; index++) {
        const command = sendCommand(initial, `recovered-${index}`), queued = withReceipt(initial, command.input, 'queued')
        const mutation = client.getMutationCache().build(client, { mutationKey,
          mutationFn: async (input: AgentChatCommand) => {
            void input
            if (index % 5 !== 0) throw new Error('HTTP response lost')
            return compactAgentChatResult({ state: queued, turn: queued.turns.at(-1)!, replayed: false })
          } })
        await mutation.execute(command).catch(() => undefined)
        const delivery = (['completed', 'failed', 'canceled'] as const)[index % 3]!
        const terminal = withReceipt(initial, command.input, delivery)
        client.setQueryData(key, terminal); rememberAgentChatReadback(client, key, terminal)
        expect(proofFor(client, mutation.mutationId)?.turn.delivery).toBe(delivery)
        client.setQueryData(key, laterWindow(terminal))
        retireAgentChatAcknowledgements(client)
      }
      const retained = client.getMutationCache().getAll()
      expect(retained).toHaveLength(AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT + 3)
      expect(retained).toContain(unresolved); expect(retained).toContain(unknown); expect(retained).toContain(pending)
      expect(unresolved.state.variables).toMatchObject({ input: { content: 'Input still-unconfirmed' } })
      expect(pending.state.status).toBe('pending')
      const proofs = client.getQueryData<AgentChatReadbacks>(agentChatReadbacksKey)!
      expect(Object.keys(proofs)).toHaveLength(AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT)
      expect(proofFor(client, unresolved.mutationId)).toBeUndefined()
      expect(proofFor(client, unknown.mutationId)).toBeUndefined()
      expect(proofFor(client, pending.mutationId)).toBeUndefined()
      for (const mutation of retained.filter((entry) => proofs[entry.mutationId])) {
        const proof = proofs[mutation.mutationId]!
        expect(Object.keys(proof).sort()).toEqual(['conversationId', 'turn'])
        expect(proof).not.toHaveProperty('state'); expect(proof).not.toHaveProperty('messages'); expect(proof).not.toHaveProperty('activities')
        if (mutation.state.status === 'success') {
          expect(Object.keys(mutation.state.data as object).sort()).toEqual(['conversationId', 'replayed', 'turn'])
          expect(mutation.state.data).toMatchObject({ turn: { delivery: 'queued' } })
        } else expect(mutation.state.status).toBe('error')
      }
      // Removing the owning commands also retires the compact proof, not just the full result.
      retained.filter((entry) => proofs[entry.mutationId]).forEach((entry) => client.getMutationCache().remove(entry))
      retireAgentChatAcknowledgements(client)
      expect(client.getQueryData(agentChatReadbacksKey)).toEqual({})
    } finally { pendingGate.release(); await pendingResult }
  })

  it('fences captured proof by context, conversation, request, QueryClient and session key', async () => {
    const client = new QueryClient(), otherClient = new QueryClient(); clients.push(client, otherClient)
    const state = structuredClone(agentChatFixtures.idleAfterCompletion), key = agentChatStateKey(state.context)
    const command = sendCommand(state, 'fenced-proof')
    const mutation = client.getMutationCache().build(client, { mutationKey: [...key.slice(0, 3), 'command'],
      mutationFn: async (input: AgentChatCommand) => { void input; throw new Error('lost') } })
    await mutation.execute(command).catch(() => undefined)
    const terminal = withReceipt(state, command.input, 'completed')
    rememberAgentChatReadback(client, [key[0], Number(key[1]) + 1, key[2], key[3]], terminal)
    rememberAgentChatReadback(client, key, { ...terminal, context: { ...terminal.context, agentId: 'another-agent' } })
    rememberAgentChatReadback(client, key, { ...terminal, conversation: { ...terminal.conversation!, id: 'replacement' } })
    rememberAgentChatReadback(client, key, { ...terminal, turns: terminal.turns.filter((turn) => turn.requestId !== command.input.requestId) })
    expect(proofFor(client, mutation.mutationId)).toBeUndefined()
    rememberAgentChatReadback(client, key, terminal)
    expect(otherClient.getQueryData(agentChatReadbacksKey)).toBeUndefined()
    const record: AgentChatCommandRecord = { command, status: 'error', error: new Error('lost'), result: undefined,
      submittedAt: 1, readback: proofFor(client, mutation.mutationId) }
    expect(confirmedCommandReceipt(record, laterWindow(terminal))?.delivery).toBe('completed')
    expect(confirmedCommandReceipt(record, undefined)).toBeUndefined()
    expect(confirmedCommandReceipt(record, { ...terminal, conversation: { ...terminal.conversation!, id: 'replacement' } })).toBeUndefined()
    expect(confirmedCommandReceipt({ ...record, command: sendCommand(state, 'different-request') }, terminal)).toBeUndefined()
    expect(confirmedCommandReceipt(record, { ...terminal, context: { ...terminal.context, runId: 'another-run' } })).toBeUndefined()
    expect(receiptForCommand(terminal, { ...command, input: { ...command.input, context: { ...command.input.context, workflowId: 'another-workflow' } } })).toBeUndefined()
  })
})
