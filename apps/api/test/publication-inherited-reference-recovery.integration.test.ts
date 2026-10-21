import { afterEach, describe, expect, it, vi } from 'vitest'
import { afPublicationFixture } from './helpers/afPublicationFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { withAfMcp } from './helpers/afMcp.js'
import { ReadSelectedRunChatResponseSchema } from '@foreman-code/contracts/selected-run-chat'
import { preparePublication } from './helpers/codexPublication.js'

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('inherited publication reference recovery', { timeout: 90_000 }, () => {
  for (const selectedRun of [false, true]) {
    it(`upload-free ${selectedRun ? 'selected-Run' : 'Agent'} inherited-reference cold recovery without adoption or close`, async () => {
      const f = await afPublicationFixture({ selectedRun }), t = await preparePublication(f, 0, 'lose_close')
      expect(t.admission.accepted.attachments).toEqual([])
      if (selectedRun) expect(t.admission.accepted.scope.chat).toMatchObject({
        runId: f.fixture.run.id, executionId: f.runExecution.id,
      })
      const publish = vi.spyOn(f.service, 'publish')
      const issue = vi.spyOn(f.service.sessions, 'issueForAcceptedSession')
      const upload = vi.spyOn(f.files, 'upload')
      const starts = f.native.starts
      expect((await t.publish()).success).toBe(false)
      const original = await f.publications(t.active.turn.messageId)
      expect(original).toHaveLength(1)
      f.native.onFinish = undefined
      await f.database.pool.query(`update file_tool_sessions set revoked_at=clock_timestamp()
        where record->'context'->>'messageId'=$1`, [t.active.turn.messageId])
      f.native.finish(); await f.settle()
      expect((await f.stored(t.active.turn.messageId)).attachmentRefs).toBeUndefined()
      expect((await f.stored(t.active.turn.messageId)).publicationRefs).toBeUndefined()
      // Every read constructs a new repository; recovery uses only finalized DB facts.
      expect(await f.readPins(t.active.turn.messageId)).toEqual(original)
      expect(await f.readPins(t.active.turn.messageId)).toEqual(original)
      // Published facts are immutable even to a later application writer.
      await expect(f.database.pool.query('update file_tool_publications set binding=$2 where file_id=$1',
        [original[0]!.fileId, '0'.repeat(64)])).rejects.toThrow('append-only')
      expect(await f.readPins(t.active.turn.messageId)).toEqual(original)
      await withAfMcp(f, async (_writer, reader) => {
        const denied = await reader.callTool({ name: 'agent_chat_read', arguments: { workspaceId: 'foreign-workspace', query: f.context } })
        expect(denied.isError).toBe(true)
        expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
        const result = await reader.callTool({ name: 'agent_chat_read', arguments: f.selection
          ? { workspaceId: f.workspaceId, selection: { workflowId: f.selection.workflowId, runId: f.selection.runId,
            workflowNodeId: f.selection.workflowNodeId, executionId: f.selection.executionId } }
          : { workspaceId: f.workspaceId, query: f.context } })
        let readback
        if (f.selection) {
          const selected = ReadSelectedRunChatResponseSchema.parse(decodeMcpToolResult(result))
          if (selected.kind !== 'selected') throw new Error('Expected the exact selected Run chat')
          expect(selected.selection).toEqual(f.selection)
          readback = selected.state
        } else readback = AgentChatStateSchema.parse(decodeMcpToolResult(result))
        expect(readback.messages.find((message) => message.id === t.active.turn.messageId)?.attachments?.map((file) => ({
          fileId: file.file.fileId, revisionId: file.revision.revisionId,
        }))).toEqual(original)
        expect(readback.messages.filter((message) => message.id !== t.active.turn.messageId)
          .flatMap((message) => message.attachments ?? [])).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ file: expect.objectContaining({ fileId: original[0]!.fileId }) }),
          ]))
      })
      expect(await f.publications(t.active.turn.messageId)).toEqual(original)
      expect(publish).toHaveBeenCalledTimes(1)
      expect(issue).not.toHaveBeenCalled()
      // The original publish transfers bytes once; recovery never re-uploads.
      expect(upload).toHaveBeenCalledTimes(1)
      expect(f.native.starts).toBe(starts)
      await t.bridge.close()
    })
  }
})
