import { expect, it } from 'vitest'
import { MessageSchema } from '@foreman-code/contracts'
import { boundedConversationMessages } from './snapshotMessages.js'

it('keeps the latest oversized original input discoverable within its serialized snapshot budget', () => {
  const content = '🙂\\"'.repeat(90_000)
  const latest = MessageSchema.parse({ id: 'latest', conversationId: 'conversation', requestId: 'command',
    nativeMessageId: 'native-message', revision: '42', sequence: '100', role: 'user', content,
    originalInput: { requestId: 'command', content, attachments: [] } })
  const prior = MessageSchema.parse({ id: 'prior', conversationId: 'conversation', role: 'assistant', content: 'Earlier' })
  const page = boundedConversationMessages([prior, latest], 128 * 1024)
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(128 * 1024)
  expect(page).toHaveLength(1)
  expect(page[0]).toMatchObject({ id: 'latest', requestId: 'command', nativeMessageId: 'native-message',
    revision: '42', sequence: '100', truncation: { truncated: true, originalBytes: Buffer.byteLength(content) } })
  expect(content.startsWith(page[0]!.content)).toBe(true)
  expect(page[0]!.content.endsWith('\ud83d')).toBe(false)
  expect(latest.content).toBe(content)
  expect(latest.originalInput?.content).toBe(content)
})

it('returns a contiguous newest window in chronological order without changing complete records', () => {
  const messages = ['first', 'second', 'third'].map(id => MessageSchema.parse({ id,
    conversationId: 'conversation', role: 'assistant', content: id.repeat(100) }))
  const budget = Buffer.byteLength(JSON.stringify(messages.slice(1)))
  expect(boundedConversationMessages(messages, budget)).toEqual(messages.slice(1))
})
