import { describe, expect, it } from 'vitest'
import { SendOperatorMessageRequestSchema } from './index.js'
import {
  AgentChatSendResponseSchema, AgentChatStateSchema, InterruptAgentChatRequestSchema,
  ReadAgentChatRequestSchema, ReadAgentChatResponseSchema, SendAgentChatMessageRequestSchema,
} from './agentChat.js'
import { agentChatFixtures } from './agentChatFixtures.js'

const context = agentChatFixtures.empty.context
const { workspaceId, ...query } = context
const target = { kind: 'agent_conversation', agent: context, conversationId: 'conversation' }
const receipt = { id: 'receipt', commandId: 'command', target, requestedIntent: 'auto', appliedIntent: 'next_turn',
  state: 'queued', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

describe('conversation delivery contracts', () => {
  it('accepts explicit automatic delivery while preserving omitted legacy intent', () => {
    const agent = { requestId: 'command', content: 'Continue', context: query, expectedConversationId: null }
    expect(SendAgentChatMessageRequestSchema.parse({ ...agent, intent: 'auto' }).intent).toBe('auto')
    expect(SendAgentChatMessageRequestSchema.parse(agent).intent).toBe('next_turn')
    const operator = { requestId: 'command', content: 'Continue', intent: 'steer', expectedNativeTurnId: 'native-turn' }
    expect(SendOperatorMessageRequestSchema.parse(operator)).toMatchObject(operator)
    expect(SendOperatorMessageRequestSchema.parse({ requestId: 'command', content: 'Continue' })).not.toHaveProperty('intent')
    expect(InterruptAgentChatRequestSchema.parse({ requestId: 'stop', scope: 'active_turn' }))
      .toEqual({ requestId: 'stop', scope: 'active_turn' })
  })

  it('retains cold targets and original admitted input through public readback', () => {
    const deliveryInputs = { items: [{ commandId: 'command', receiptId: 'receipt', target, origin: 'direct',
      content: 'Original input', truncated: false, bodyCursor: null, attachments: [], intent: 'auto', createdAt: receipt.createdAt }],
      nextCursor: null, hasMore: false, revision: 1 }
    const state = { ...agentChatFixtures.empty, deliveryTarget: target, deliveryTargetState: 'not_created' }
    expect(AgentChatStateSchema.parse(state)).toEqual(state)
    expect(ReadAgentChatRequestSchema.parse({ workspaceId, query, deliveryInputs: { receiptId: 'receipt' } }))
      .toMatchObject({ deliveryInputs: { receiptId: 'receipt' } })
    expect(ReadAgentChatResponseSchema.parse({ ...state, deliveryInputs })).toEqual({ ...state, deliveryInputs })
  })

  it('returns a canonical receipt when no native turn or current snapshot exists', () => {
    const result = { receipt, replayed: false }
    expect(AgentChatSendResponseSchema.parse(result)).toEqual(result)
    expect(AgentChatSendResponseSchema.safeParse({ receipt: { ...receipt, appliedIntent: 'interrupt_and_send' }, replayed: false }).success).toBe(false)
  })
})
