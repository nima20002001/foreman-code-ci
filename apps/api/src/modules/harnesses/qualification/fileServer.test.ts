import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { createQualificationFileServer } from './fileServer.js'
import { fileToolFixture } from '../../../../test/support/fileTools.js'

it('runs the shared authenticated file MCP tools with current scopes and a read-only allowlist', async () => {
  const f = await fileToolFixture()
  const source = await f.upload('# Native qualification input\n')
  const foreign = await f.upload('# Another conversation\n', f.foreign)
  const token = await f.issue({ allowMutation: false, allowedTools: ['files.read', 'files.publish_result'] })
  const observed: Array<{ method: string; statusCode: number }> = []
  const server = createQualificationFileServer(() => f.service,
    (request, statusCode) => { observed.push({ method: request.method, statusCode }) })
  const client = new Client({ name: 'Foreman Code file qualification transport test', version: '1' })
  try {
    const endpoint = new URL('/mcp/files', await server.listen())
    const denied = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(denied.status).toBe(401)
    await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: { token: async () => token } }))
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['files.read'])
    const read = await client.callTool({ name: 'files.read', arguments: { ...source, offset: 0, length: 1024 } })
    expect(read.isError).not.toBe(true)
    expect(read.structuredContent).toMatchObject({ status: 'ready',
      contentBase64: Buffer.from('# Native qualification input\n').toString('base64') })
    const downloads = f.bytes.downloads
    const other = await client.callTool({ name: 'files.read', arguments: { ...foreign, offset: 0, length: 1024 } })
    expect(other.structuredContent).toEqual({ status: 'unavailable', ref: foreign, reason: 'forbidden' })
    expect(f.bytes.downloads).toBe(downloads)
    f.revoke()
    const revoked = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json' }, body: '{}' })
    expect(revoked.status).toBe(401)
    expect(observed.some(request => request.method === 'POST' && request.statusCode === 200)).toBe(true)
  } finally {
    await client.close()
    await server.close()
  }
})

it('closes safely before listen and after an interrupted request', async () => {
  const f = await fileToolFixture()
  const server = createQualificationFileServer(() => f.service, () => {})
  await server.close()
  const endpoint = new URL('/mcp/files', await server.listen())
  const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${f.token}`,
    'content-type': 'application/json' }, body: 'invalid-json' })
  expect(response.status).toBe(400)
  await server.close()
  await server.close()
})
