import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivitySnapshotV1, InteractionSummary, Message } from '@foreman-code/contracts'
import { agentChatFixtures, type AgentChatState, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { AgentChatTranscript } from './AgentChatTranscript'
import { installChatSource, mountChat } from './testSupport'
import { fixture as fileFixture } from '../../file-cards/testFixtures'
import { operatorState } from '../../operator-chat/pr17-test-fixtures'
import { operatorNavigationStatus, operatorTurnStatus, summarizeOperatorConversation } from '../../operator-chat/operatorChatStatus'

const state = (): AgentChatState => structuredClone(agentChatFixtures.idleAfterCompletion)
function snapshot(value: AgentChatState): ActivitySnapshotV1 {
  return { schemaVersion: 1, scope: { kind: 'agent_chat', conversationId: value.conversation!.id, workspaceId: value.context.workspaceId,
    workflowId: value.context.workflowId, nodeId: value.context.workflowNodeId, agentId: value.context.agentId }, revision: String(value.revision),
    active: [], queued: [], latest: null, pendingInteractions: [], activities: [], page: { before: null, nextCursor: null, hasMore: false } }
}
function receipt(value: AgentChatState, delivery: InteractionSummary['delivery'], acknowledged = false): InteractionSummary {
  return { id: 'exact-receipt', revision: '7', owner: { kind: 'chat_request', conversationId: value.conversation!.id, requestId: 'original-request' },
    native: { harness: 'codex', sessionId: 'session', requestId: 'original-native-question' }, delivery,
    answerRecorded: true, providerAcknowledged: acknowledged, workerAcknowledged: false, responseAvailability: 'unknown' }
}
function transcript(value: AgentChatState, onSendAgain = vi.fn(), onRefresh = vi.fn()) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AgentChatTranscript state={value} name="Agent" commands={[]} history={{ data: undefined, hasNextPage: false } as ReturnType<typeof import('./useAgentChat').useAgentChat>['history']}
      onCancel={vi.fn()} onRespond={vi.fn()} onSendAgain={onSendAgain} onRefresh={onRefresh} />
  </QueryClientProvider>)
  return { onSendAgain, onRefresh }
}
beforeEach(installChatSource)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('faithful canonical work and decision feedback', () => {
  it('shows unknown unfinished work outside history while leaving an independent next input usable', async () => {
    const value = state(); value.activitySnapshot = snapshot(value)
    value.activitySnapshot.active = [{ ref: { kind: 'subagent', itemId: 'older-child' }, phase: 'active', outcome: null,
      delivery: null, evidence: 'unknown', startedAt: null }]; value.activitySnapshot.hasMoreActiveWork = true
    const mounted = mountChat(value); await mounted.ready()
    expect(await screen.findByText('Unfinished work unconfirmed')).toBeInTheDocument()
    await userEvent.hover(screen.getByRole('status', { name: 'Agent state' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('More unfinished items exist than are shown')
    const input = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'Independent next input' } })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
    const operator = operatorState({ turnState: 'idle', activeRequestId: null, activitySnapshot: { ...value.activitySnapshot,
      scope: { kind: 'operator_chat', conversationId: 'conversation-one' } } })
    expect(operatorTurnStatus(operator, 'connected')).toContain('Unfinished work unconfirmed')
    expect(operatorNavigationStatus(summarizeOperatorConversation(operator))).toBe('Unfinished work unconfirmed')
  })
  it.each(['answer_recorded', 'uncertain'] as const)('shows the exact %s decision after its callback disappears and only reads back', async (delivery) => {
    const value = state(); value.activitySnapshot = snapshot(value)
    const saved = receipt(value, delivery)
    value.activitySnapshot.pendingInteractions = [saved]
    const { onRefresh, onSendAgain } = transcript(value)
    const label = delivery === 'uncertain' ? 'Decision delivery unconfirmed' : 'Decision sending'
    await userEvent.hover(screen.getByRole('status', { name: label }))
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Delivery to the provider is not confirmed')
    expect(tooltip).toHaveTextContent('Your decision is saved. Check its status before submitting again.')
    expect(tooltip).toHaveTextContent('original-native-question')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh decision status' }))
    expect(onRefresh).toHaveBeenCalledOnce(); expect(onSendAgain).not.toHaveBeenCalled()
  })
  it('shows provider acknowledgment from a canonical receipt item without claiming worker completion', async () => {
    const value = state(); value.activitySnapshot = snapshot(value)
    const saved = receipt(value, 'delivered', true)
    value.activitySnapshot.activities = [{ kind: 'interaction', id: saved.id, revision: saved.revision, order: '0', owner: saved.owner,
      source: { schemaVersion: 1, system: 'management_command_receipt', observedAt: null }, evidence: 'confirmed', interaction: saved }]
    transcript(value)
    expect(screen.getByText('Decision delivered')).toBeInTheDocument()
    await userEvent.hover(screen.getByRole('status', { name: 'Decision delivered' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('This does not confirm work completion.')
  })
})

function files(count: number): NonNullable<Message['attachments']> {
  return Array.from({ length: count }, (_, index) => fileFixture({ fileId: `display-${index}`, revisionId: `display-version-${index}`, filename: `output-${index}.md` }))
}

describe('canonical original send input', () => {
  for (const count of [0, 10]) it(`resends ${count} original pins while retaining twelve displayed outputs`, () => {
    const value = state(), message = value.messages[0]!, turn = value.turns[0]!
    value.messages = [{ ...message, requestId: turn.requestId, content: 'displayed text', attachments: files(count + 12),
      originalInput: { requestId: turn.requestId, content: 'exact admitted text', attachments: Array.from({ length: count }, (_, index) => ({ fileId: `input-${index}`, revisionId: `pinned-${index}` })) } }]
    value.turns = [{ ...turn, delivery: 'unknown', messageId: message.id }]
    const { onSendAgain } = transcript(value)
    fireEvent.click(screen.getByRole('button', { name: 'Send again as new message' }))
    expect(onSendAgain).toHaveBeenCalledWith('exact admitted text', value.messages[0]!.originalInput!.attachments, undefined)
    expect(screen.getByText(`output-${count + 11}.md`)).toBeInTheDocument()
  })
  it('does not infer resend inputs when the exact admitted source is unavailable', () => {
    const value = state(), turn = value.turns[0]!
    value.messages[0]!.originalInput = null; value.messages[0]!.attachments = files(12)
    value.turns = [{ ...turn, delivery: 'unknown' }]
    const { onRefresh, onSendAgain } = transcript(value)
    expect(screen.queryByRole('button', { name: 'Send again as new message' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Read original send inputs' }))
    expect(onRefresh).toHaveBeenCalledOnce(); expect(onSendAgain).not.toHaveBeenCalled()
  })
  it.each([0, 10])('previews and confirms only the %s original file pins, while cancel sends nothing', async (count) => {
    const value = state(), message = value.messages[0]!, turn = value.turns[0]!
    const pins = Array.from({ length: count }, (_, index) => ({ fileId: `input-${index}`, revisionId: `pinned-${index}` }))
    const content = 'exact admitted  text\n  with original spacing'
    value.messages = [{ ...message, requestId: turn.requestId, content: 'displayed text', attachments: [
      ...files(count + 12), ...(count ? [fileFixture({ ...pins[0]!, filename: 'original-input.md' })] : []),
    ], originalInput: { requestId: turn.requestId, content, attachments: pins } }]
    value.turns = [{ ...turn, delivery: 'unknown', messageId: message.id }]
    const mounted = mountChat(value); await mounted.ready()
    const sends = () => mounted.mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/messages'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Keep my independent draft' } })
    await userEvent.click(screen.getByRole('button', { name: 'Send again as new message' }))
    const preview = screen.getByRole('alertdialog')
    expect(within(preview).getByLabelText('Original message text').textContent).toBe(content)
    expect(within(preview).queryByText('displayed text')).not.toBeInTheDocument()
    expect(within(preview).queryByText('output-0.md')).not.toBeInTheDocument()
    expect(within(preview).getByText(/Displayed output files are excluded/)).toBeInTheDocument()
    if (count) {
      expect(JSON.parse(within(preview).getByLabelText('Original file pins').textContent!)).toEqual(pins)
      expect(within(preview).getByText('original-input.md')).toBeInTheDocument()
    } else {
      expect(within(preview).getByText('No original files.')).toBeVisible()
      expect(within(preview).queryByText(/This new message will contain text only/)).not.toBeInTheDocument()
    }
    expect(sends()).toHaveLength(0)
    await userEvent.click(within(preview).getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(sends()).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Send again as new message' }))
    await userEvent.selectOptions(within(screen.getByRole('alertdialog')).getByRole('combobox', { name: 'Mode for new message' }), 'regular')
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Send as new message' }))
    await waitFor(() => expect(sends()).toHaveLength(1))
    const sent = sends()[0]!.body as SendAgentChatMessageRequest
    expect(sent).toMatchObject({ intent: 'next_turn', content, attachments: pins })
    expect(sent.requestId).not.toBe(turn.requestId)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep my independent draft')
  })
})
