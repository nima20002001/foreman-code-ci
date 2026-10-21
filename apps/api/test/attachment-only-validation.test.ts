import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CHAT_MAX_MESSAGE_JSON_BYTES, SendOperatorMessageRequestSchema } from '@foreman-code/contracts'
import { AGENT_CHAT_MAX_MESSAGE_CHARACTERS, AgentChatMessageCommandSchema, SendAgentChatMessageRequestSchema }
  from '@foreman-code/contracts/agent-chat'
import { AgentChatSendToolInputSchema, SendSelectedRunChatRequestSchema } from '@foreman-code/contracts/selected-run-chat'

import { agentChatInputHash } from '../src/modules/conversations/agentChatRepository.js'
import { commandHash, commandPayload } from '../src/modules/conversations/operatorChatRepository.js'

const first = { fileId: 'file-1', revisionId: 'revision-1' }
const second = { fileId: 'file-2', revisionId: 'revision-2' }
const context = { workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' }
const operatorInput = { requestId: 'send', content: 'hello' }
const agentInput = { ...operatorInput, context, intent: 'next_turn' as const, expectedConversationId: 'chat' }
const digest = (json: string) => createHash('sha256').update(json).digest('hex')

for (const [name, schema, input] of [
  ['Operator', SendOperatorMessageRequestSchema, operatorInput],
  ['Agent', SendAgentChatMessageRequestSchema, agentInput],
] as const) {
  describe(`${name} send validation`, () => {
    it.each(['', ' \t\r\n ', '\u00a0\u2003'])('accepts attachment-only content %j without inventing text', (content) => {
      expect(schema.parse({ ...input, content, attachments: [first] }))
        .toMatchObject({ content: '', attachments: [first] })
    })

    it.each(['', ' \t\r\n ', '\u00a0\u2003'])('rejects content %j with omitted or empty attachments', (content) => {
      for (const fields of [{}, { attachments: [] }]) {
        const result = schema.safeParse({ ...input, content, ...fields })
        expect(result.success).toBe(false)
        if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: ['content'], message: 'Message requires text or an attachment.' }),
        ]))
      }
    })

    it('still requires a string content field, even when a file is attached', () => {
      for (const content of [undefined, null, 42]) {
        expect(schema.safeParse({ ...input, content, attachments: [first] }).success).toBe(false)
      }
    })

    it('retains strict attachment pins, uniqueness, count limits and unknown-field rejection', () => {
      for (const attachments of [null, [null], [{}], [{ ...first, revisionId: '' }],
        [{ ...first, workspaceId: 'foreign' }], [first, { ...first, revisionId: 'other' }],
        Array.from({ length: 11 }, (_, n) => ({ fileId: `file-${n}`, revisionId: `revision-${n}` }))]) {
        expect(schema.safeParse({ ...input, content: '', attachments }).success).toBe(false)
      }
      expect(schema.safeParse({ ...input, content: '', attachments: [first], unexpected: true }).success).toBe(false)
      const attachments = Array.from({ length: 10 }, (_, n) => ({ fileId: `file-${n}`, revisionId: `revision-${n}` }))
      expect(schema.parse({ ...input, content: '', attachments }).attachments).toEqual(attachments)
    })

    it('keeps text-only normalization and omitted-attachment defaults unchanged', () => {
      for (const fields of [{}, { attachments: [] }]) {
        expect(schema.parse({ ...input, content: ' \t hello\nworld \r\n', ...fields }))
          .toMatchObject({ content: 'hello\nworld', attachments: [] })
      }
    })
  })
}

