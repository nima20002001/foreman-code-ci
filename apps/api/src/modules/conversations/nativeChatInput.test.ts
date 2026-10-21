import { expect, it } from 'vitest'
import { DEVICE_APPLICATION_JSON_BYTES } from '@foreman-code/contracts/device-application'
import { prepareWorkerChatFrame, preflightChatInput, nativeChatPrompt } from './nativeChatInput.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

it('checks the complete serialized Worker input including binding metadata and JSON escaping', () => {
  const f = workerConversationFixture('agent')
  const small = { method: 'conversation.start-turn' as const, binding: f.binding, session: f.session,
    admissionId: '00000000-0000-4000-8000-000000000000', correlationId: 'command', prompt: 'Hello' }
  const overhead = Buffer.byteLength(JSON.stringify({ ...small, prompt: '' }))
  const remaining = DEVICE_APPLICATION_JSON_BYTES - overhead
  const accepted = { ...small, prompt: '\\'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2) }
  expect(prepareWorkerChatFrame(accepted)).toEqual(accepted)
  expect(() => prepareWorkerChatFrame({ ...accepted, prompt: `${accepted.prompt}é` })).toThrowError(/transport limit/)
  expect(() => prepareWorkerChatFrame({ ...small, prompt: '\\'.repeat(600_000) })).toThrowError(/transport limit/)
})

it('requires an exact prepared remote envelope before admission and preserves attachment-only user input', async () => {
  const input = { content: '', attachments: [{ fileId: 'file', revisionId: 'revision' }] }
  expect(input.content).toBe('')
  expect(nativeChatPrompt(input.content, true)).toBe('Please review the attached files.')
  await expect(preflightChatInput(input, { workerRequired: true, prompt: nativeChatPrompt('', true) }))
    .rejects.toMatchObject({ code: 'CHAT_PREFLIGHT_UNAVAILABLE' })
  await expect(preflightChatInput({ content: ' ', attachments: [] }, { workerRequired: false, prompt: ' ' }))
    .rejects.toMatchObject({ code: 'CHAT_INPUT_EMPTY' })
})
