import { afterEach, describe, expect, it, vi } from 'vitest'
import { afPublicationFixture } from './helpers/afPublicationFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { withAfMcp } from './helpers/afMcp.js'
import type { MessageAttachmentRef } from '@foreman-code/contracts/files'
import { preparePublication, publicationValue, publicationPin } from './helpers/codexPublication.js'

const signal = () => AbortSignal.timeout(30_000)

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('publication attachment capacity', { timeout: 90_000 }, () => {
  for (const count of [10, 1]) {
    it(`Codex ${count} inputs plus twelve publications remain attachable and restart-safe`, async () => {
      const f = await afPublicationFixture(), t = await preparePublication(f, count)
      const published: MessageAttachmentRef[] = []
      for (let index = 0; index < 12; index++) {
        published.push(publicationPin(publicationValue(await t.publish())))
        const readback = await f.readPins(t.active.turn.messageId)
        expect(readback).toHaveLength(count + index + 1)
        expect(readback).toEqual(expect.arrayContaining([...t.attachments, ...published]))
      }
      f.native.finish(); await f.settle(); await t.bridge.close()
      expect((await f.stored(t.active.turn.messageId)).attachmentRefs).toEqual(t.attachments)
      const resumed = await f.resolver.resolve({ conversationId: f.conversationId, session: t.active.session,
        clientCorrelationId: t.active.correlation, signal: signal() })
      expect(resumed!.accepted.attachments).toEqual(t.attachments)
      await resumed!.dependencies.host.close()
      expect(await f.publications(t.active.turn.messageId)).toHaveLength(12)
      if (count === 10) await withAfMcp(f, async (_writer, reader) => {
          const result = await reader.callTool({ name: 'agent_chat_read', arguments: { workspaceId: f.workspaceId, query: f.context } })
        const readback = AgentChatStateSchema.parse(decodeMcpToolResult(result)).messages.find((message) => message.id === t.active.turn.messageId)!
        expect(readback.attachments).toHaveLength(22)
      })
      await f.nextTurn()
    })
  }
})
