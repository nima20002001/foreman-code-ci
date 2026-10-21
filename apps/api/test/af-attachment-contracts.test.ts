import { describe, expect, it, vi } from 'vitest'
import { SendOperatorMessageRequestSchema } from '@foreman-code/contracts'
import { SendAgentChatMessageRequestSchema } from '@foreman-code/contracts/agent-chat'
import { AgentChatSendToolInputSchema, SendSelectedRunChatRequestSchema } from '@foreman-code/contracts/selected-run-chat'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { MessagePublicationRefsSchema, mergeMessagePins } from '../src/modules/conversations/messagePublications.js'

const context = { workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' }
const input = { requestId: 'send', context, expectedConversationId: 'conversation', expectedNativeTurnId: 'active-turn', content: 'hello' }
const refs = Array.from({ length: 24 }, (_, index) => ({ fileId: `file-${index}`, revisionId: `revision-${index}` }))

describe('AF-04 / AF-05 shared attachment boundaries', () => {
  it('retains the ten-input limit but permits all distinct server-owned output pins', () => {
    for (const [schema, request] of [[SendAgentChatMessageRequestSchema, input],
      [SendOperatorMessageRequestSchema, { requestId: 'send', content: '' }]] as const) {
      expect(schema.safeParse({ ...request, attachments: refs.slice(0, 10) }).success).toBe(true)
      expect(schema.safeParse({ ...request, attachments: refs.slice(0, 11) }).success).toBe(false)
    }
    expect(MessagePublicationRefsSchema.parse(refs)).toEqual(refs)
    expect(mergeMessagePins(refs.slice(0, 10), refs.slice(10), refs.slice(10))).toEqual(refs)
    expect(() => mergeMessagePins(refs, [{ ...refs[0]!, revisionId: 'different' }])).toThrow(/different revision/)
    expect(() => MessagePublicationRefsSchema.parse([{ ...refs[0], storageKey: 'forged' }])).toThrow()
  })

  it('rejects attached steering in ordinary and selected-Run HTTP/MCP envelopes, including empty text', () => {
    const selection = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', workflowNodeId: 'node', executionId: 'execution' }
    for (const content of ['read it', '']) {
      const request = { ...input, content, intent: 'steer', attachments: refs.slice(0, 2) }
      const message = { requestId: request.requestId, expectedConversationId: request.expectedConversationId,
        expectedNativeTurnId: request.expectedNativeTurnId, content: request.content, intent: request.intent,
        attachments: request.attachments }
      expect(SendSelectedRunChatRequestSchema.safeParse({ selection, message: { ...message, intent: 'next_turn' } }).success).toBe(true)
      expect(SendAgentChatMessageRequestSchema.safeParse(request).success).toBe(false)
      expect(SendSelectedRunChatRequestSchema.safeParse({ selection, message }).success).toBe(false)
      expect(AgentChatSendToolInputSchema.safeParse({ workspaceId: 'workspace', request }).success).toBe(false)
      const { workspaceId, ...selected } = selection
      expect(AgentChatSendToolInputSchema.safeParse({ workspaceId, selection: selected, message }).success).toBe(false)
    }
    expect(SendAgentChatMessageRequestSchema.safeParse({ ...input, intent: 'steer', attachments: [] }).success).toBe(true)
    for (const intent of ['next_turn', 'interrupt_and_send']) {
      expect(SendAgentChatMessageRequestSchema.safeParse({ ...input, intent, content: '', attachments: refs.slice(0, 1) }).success).toBe(true)
    }
  })

  it('service validation rejects attachment steers even before repository lookup or manager creation', async () => {
    const query = vi.fn(), get = vi.fn(), admit = vi.fn(), managers = vi.fn()
    const args = [{ query }, { get, admit }, {}, {}, {}, managers, '/unused'] as unknown as ConstructorParameters<typeof AgentChatService>
    const service = new AgentChatService(...args)
    // No authority/database stub can authorize this operation: schema validation must run first.
    await expect(service.send({} as never, 'workspace', { ...input, intent: 'steer', content: '', attachments: refs.slice(0, 1) }))
      .rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: ['attachments'] })]) })
    expect(query).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled()
    expect(managers).not.toHaveBeenCalled()
    await service.shutdown()
  })
})