describe('text and attachment message identities', () => {
  it('bounds encoded Agent messages including attachments while retaining historical retry inputs', () => {
    for (const intent of ['next_turn', 'interrupt_and_send'] as const) {
      expect(SendAgentChatMessageRequestSchema.parse({ ...agentInput, content: '', attachments: [first], intent }).intent).toBe(intent)
    }
    expect(SendAgentChatMessageRequestSchema.safeParse({ ...agentInput, content: '', attachments: [first], intent: 'steer' }).success).toBe(false)
    for (const attachments of [[], [first]]) {
      const envelope = { ...agentInput, content: '', attachments }
      const overhead = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
      for (const character of ['x', '界', '\u0001']) {
        const bytes = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2
        const content = character.repeat(Math.floor((CHAT_MAX_MESSAGE_JSON_BYTES - overhead) / bytes))
        const accepted = { ...envelope, content }
        const rejected = { ...envelope, content: content + character }
        expect(Buffer.byteLength(JSON.stringify(accepted), 'utf8')).toBeLessThanOrEqual(CHAT_MAX_MESSAGE_JSON_BYTES)
        expect(Buffer.byteLength(JSON.stringify(rejected), 'utf8')).toBeGreaterThan(CHAT_MAX_MESSAGE_JSON_BYTES)
        expect(SendAgentChatMessageRequestSchema.parse(accepted).content).toBe(content)
        expect(SendAgentChatMessageRequestSchema.safeParse(rejected).success).toBe(false)
      }
      const historical = { ...envelope, content: 'x'.repeat(AGENT_CHAT_MAX_MESSAGE_CHARACTERS) }
      expect(AgentChatMessageCommandSchema.parse(historical).content).toBe(historical.content)
      expect(SendAgentChatMessageRequestSchema.safeParse(historical).success).toBe(false)
      expect(AgentChatMessageCommandSchema.safeParse({ ...historical, content: historical.content + 'x' }).success).toBe(false)
    }
  })

  it('keeps the exact pre-attachment Operator JSON bytes and hash after shared-schema parsing', () => {
    // These strings freeze the old payload order, independently of commandPayload.
    const fixtures = [
      { input: operatorInput, json: '{"content":"hello"}' },
      { input: { ...operatorInput, context: {} }, json: '{"content":"hello"}' },
      { input: { ...operatorInput, content: ' \t hello\nworld \r\n',
        settings: { harness: 'codex', model: 'fixture', reasoningEffort: 'medium', serviceTier: 'standard', showThinking: false },
        configurationVersionId: 'config', defaultsRevision: 7, forkExpectedRevision: 9,
        context: { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', route: '/board' } },
      json: '{"content":"hello\\nworld","settings":{"harness":"codex","model":"fixture","reasoningEffort":"medium","serviceTier":"standard","showThinking":false},"configurationVersionId":"config","defaultsRevision":7,"forkExpectedRevision":9,"context":{"route":"/board","runId":"run","workflowId":"workflow","workspaceId":"workspace"}}' },
    ]
    for (const fixture of fixtures) {
      for (const fields of [{}, { attachments: [] }, { attachments: [], recovery: 'receipt' }]) {
        const parsed = SendOperatorMessageRequestSchema.parse({ ...fixture.input, ...fields })
        expect(JSON.stringify(commandPayload(parsed))).toBe(fixture.json)
        expect(commandHash(parsed)).toBe(digest(fixture.json))
      }
    }
  })

  it('keeps the old Agent context/intent/target hash bytes after shared-schema parsing', () => {
    for (const intent of ['next_turn', 'steer', 'interrupt_and_send'] as const) {
      for (const target of [undefined, 'active-turn']) {
        for (const fields of [{}, { attachments: [] }]) {
          const parsed = SendAgentChatMessageRequestSchema.parse({ ...agentInput,
            content: ' \t hello\nworld \r\n', intent, expectedNativeTurnId: target, ...fields })
          const json = `["hello\\nworld","${intent}",{"workflowId":"workflow","workflowNodeId":"node","agentId":"agent"}${target === undefined ? '' : ',"active-turn"'}]`
          expect(agentChatInputHash(parsed)).toBe(digest(json))
        }
      }
    }
  })

  it('does not collapse distinct file-only messages or replace their empty text with a placeholder', () => {
    const variants = [[first], [second], [{ ...first, revisionId: 'replacement' }], [first, second], [second, first]]
    expect(new Set(variants.map((attachments) => commandHash(SendOperatorMessageRequestSchema.parse({
      ...operatorInput, content: '', attachments,
    })))).size).toBe(variants.length)
    expect(new Set(variants.map((attachments) => agentChatInputHash(SendAgentChatMessageRequestSchema.parse({
      ...agentInput, content: '', attachments,
    })))).size).toBe(variants.length)
    const parsed = SendOperatorMessageRequestSchema.parse({ ...operatorInput, content: ' \n ', attachments: [first] })
    expect(commandPayload(parsed).content).toBe('')
    expect(commandHash(parsed)).not.toBe(commandHash({ ...parsed, content: 'Attached files' }))
  })
})

// Selected Run messages derive context from their selection and retain send validation.
describe('selected-Run schema composition', () => {
  const selection = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', workflowNodeId: 'node', executionId: 'execution' }
  const toolSelection = { workflowId: 'workflow', runId: 'run', workflowNodeId: 'node', executionId: 'execution' }
  const message = { requestId: 'send', content: '', intent: 'next_turn', expectedConversationId: 'chat' }
  it('retains attachment-only sends in the context-free Run body and both MCP selector variants', () => {
    for (const content of ['', ' \t\r\n ']) {
      const attached = { ...message, content, attachments: [first] }
      expect(SendSelectedRunChatRequestSchema.parse({ selection, message: attached }).message)
        .toMatchObject({ content: '', attachments: [first] })
      expect(AgentChatSendToolInputSchema.parse({ workspaceId: 'workspace', selection: toolSelection, message: attached }).message)
        .toMatchObject({ content: '', attachments: [first] })
      expect(AgentChatSendToolInputSchema.parse({ workspaceId: 'workspace', request: { ...attached, context } }).request)
        .toMatchObject({ content: '', attachments: [first] })
    }
  })
  it('does not bypass the empty-message rule or restore caller-supplied context after omitting context', () => {
    for (const content of ['', ' \t\r\n ']) {
      for (const fields of [{}, { attachments: [] }]) {
        const empty = { ...message, content, ...fields }
        expect(SendSelectedRunChatRequestSchema.safeParse({ selection, message: empty }).success).toBe(false)
        expect(AgentChatSendToolInputSchema.safeParse({ workspaceId: 'workspace', selection: toolSelection, message: empty }).success).toBe(false)
        expect(AgentChatSendToolInputSchema.safeParse({ workspaceId: 'workspace', request: { ...empty, context } }).success).toBe(false)
      }
    }
    expect(SendSelectedRunChatRequestSchema.safeParse({ selection, message: { ...message, attachments: [first], context } }).success).toBe(false)
    expect(SendSelectedRunChatRequestSchema.safeParse({ selection, message: {
      ...message, content: 'x'.repeat(AGENT_CHAT_MAX_MESSAGE_CHARACTERS + 1), attachments: [first],
    } }).success).toBe(false)
    expect(SendSelectedRunChatRequestSchema.safeParse({ selection, message: { ...message, attachments: [first, first] } }).success).toBe(false)
  })
})
