import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { AgentFileReadResultSchema, DEFAULT_FILE_RETENTION_SECONDS } from '@foreman-code/contracts/files'
import { DomainError } from '../src/modules/errors.js'
import { registerFileToolsMcp } from '../src/modules/files/tools/mcp.js'
import { fileToolFixture } from './support/fileTools.js'

async function fixture() {
  const files = await fileToolFixture()
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500)
    .send({ error: 'Request denied.' }))
  registerFileToolsMcp(app, files.service)
  const read = async (input: unknown, token = files.token) => {
    const response = await app.inject({ method: 'POST', url: '/mcp/files',
      headers: { host: 'localhost', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'files.read', arguments: input } } })
    const data = response.body.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? response.body
    const body = JSON.parse(data) as { result?: {
      structuredContent: unknown; content: Array<{ type: string; text?: string }>; isError?: boolean
    } }
    return { status: response.statusCode, ...body }
  }
  return { files, app, read }
}

describe('authenticated Markdown MCP reads', () => {
  it('delivers the exact text and original bytes without model-side base64 decoding', async () => {
    const f = await fixture()
    const text = '\ufeff# Qualification\r\n\r\nQUALIFY_cadbbb97-3f8e-480a-8558-af6bb28609ed\r\nفارسی 🙂\r\n'
    try {
      const source = await f.files.upload(text)
      const read = await f.read(source)
      expect(read.status).toBe(200)
      expect(read.result?.isError).not.toBe(true)
      const value = AgentFileReadResultSchema.parse(read.result?.structuredContent)
      expect(value.status).toBe('ready')
      if (value.status !== 'ready') throw new Error('Expected ready Markdown')
      expect(Buffer.from(value.contentBase64, 'base64')).toEqual(Buffer.from(text))
      expect(value.file.fileId).toBe(source.fileId)
      expect(value.revision.revisionId).toBe(source.revisionId)
      expect(read.result?.content[1]).toEqual({ type: 'text', text })
      expect(JSON.parse(read.result!.content[0]!.text!)).toEqual(value)
    } finally {
      await f.app.close()
    }
  })

  it('renders valid UTF-8 ranges and retains split character bytes without replacement text', async () => {
    const f = await fixture()
    try {
      const source = await f.files.upload('A🙂B')
      const valid = await f.read({ ...source, offset: 1, length: 4 })
      expect(valid.result?.content[1]).toEqual({ type: 'text', text: '🙂' })
      const split = await f.read({ ...source, offset: 2, length: 1 })
      expect(split.result?.isError).not.toBe(true)
      expect(split.result?.content).toHaveLength(1)
      const value = AgentFileReadResultSchema.parse(split.result?.structuredContent)
      expect(value.status).toBe('ready')
      if (value.status !== 'ready') throw new Error('Expected ready byte range')
      expect(value.offset).toBe(2)
      expect(Buffer.from(value.contentBase64, 'base64')).toEqual(Buffer.from('A🙂B').subarray(2, 3))
    } finally {
      await f.app.close()
    }
  })

  it('withholds text for foreign, revoked and expired file access', async () => {
    const f = await fixture()
    try {
      const source = await f.files.upload('private Markdown')
      const foreign = await f.files.upload('foreign Markdown', f.files.foreign)
      const denied = await f.read(foreign)
      expect(AgentFileReadResultSchema.parse(denied.result?.structuredContent))
        .toEqual({ status: 'unavailable', ref: foreign, reason: 'forbidden' })
      expect(denied.result?.content).toHaveLength(1)
      expect(JSON.stringify(denied)).not.toContain('foreign Markdown')
      f.files.advance(DEFAULT_FILE_RETENTION_SECONDS * 1_000 + 1)
      const token = await f.files.issue()
      const expired = await f.read(source, token)
      expect(AgentFileReadResultSchema.parse(expired.result?.structuredContent).status).toBe('unavailable')
      expect(expired.result?.content).toHaveLength(1)
      f.files.revoke()
      const revoked = await f.read(source, token)
      expect(revoked.status).toBe(401)
      expect(JSON.stringify(revoked)).not.toContain('private Markdown')
    } finally {
      await f.app.close()
    }
  })
})
