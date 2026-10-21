import { expect, it } from 'vitest'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { remoteAgentConversation } from './helpers/remoteAgentConversation.js'

it.each(['codex', 'claude'] as const)(
  'delivers an uploaded Agent chat attachment to the remote %s file path', async harness => {
    const f = await remoteAgentConversation(harness)
    try {
      const content = '# Remote attachment\nThe uploaded bytes belong to this conversation.\n'
      const ref = await f.upload(Buffer.from(content))
      await f.send('Read the attached Markdown file', 'completed', [ref])
      expect(f.receivedAttachments).toEqual([content])
      const state = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
      const userMessage = state.messages.find(message => message.role === 'user')!
      expect(userMessage.attachments).toMatchObject([{ file: { fileId: ref.fileId, state: 'ready' },
        revision: { revisionId: ref.revisionId, filename: 'attached.md' } }])
      if (harness === 'codex') {
        expect(f.frames.filter(frame => frame.method === 'conversation.file-copy').map(frame => frame.copy.phase))
          .toEqual(expect.arrayContaining(['begin', 'chunk', 'finish']))
      }
    } finally { await f.close() }
  }, 30_000)
