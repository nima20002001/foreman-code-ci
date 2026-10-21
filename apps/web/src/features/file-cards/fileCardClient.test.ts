import { webcrypto } from 'node:crypto'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import { createFileCardHttpClient, fileDownloadPath } from './fileCardClient'
import { fileCardKey, formatFileSize, hasRasterSignature, resolveMessageFileCards } from './fileCardPresentation'
import { fixture, fixtureBytes, MIME_CASES, TEST_AGENT_DOWNLOAD_PATH, TEST_DOWNLOAD_PATH, TEST_HANDLER_PATH } from './testFixtures'

const client = createFileCardHttpClient({ download: TEST_DOWNLOAD_PATH })
const options = () => ({ signal: new AbortController().signal })

beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.unstubAllGlobals(); finishSessionChange() })

describe('file card HTTP boundary', () => {
  it.each(MIME_CASES)('reads and verifies %s (%s)', async (mediaType, filename) => {
    const file = fixture({ mediaType, filename })
    server.use(http.get(TEST_HANDLER_PATH, () => new HttpResponse(fixtureBytes(mediaType).buffer, {
      headers: { 'Content-Type': mediaType },
    })))
    const blob = await client.download(file, options())
    expect(blob.type).toBe(mediaType)
    expect(blob.size).toBe(file.revision.byteSize)
  })

  it('pins the historical revision, not the mutable current head', async () => {
    const seen: Array<[string, string, string, RequestCredentials, RequestCache, RequestRedirect]> = []
    const file = fixture({ revisionId: 'revision-old', currentRevisionId: 'revision-new' })
    server.use(http.get(TEST_HANDLER_PATH, ({ params, request }) => {
      seen.push([String(params.fileId), String(params.revisionId), request.headers.get('Accept')!, request.credentials, request.cache, request.redirect])
      return new HttpResponse(fixtureBytes('text/markdown').buffer, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
    }))
    await client.download(file, options())
    expect(seen).toEqual([['file-a', 'revision-old', 'text/markdown', 'omit', 'no-store', 'error']])
  })

  it('requests the agent conversation content route', async () => {
    const agentClient = createFileCardHttpClient({ download: TEST_AGENT_DOWNLOAD_PATH })
    const requested: string[] = []
    server.use(http.get('*/api/workspaces/workspace-a/agent-chat/conversations/conversation-a/files/:fileId/revisions/:revisionId/content', ({ params }) => {
      requested.push(`${params.fileId}/${params.revisionId}`)
      return new HttpResponse(fixtureBytes('text/markdown').buffer, { headers: { 'Content-Type': 'text/markdown' } })
    }))
    await agentClient.download(fixture({ scope: { kind: 'temporary', chat: {
      kind: 'agent', conversationId: 'conversation-a', agentId: 'agent-a', workspaceId: 'workspace-a', workflowId: 'workflow-a',
    } } }), options())
    expect(requested).toEqual(['file-a/revision-a'])
  })

  it.each(['pending', 'expired', 'removed'] as const)('does not request bytes for %s', async (state) => {
    let requests = 0
    server.use(http.get(TEST_HANDLER_PATH, () => { requests++; return new HttpResponse(null) }))
    await expect(client.download(fixture({ state }), options())).rejects.toMatchObject({
      code: state === 'pending' ? 'FILE_NOT_READY' : `FILE_${state.toUpperCase()}`,
    })
    expect(requests).toBe(0)
  })

  it('treats an overdue ready DTO as expired without a network request', async () => {
    const createdAt = new Date(Date.now() - 3_600_001).toISOString()
    await expect(client.download(fixture({ createdAt, retentionDurationSeconds: 3600 }), options()))
      .rejects.toMatchObject({ code: 'FILE_EXPIRED' })
  })

  it.each(['text/html', 'image/svg+xml', 'application/octet-stream'])('rejects %s in place of the declared type', async (mediaType) => {
    server.use(http.get(TEST_HANDLER_PATH, () => new HttpResponse('<script>alert(1)</script>', { headers: { 'Content-Type': mediaType } })))
    await expect(client.download(fixture(), options())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects HTML masquerading as an image, even with matching size and hash', async () => {
    const bytes = new TextEncoder().encode('<html><script>alert(1)</script></html>')
    server.use(http.get(TEST_HANDLER_PATH, () => new HttpResponse(bytes.buffer, { headers: { 'Content-Type': 'image/png' } })))
    await expect(client.download(fixture({ mediaType: 'image/png', bytes }), options()))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each(['short', 'long', 'wrong digest', 'dishonest length', 'partial'] as const)('rejects a %s response', async (kind) => {
    const original = fixtureBytes('text/markdown')
    const bytes = kind === 'short' ? original.slice(1) : kind === 'long' ? new Uint8Array(original.length + 1) : original.slice()
    if (kind === 'wrong digest') bytes[0] ^= 1
    server.use(http.get(TEST_HANDLER_PATH, () => new HttpResponse(bytes.buffer, {
      status: kind === 'partial' ? 206 : 200,
      headers: { 'Content-Type': 'text/markdown', ...(kind === 'dishonest length' ? { 'Content-Length': '99999999' } : {}) },
    })))
    await expect(client.download(fixture(), options())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects a stream that exceeds its bound without Content-Length', async () => {
    server.use(http.get(TEST_HANDLER_PATH, () => new HttpResponse(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1000)); controller.close() },
    }), { headers: { 'Content-Type': 'text/markdown' } })))
    await expect(client.download(fixture(), options())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('normalizes the shared error envelope and never returns it as a file', async () => {
    server.use(http.get(TEST_HANDLER_PATH, () => HttpResponse.json({ error: {
      code: 'FILE_REMOVED', message: 'Removed',
    } }, { status: 410 })))
    await expect(client.download(fixture(), options())).rejects.toMatchObject({ code: 'FILE_REMOVED', status: 410 })
  })

  it('rejects before fetch when the caller is canceled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(client.download(fixture(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects when access is switching', async () => {
    beginSessionChange()
    await expect(client.download(fixture(), options())).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('fails closed when secure-context digest verification is unavailable', async () => {
    vi.stubGlobal('crypto', {})
    server.use(http.get(TEST_HANDLER_PATH, () => new HttpResponse(fixtureBytes('text/markdown').buffer, { headers: { 'Content-Type': 'text/markdown' } })))
    await expect(client.download(fixture(), options())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})

describe('path and presentation helpers', () => {
  it.each([
    'https://example.com/{fileId}/{revisionId}', '//example.com/{fileId}/{revisionId}',
    '/api/files/{fileId}/download', '/api/files/{revisionId}/download',
    '/api/files/{fileId}/{fileId}/{revisionId}', '/api/../files/{fileId}/{revisionId}',
    '/api/%2e%2e/files/{fileId}/{revisionId}', '/api/files/{fileId}/{revisionId}#download',
    '/api/files/{fileId}/{revisionId}?token=x', '/api/files/x{fileId}/{revisionId}',
    '/api/files/{fileId}/{revisionId}/{other}',
    '/api/operator/conversations/conversation-a/files/{fileId}/revisions/{revisionId}/download',
  ])('rejects unsafe/unpinned route %s', (download) => {
    expect(() => createFileCardHttpClient({ download })).toThrow()
  })

  it('encodes both path segments exactly once', () => {
    expect(fileDownloadPath(TEST_DOWNLOAD_PATH, { fileId: 'a/b?c#d', revisionId: 'rev %2F' }))
      .toBe('/api/operator/conversations/conversation-a/files/a%2Fb%3Fc%23d/revisions/rev%20%252F/content')
    expect(fileDownloadPath(TEST_AGENT_DOWNLOAD_PATH, { fileId: 'f', revisionId: 'r' }))
      .toBe('/api/workspaces/workspace-a/agent-chat/conversations/conversation-a/files/f/revisions/r/content')
    expect(() => fileDownloadPath(TEST_DOWNLOAD_PATH, { fileId: '..', revisionId: 'r' })).toThrow()
  })

  it('joins metadata by the whole pin, preserving order and missing revisions', () => {
    const old = fixture({ revisionId: 'old', currentRevisionId: 'new' })
    const current = fixture({ revisionId: 'new' })
    const missing = { fileId: 'missing', revisionId: 'old' }
    expect(resolveMessageFileCards([old.revision, missing], [current, old])).toEqual([old, undefined])
    expect(resolveMessageFileCards([old.revision], [current])).toEqual([undefined])
    expect(fileCardKey({ fileId: 'a:b', revisionId: 'c' })).not.toBe(fileCardKey({ fileId: 'a', revisionId: 'b:c' }))
  })

  it.each([[0, '0 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '1.5 KB'], [1048576, '1 MB']] as const)(
    'formats %i bytes as %s', (bytes, text) => expect(formatFileSize(bytes)).toBe(text),
  )

  it('accepts only allowlisted raster signatures', () => {
    expect(hasRasterSignature(new TextEncoder().encode('<svg></svg>'), 'image/svg+xml')).toBe(false)
    for (const mediaType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const) {
      expect(hasRasterSignature(fixtureBytes(mediaType), mediaType)).toBe(true)
      expect(hasRasterSignature(new Uint8Array(), mediaType)).toBe(false)
    }
  })
})
