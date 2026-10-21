import { createHash, randomUUID } from 'node:crypto'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { OperatorConversationStateSchema } from '@foreman-code/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { closeActivityReplay, setup, eventually } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

describe.skipIf(!postgresEnabled)('Production activity replay: publications', { timeout: 120000 }, () => {
  it('Operator publications: twelve real receipt-backed outputs survive final-text replacement, duplicate finalization and retained authorized download', async () => {
    const f = await setup({ operatorSandbox: 'workspace-write' })
    const created = await f.http('POST', '/api/operator/conversations', { title: 'Explicitly write-enabled file fixture' })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().conversation.id, fileRoot = `/api/operator/conversations/${id}/files`
    const inputBytes = Buffer.from('# retained input\n'), uploadId = randomUUID()
    const allocation = await f.http('POST', `${fileRoot}/uploads`, { requestId: uploadId, filename: 'source.md', mediaType: 'text/markdown',
      byteSize: inputBytes.length, sha256: createHash('sha256').update(inputBytes).digest('hex') })
    expect(allocation.statusCode, allocation.body).toBe(201)
    const uploaded = await fetch(`${f.origin}${fileRoot}/uploads/${uploadId}`, { method: 'PUT', headers: {
      authorization: `Bearer ${f.writer.token}`, 'content-type': 'application/octet-stream', 'content-length': String(inputBytes.length),
    }, body: inputBytes })
    expect(uploaded.ok).toBe(true)
    const finalized = await f.http('POST', `${fileRoot}/uploads/${uploadId}/finalize`, {})
    expect(finalized.statusCode, finalized.body).toBe(200)
    const input = finalized.json().value, pin = { fileId: input.file.fileId, revisionId: input.revision.revisionId }, scope = input.file.scope
    const sent = await f.http('POST', `/api/operator/conversations/${id}/messages`, { requestId: 'file-owner-A', content: 'recorded file input', attachments: [pin] })
    expect(sent.statusCode, sent.body).toBe(202)
    const read = async () => OperatorConversationStateSchema.parse((await f.http('GET', `/api/operator/conversations/${id}`)).json())
    const active = await eventually(read, (state) => !!state.activitySnapshot?.active[0]?.native?.turnId)
    const native = active.activitySnapshot!.active[0]!.native!
    f.replay.finalText(native.sessionId, native.turnId!, 'final text before output publication')
    await eventually(read, (state) => state.messages.some((message) => message.role === 'assistant' && message.content === 'final text before output publication'))
    const decode = (reply: { response: Record<string, unknown> }) => {
      expect(reply.response.success).toBe(true)
      const content = reply.response.contentItems as Array<{ type: string; text: string }>
      return JSON.parse(content[0]!.text)
    }
    const outputs: Array<{ fileId: string; revisionId: string; bytes: Buffer; digest: string }> = []
    for (let index = 0; index < 12; index++) {
      const copy = decode(await f.replay.fileTool(native.sessionId, native.turnId!, 'files_create_working_copy', {
        commandId: randomUUID(), source: pin, destination: scope,
      }))
      const bytes = Buffer.from(`# actual output ${index}\n`)
      decode(await f.replay.fileTool(native.sessionId, native.turnId!, 'files_write_working_copy', {
        artifactId: copy.value.artifactId, contentBase64: bytes.toString('base64'),
      }))
      const request = { commandId: randomUUID(), artifactId: copy.value.artifactId, scope,
        filename: `output-${index}.md`, mediaType: 'text/markdown' }
      const reply = await f.replay.fileTool(native.sessionId, native.turnId!, 'files_publish_result', request)
      const publication = decode(reply)
      expect(publication.value.revision.origin).not.toBe('upload')
      const digest = createHash('sha256').update(bytes).digest('hex')
      expect(publication.value.revision.sha256).toBe(digest)
      outputs.push({ fileId: publication.value.file.fileId, revisionId: publication.value.revision.revisionId, bytes, digest })
      if (index === 0) expect(decode(await f.replay.fileTool(native.sessionId, native.turnId!, 'files_publish_result', request, reply.callId)))
        .toEqual(publication)
    }
    const unavailable = await f.replay.fileTool(native.sessionId, native.turnId!, 'files_publish_result', { commandId: randomUUID(),
      artifactId: 'unowned-artifact', scope, filename: 'unavailable.md', mediaType: 'text/markdown' })
    expect(unavailable.response.success).toBe(false)
    f.replay.complete(native.sessionId, native.turnId!, 'final text before output publication')
    const finished = await eventually(read, (state) => state.activeRequestId === null)
    expect(finished.activitySnapshot!.activities.filter((item) => item.kind === 'file_publication')).toHaveLength(12)
    expect(finished.messages.filter((message) => message.role === 'assistant' && message.content === 'final text before output publication')).toHaveLength(1)
    const message = finished.messages.find((entry) => entry.requestId === 'file-owner-A' && entry.role === 'user')!
    expect(message.attachments).toHaveLength(13)
    expect(new Set(message.attachments!.map((attachment) => attachment.file.fileId)).size).toBe(13)
    const mcp = await f.call('operator_chat_get', { conversationId: id })
    expect(mcp.isError).not.toBe(true)
    expect(OperatorConversationStateSchema.parse(decodeMcpToolResult(mcp)).activitySnapshot).toEqual(finished.activitySnapshot)
    await f.restart()
    const retained = await read()
    expect(retained.messages.find((entry) => entry.id === message.id)?.attachments).toEqual(message.attachments)
    for (const output of outputs) {
      const url = `${fileRoot}/${output.fileId}/revisions/${output.revisionId}/content`
      const downloaded = await fetch(`${f.origin}${url}`, { headers: { authorization: `Bearer ${f.writer.token}` } })
      expect(downloaded.status).toBe(200)
      const bytes = Buffer.from(await downloaded.arrayBuffer())
      expect(bytes).toEqual(output.bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(output.digest)
      const denied = await fetch(`${f.origin}${url}`, { headers: { authorization: `Bearer ${f.denied.token}` } })
      expect([403, 404]).toContain(denied.status)
    }
    expect((await f.db.pool.query("select count(*)::int as count from file_tool_publications p join files f on f.file_id=p.file_id where f.conversation_id=$1", [id])).rows[0]!.count).toBe(12)
  })
})
