import { QueryClient } from '@tanstack/react-query'
import { afterEach, expect, it } from 'vitest'
import type { ChatDeliveryReceipt } from '@foreman-code/contracts'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import { acceptPendingDelivery, rememberPendingCommand, restorePendingCommands } from './pendingCommands'
import type { AgentChatCommand, AgentChatCommandResult } from './commandRecords'

const clients: QueryClient[] = []
afterEach(() => { clients.splice(0).forEach(client => client.clear()); localStorage.clear() })

it('recovers a settled receipt through Query without replaying or replacing another pending command', async () => {
  const client = new QueryClient()
  clients.push(client)
  const context = agentChatFixtures.empty.context
  const target = { kind: 'agent_conversation' as const, agent: context, conversationId: 'conversation' }
  const first: Extract<AgentChatCommand, { kind: 'send' }> = { kind: 'send', clearDraft: true,
    input: { requestId: 'first', content: 'Original input', intent: 'next_turn', expectedConversationId: 'conversation', context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId } } }
  const receipt: ChatDeliveryReceipt = { id: 'receipt', commandId: 'first', target,
    requestedIntent: 'next_turn', appliedIntent: 'next_turn', state: 'queued',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
  let submissions = 0
  const mutationKey = ['agent-chat', 1, 'draft', 'command']
  const mutation = client.getMutationCache().build<AgentChatCommandResult, Error, AgentChatCommand, unknown>(client, {
    mutationKey, mutationFn: async () => { submissions++; return { receipt } },
  })
  await mutation.execute(first)
  rememberPendingCommand('draft', first, receipt)
  const submittedAt = mutation.state.submittedAt
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const pending = client.getMutationCache().build<AgentChatCommandResult, Error, AgentChatCommand, unknown>(client, {
    mutationKey, mutationFn: async () => { submissions++; entered(); await gate; return {} },
  })
  const next = { ...first, input: { ...first.input, requestId: 'second', content: 'Keep this pending' } }
  const sending = pending.execute(next)
  await started
  try {
    const completed = { ...receipt, state: 'completed' as const, updatedAt: '2026-01-01T00:01:00Z' }
    expect(() => acceptPendingDelivery(client, 'draft', 1, completed)).not.toThrow()
    const commands = client.getMutationCache().findAll({ mutationKey, exact: true })
    expect(commands).toHaveLength(2)
    expect(pending.state.status).toBe('pending')
    expect(pending.state.variables).toEqual(next)
    const recovered = commands.find(command => (command.state.variables as AgentChatCommand).kind === 'send'
      && ((command.state.variables as Extract<AgentChatCommand, { kind: 'send' }>).input.requestId === 'first'))!
    expect(recovered.state).toMatchObject({ submittedAt, status: 'success', data: { receipt: completed } })
    const reopened = new QueryClient(); clients.push(reopened)
    restorePendingCommands(reopened, 'draft', 1)
    expect(reopened.getMutationCache().getAll()[0]?.state.data).toMatchObject({ receipt: completed })
    expect(submissions).toBe(2)
  } finally { release(); await sending }
})
