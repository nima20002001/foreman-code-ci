import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AgentFileCreateWorkingCopyResultSchema, AgentFilePublishResultSchema,
  AgentFileReadResultSchema } from '@foreman-code/contracts/files'
import { createQualificationFileMcpListener } from '../src/modules/harnesses/qualification/fileMcpListener.js'
import { fileToolFixture } from './support/fileTools.js'

async function call(endpoint: string, token: string, name: string, args: unknown) {
  const response = await fetch(endpoint, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
    params: { name, arguments: args } }) })
  const text = await response.text()
  const data = text.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? text
  return { status: response.status, body: data ? JSON.parse(data) as {
    result?: { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }
  } : undefined }
}

describe('native qualification file MCP listener', () => {
  it('reads and publishes through the authenticated shared file service and persists immutable results', async () => {
    const f = await fileToolFixture()
    const source = await f.upload('# qualification source\n')
    const requests: Array<{ method: string; body: unknown; statusCode?: number }> = []
    const listener = await createQualificationFileMcpListener(f.service, f.token, {
      observeRequest: (request) => {
        const observed: typeof requests[number] = { ...request }
        requests.push(observed)
        return (statusCode) => { observed.statusCode = statusCode }
      },
    })
    try {
      const read = await call(listener.endpoint, f.token, 'files.read', { ...source, offset: 0, length: 65536 })
      expect(read.status).toBe(200)
      const original = AgentFileReadResultSchema.parse(read.body?.result?.structuredContent)
      if (original.status !== 'ready') throw new Error('The qualification source is unavailable.')
      expect(Buffer.from(original.contentBase64, 'base64').toString()).toBe('# qualification source\n')
      expect(read.body?.result?.content?.[1]).toEqual({ type: 'text', text: '# qualification source\n' })
      expect(requests).toEqual([{
        method: 'POST', statusCode: 200,
        body: expect.objectContaining({ method: 'tools/call', params: {
          name: 'files.read', arguments: { ...source, offset: 0, length: 65536 },
        } }),
      }])
      const copied = await call(listener.endpoint, f.token, 'files.create_working_copy', {
        commandId: randomUUID(), source, destination: f.scope,
      })
      expect(copied.status).toBe(200)
      const artifact = AgentFileCreateWorkingCopyResultSchema.parse(copied.body?.result?.structuredContent)
      const publication = { commandId: randomUUID(), artifactId: artifact.value.artifactId,
        scope: f.scope, filename: 'qualification-result.md', mediaType: 'text/markdown' as const }
      const published = await call(listener.endpoint, f.token, 'files.publish_result', publication)
      expect(published.status).toBe(200)
      const result = AgentFilePublishResultSchema.parse(published.body?.result?.structuredContent)
      expect(result.value.file.state).toBe('ready')
      expect(result.replayed).toBe(false)
      const retained = await f.service.read(f.token, { fileId: result.value.file.fileId,
        revisionId: result.value.revision.revisionId, offset: 0, length: 65536 })
      if (retained.status !== 'ready') throw new Error('The published qualification result is unavailable.')
      expect(retained.contentBase64).toBe(original.contentBase64)
      const retry = await call(listener.endpoint, f.token, 'files.publish_result', publication)
      expect(AgentFilePublishResultSchema.parse(retry.body?.result?.structuredContent).replayed).toBe(true)
    } finally { await listener.close() }
  })

  it('denies foreign credentials, revoked callers and writes outside the accepted file scope', async () => {
    const f = await fileToolFixture()
    const source = await f.upload()
    const listener = await createQualificationFileMcpListener(f.service, f.token)
    try {
      expect((await call(listener.endpoint, 'foreign', 'files.read', { ...source })).status).toBe(401)
      const foreign = await call(listener.endpoint, f.token, 'files.create_working_copy', {
        commandId: randomUUID(), source, destination: f.foreign,
      })
      expect(foreign.body?.result?.isError).toBe(true)
      expect(f.tools.artifacts.size).toBe(0)
      f.revoke()
      expect((await call(listener.endpoint, f.token, 'files.read', { ...source })).status).toBe(401)
    } finally { await listener.close() }
  })
})
