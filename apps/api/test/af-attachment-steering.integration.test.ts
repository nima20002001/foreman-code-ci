import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { afPublicationFixture } from './helpers/afPublicationFixture.js'
import { withAfMcp } from './helpers/afMcp.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

// Valid 1x1 PNG. This tests admission, not native image rendering.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

describe.skipIf(!postgresEnabled)('AF-05 attachment steering', { timeout: 90_000 }, () => {
  it('rejects document/image/attachment-only steers before admission over service, HTTP and authenticated MCP', async () => {
    const f = await afPublicationFixture()
    const active = await f.pause() // The live Codex turn started without files or file-tool authority.
    const doc = await f.upload(), image = await f.upload(png, 'pixel.png', 'image/png')
    const admit = vi.spyOn(f.repository, 'admit')
    const issue = vi.spyOn(f.service.sessions, 'issueForAcceptedSession')
    const starts = f.native.starts
    const sendHttp = (input: SendAgentChatMessageRequest, token = f.owner.token) => f.app.inject({
      method: 'POST', url: `/api/workspaces/${f.workspaceId}/agent-chat/messages`,
      headers: { host: 'localhost', authorization: `Bearer ${token}` }, payload: input,
    })
    try {
      await withAfMcp(f, async (writer, reader) => {
        const tool = (await writer.listTools()).tools.find((entry) => entry.name === 'agent_chat_send')!
        expect(tool.description).toMatch(/steer adds text only/)
        for (const attachments of [[doc], [image], [doc, image]]) for (const content of ['look at these', '']) {
          const input = f.request(f.conversationId, { intent: 'steer', expectedNativeTurnId: active.turn.nativeTurnId,
            content, attachments })
          await expect(f.chat.send(f.owner.principal, f.workspaceId, input)).rejects.toBeInstanceOf(z.ZodError)
          expect((await sendHttp(input)).statusCode).toBe(400)
          const response = await writer.callTool({ name: 'agent_chat_send', arguments: { workspaceId: f.workspaceId, request: input } })
            .then((value) => ({ value }), (error: unknown) => ({ error }))
          if ('error' in response) expect(String(response.error)).toMatch(/invalid|validation|attachment/i)
          else expect(response.value.isError).toBe(true)
          expect(await f.repository.turn(f.conversationId, input.requestId)).toBeUndefined()
          expect((await f.database.pool.query(`select 1 from operator_conversation_messages
            where conversation_id=$1 and client_request_id=$2`, [f.conversationId, input.requestId])).rowCount).toBe(0)
        }
        expect(admit).not.toHaveBeenCalled(); expect(issue).not.toHaveBeenCalled()
        expect(f.native.steerCalls).toBe(0); expect(f.native.starts).toBe(starts)
        // Authority/discovery remains unchanged. A read-only principal cannot send even text.
        const text = f.request(f.conversationId, { intent: 'steer', expectedNativeTurnId: active.turn.nativeTurnId, content: 'text only' })
        expect((await reader.listTools()).tools.map((entry) => entry.name)).not.toContain('agent_chat_send')
        await expectMcpAccessDenied(reader.callTool({ name: 'agent_chat_send', arguments: { workspaceId: f.workspaceId, request: text } }))
        expect((await sendHttp(text, f.reader.token)).statusCode).toBe(403)
        expect((await sendHttp(text)).statusCode).toBe(202)
        expect(f.native.steerCalls).toBe(1)
        expect(admit).toHaveBeenCalledTimes(1)
      })
    } finally { admit.mockRestore(); issue.mockRestore(); f.native.finish() }
    await f.settle()
  })
})
