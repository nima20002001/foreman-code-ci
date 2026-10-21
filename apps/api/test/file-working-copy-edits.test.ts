import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import Fastify from 'fastify'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentFileApplyFormatEditInputSchema, AgentFilePublishResultSchema,
  AgentFileWorkingCopyEditResultSchema, AgentFileWriteWorkingCopyInputSchema,
  FileWorkingCopyBytesSchema, MAX_FILE_READ_BYTES, MAX_FILE_WRITE_BYTES,
  type FileMediaType, type MessageAttachmentRef,
} from '@foreman-code/contracts/files'
import { DomainError } from '../src/modules/errors.js'
import { extractZip } from '../src/modules/files/archives/index.js'
import { docx, pdfFixture, zip } from '../src/modules/files/formats/__tests__/fixtures.js'
import { readDocument } from '../src/modules/files/formats/index.js'
import { readImage } from '../src/modules/files/images/index.js'
import { registerFileToolsMcp, FILE_TOOLS_MCP_PATH } from '../src/modules/files/tools/mcp.js'
import { ALL_FILE_TOOL_NAMES } from '../src/modules/files/tools/types.js'
import { fileToolFixture } from './support/fileTools.js'

type Fixture = Awaited<ReturnType<typeof fixture>>
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const base64 = (text: string) => Buffer.from(text).toString('base64')
async function fixture() {
  const f = await fileToolFixture()
  return { ...f, token: await f.issue({ allowedTools: [...ALL_FILE_TOOL_NAMES] }) }
}
async function copy(f: Fixture, data: Buffer = Buffer.from('# original\n'), filename = 'source.md', mediaType: FileMediaType = 'text/markdown') {
  const requestId = randomUUID()
  const target = { kind: 'agent' as const, workspaceId: 'workspace-a', conversationId: f.scope.chat.conversationId }
  await f.files.allocate(f.principal, target, { requestId, filename, mediaType, byteSize: data.length, sha256: hash(data) })
  await f.files.upload(f.principal, target, requestId, Readable.from([data]))
  const { value } = await f.files.finalize(f.principal, target, requestId)
  const source = { fileId: value.file.fileId, revisionId: value.revision.revisionId }
  const result = await f.service.createWorkingCopy(f.token, { commandId: randomUUID(), source, destination: f.scope })
  const artifactId = result.value.artifactId
  const baseRevisionId = f.tools.artifacts.get(artifactId)!.snapshot!.revision.revisionId
  return { source, artifactId, baseRevisionId, publish: { artifactId, filename, mediaType, scope: f.scope, commandId: randomUUID() } }
}
async function read(f: Fixture, ref: MessageAttachmentRef): Promise<Buffer> {
  const result = await f.service.read(f.token, ref)
  expect(result.status).toBe('ready')
  if (result.status !== 'ready') throw new Error(result.reason)
  expect(result.eof).toBe(true) // These fixtures fit within the pinned 64 KiB read range.
  return Buffer.from(result.contentBase64, 'base64')
}
function snapshot(f: Fixture, artifactId: string) {
  return structuredClone(f.tools.artifacts.get(artifactId)!.snapshot!)
}
async function publishedBytes(f: Fixture, input: Awaited<ReturnType<typeof copy>>['publish']) {
  const result = await f.service.publish(f.token, input)
  return { result, bytes: await read(f, { fileId: result.value.file.fileId, revisionId: result.value.revision.revisionId }) }
}

// Real service/authentication/helper implementations; only FIL-03 storage and persistence are in-memory.
// This does not assert that a native read-mode adapter has enabled the new operations.
describe('FIL-05b owned working-copy edits', () => {
  it('writes complete bytes, publishes new immutable pins, preserves the source and replays the publication', async () => {
    const f = await fixture(), c = await copy(f)
    const changed = await f.service.writeWorkingCopy(f.token, { artifactId: c.artifactId, contentBase64: base64('# edited\n') })
    expect(changed).toEqual({ artifactId: c.artifactId, revisionId: snapshot(f, c.artifactId).revision.revisionId,
      byteSize: 9, sha256: hash(Buffer.from('# edited\n')) })
    expect(changed.revisionId).not.toBe(c.baseRevisionId)
    const { result, bytes } = await publishedBytes(f, c.publish)
    expect(bytes.toString()).toBe('# edited\n')
    expect(result.value.revision.origin).toBe('agent_output')
    expect(result.value.file.fileId).not.toBe(c.source.fileId)
    expect(result.value.revision.revisionId).not.toBe(c.source.revisionId)
    expect(await read(f, c.source)).toEqual(Buffer.from('# original\n'))
    expect(await f.service.publish(f.token, c.publish)).toEqual({ ...result, replayed: true })
    expect(await f.service.publishedForTurn(f.token)).toEqual([{ fileId: result.value.file.fileId, revisionId: result.value.revision.revisionId }])
  })

  it('allows zero-byte Markdown replacement and leaves unchanged-copy publication receipts untouched', async () => {
    const f = await fixture(), c = await copy(f)
    const first = await f.service.publish(f.token, c.publish)
    expect(first.value.revision.origin).toBe('agent_copy')
    expect(await f.service.publish(f.token, c.publish)).toEqual({ ...first, replayed: true })
    const edited = await f.service.writeWorkingCopy(f.token, { artifactId: c.artifactId, baseRevisionId: c.baseRevisionId, contentBase64: '' })
    expect(edited.byteSize).toBe(0)
    await expect(f.service.publish(f.token, c.publish)).rejects.toMatchObject({ code: 'FILE_REQUEST_CONFLICT' })
    expect((await publishedBytes(f, { ...c.publish, commandId: randomUUID() })).bytes.length).toBe(0)
  })

  it('guards the working revision, never the source revision, and does not silently replay an edit', async () => {
    const f = await fixture(), c = await copy(f)
    const args = { artifactId: c.artifactId, baseRevisionId: c.baseRevisionId, contentBase64: base64('first') }
    await expect(f.service.writeWorkingCopy(f.token, { ...args, baseRevisionId: c.source.revisionId }))
      .rejects.toMatchObject({ code: 'FILE_WORKING_COPY_CONFLICT' })
    const edited = await f.service.writeWorkingCopy(f.token, args)
    const before = snapshot(f, c.artifactId)
    await expect(f.service.writeWorkingCopy(f.token, args)).rejects.toMatchObject({ code: 'FILE_WORKING_COPY_CONFLICT' })
    await expect(f.service.applyFormatEdit(f.token, { artifactId: c.artifactId, baseRevisionId: c.baseRevisionId,
      edit: { kind: 'append_text', text: 'twice' } })).rejects.toMatchObject({ code: 'FILE_WORKING_COPY_CONFLICT' })
    expect(snapshot(f, c.artifactId)).toEqual(before)
    expect((await f.service.writeWorkingCopy(f.token, { ...args, baseRevisionId: edited.revisionId, contentBase64: base64('second') })).revisionId)
      .not.toBe(edited.revisionId)
  })

  it('checks the base atomically after a competing writer commits, not just during the initial read', async () => {
    const f = await fixture(), c = await copy(f)
    const begin = f.tools.beginWrite.bind(f.tools)
    let release!: () => void, announce!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { announce = resolve })
    let first = true
    vi.spyOn(f.tools, 'beginWrite').mockImplementation(async (...args) => {
      if (first) { first = false; announce(); await paused }
      return begin(...args)
    })
    const stale = f.service.writeWorkingCopy(f.token, { artifactId: c.artifactId, contentBase64: base64('stale') })
    const rejected = expect(stale).rejects.toMatchObject({ code: 'FILE_WORKING_COPY_CONFLICT' })
    await entered
    try {
      await f.service.writeWorkingCopy(f.token, { artifactId: c.artifactId, contentBase64: base64('winner') })
    } finally { release() }
    await rejected
    expect((await publishedBytes(f, c.publish)).bytes.toString()).toBe('winner')
  })

  it('does not expose a partial write for publication and can recover from storage failure', async () => {
    const f = await fixture(), c = await copy(f), before = snapshot(f, c.artifactId)
    const failure = vi.spyOn(f.bytes, 'receive').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(f.service.writeWorkingCopy(f.token, { artifactId: c.artifactId, contentBase64: base64('lost') })).rejects.toThrow('disk unavailable')
    expect(snapshot(f, c.artifactId)).toEqual(before)
    await expect(f.service.publish(f.token, c.publish)).rejects.toMatchObject({ code: 'FILE_ARTIFACT_INCOMPLETE' })
    failure.mockRestore()
    await f.service.writeWorkingCopy(f.token, { artifactId: c.artifactId, baseRevisionId: before.revision.revisionId, contentBase64: base64('recovered') })
    expect((await publishedBytes(f, c.publish)).bytes.toString()).toBe('recovered')
  })

  it('rechecks grants after byte I/O and does not commit when the owner loses permission', async () => {
    const f = await fixture(), c = await copy(f), before = snapshot(f, c.artifactId)
    const finalize = f.bytes.finalize.bind(f.bytes)
    vi.spyOn(f.bytes, 'finalize').mockImplementation(async (...args) => { await finalize(...args); f.denyWrites() })
    await expect(f.service.writeWorkingCopy(f.token, { artifactId: c.artifactId, contentBase64: base64('denied') }))
      .rejects.toMatchObject({ code: 'DENIED' })
    expect(snapshot(f, c.artifactId)).toEqual(before)
    expect(f.tools.artifacts.get(c.artifactId)?.state).toBe('failed')
  })

  it.each(['workflow_reference', 'workspace_reference'] as const)('rejects a permanent %s target for both edits', async (kind) => {
    const f = await fixture(), ref = await f.upload()
    const stored = f.repository.values.get(ref.fileId)!
    stored.value.file = { fileId: ref.fileId, currentRevisionId: ref.revisionId, state: 'ready', createdAt: stored.value.file.createdAt,
      scope: kind === 'workflow_reference' ? { kind, workspaceId: 'workspace-a', workflowId: 'workflow-a' } : { kind, workspaceId: 'workspace-a' } }
    const original = structuredClone(stored)
    await expect(f.service.writeWorkingCopy(f.token, { artifactId: ref.fileId, contentBase64: base64('forbidden') }))
      .rejects.toMatchObject({ code: 'FILE_ARTIFACT_NOT_FOUND' })
    await expect(f.service.applyFormatEdit(f.token, { artifactId: ref.fileId, edit: { kind: 'append_text', text: 'forbidden' } }))
      .rejects.toMatchObject({ code: 'FILE_ARTIFACT_NOT_FOUND' })
    expect(f.repository.values.get(ref.fileId)).toEqual(original)
    expect(f.tools.artifacts.size).toBe(0)
  })

  it('rejects original temporary file IDs and generated-output handles as working-copy edit targets', async () => {
    const f = await fixture(), c = await copy(f)
    await expect(f.service.writeWorkingCopy(f.token, { artifactId: c.source.fileId, contentBase64: '' }))
      .rejects.toMatchObject({ code: 'FILE_ARTIFACT_NOT_FOUND' })
    const output = await f.artifacts.create(f.token, 'output.md', 'text/markdown')
    await f.artifacts.completeWrite(f.token, output.artifactId, output.writeId, Readable.from([Buffer.from('output')]))
    await expect(f.service.applyFormatEdit(f.token, { artifactId: output.artifactId, edit: { kind: 'append_text', text: 'no' } }))
      .rejects.toMatchObject({ code: 'FILE_WORKING_COPY_REQUIRED' })
  })

  it('rejects another conversation, native session, or turn even when the owner and agent match', async () => {
    const f = await fixture(), c = await copy(f), before = snapshot(f, c.artifactId)
    for (const changes of [{ scope: f.foreign }, { nativeSessionId: 'native-b' }, { turnId: 'turn-b' }]) {
      const token = await f.issue({ ...changes, allowedTools: [...ALL_FILE_TOOL_NAMES] })
      await expect(f.service.writeWorkingCopy(token, { artifactId: c.artifactId, contentBase64: base64('foreign') }))
        .rejects.toMatchObject({ code: 'FILE_ARTIFACT_NOT_FOUND' })
      await expect(f.service.applyFormatEdit(token, { artifactId: c.artifactId, edit: { kind: 'append_text', text: 'foreign' } }))
        .rejects.toMatchObject({ code: 'FILE_ARTIFACT_NOT_FOUND' })
    }
    expect(snapshot(f, c.artifactId)).toEqual(before)
  })

  it('uses the explicit edit permission without borrowing publish authority', async () => {
    const f = await fixture(), c = await copy(f)
    const token = await f.issue({ allowedTools: ['files.write_working_copy'] })
    expect((await f.service.writeWorkingCopy(token, { artifactId: c.artifactId, contentBase64: base64('scoped') })).byteSize).toBe(6)
    await expect(f.service.publish(token, c.publish)).rejects.toMatchObject({ code: 'FILE_TOOL_DENIED' })
    await expect(f.service.applyFormatEdit(token, { artifactId: c.artifactId, edit: { kind: 'append_text', text: 'no' } }))
      .rejects.toMatchObject({ code: 'FILE_TOOL_DENIED' })
  })

  it('requires both the explicit edit allowlist and file mutation grant; old grants do not grow', async () => {
    const f = await fixture(), c = await copy(f), before = snapshot(f, c.artifactId)
    const tokens = [await f.issue(), await f.issue({ allowMutation: false, allowedTools: [...ALL_FILE_TOOL_NAMES] })]
    for (const token of tokens) {
      await expect(f.service.writeWorkingCopy(token, { artifactId: c.artifactId, contentBase64: '' })).rejects.toMatchObject({ code: 'FILE_TOOL_DENIED' })
      await expect(f.service.applyFormatEdit(token, { artifactId: c.artifactId, edit: { kind: 'append_text', text: 'no' } })).rejects.toMatchObject({ code: 'FILE_TOOL_DENIED' })
    }
    await f.sessions.revoke(f.token)
    await expect(f.service.writeWorkingCopy(f.token, { artifactId: c.artifactId, contentBase64: '' })).rejects.toMatchObject({ code: 'FILE_SESSION_EXPIRED' })
    expect(snapshot(f, c.artifactId)).toEqual(before)
  })
})

describe('FIL-05b real format helpers and publish readback', () => {
  it.each(['markdown', 'docx', 'pdf'] as const)('appends text to %s and preserves the original pinned bytes', async (format) => {
    const f = await fixture()
    const original = format === 'markdown' ? Buffer.from('# ORIGINAL marker\n') : format === 'docx' ? docx() : pdfFixture()
    const filename = format === 'markdown' ? 'source.md' : `source.${format}`
    const mediaType = format === 'markdown' ? 'text/markdown' : format === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf'
    const c = await copy(f, original, filename, mediaType)
    const edited = await f.service.applyFormatEdit(f.token, { artifactId: c.artifactId, baseRevisionId: c.baseRevisionId,
      edit: { kind: 'append_text', text: '\nFIL05B APPENDED marker\n' } })
    const { bytes, result } = await publishedBytes(f, c.publish)
    expect(hash(bytes)).toBe(edited.sha256)
    expect(result.value.revision.mediaType).toBe(mediaType)
    expect(result.value.revision.origin).toBe('agent_output')
    expect(await read(f, c.source)).toEqual(original)
    const root = await mkdtemp(path.join(tmpdir(), 'fil05b-test-'))
    try {
      const text = await readDocument({ format, bytes }, { scratchRoot: root })
      expect(text.status).toBe('ready')
      if (!('text' in text)) throw new Error(text.reason)
      expect(text.text).toContain('FIL05B APPENDED marker')
      expect(text.text).toContain(format === 'pdf' ? 'PAGE ONE marker' : 'ORIGINAL')
      if (format === 'pdf') expect(text.text).toContain('PAGE TWO untouched')
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 120_000)

  it('resizes a PNG through the image helper, publishes it and leaves the source dimensions unchanged', async () => {
    const f = await fixture()
    const original = await sharp({ create: { width: 8, height: 6, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer()
    const c = await copy(f, original, 'source.png', 'image/png')
    await f.service.applyFormatEdit(f.token, { artifactId: c.artifactId, edit: { kind: 'resize_image', width: 4, height: 3 } })
    const { bytes } = await publishedBytes(f, c.publish)
    expect(await readImage({ mediaType: 'image/png', bytes })).toMatchObject({ width: 4, height: 3, frames: 1 })
    expect(await read(f, c.source)).toEqual(original)
    expect(await readImage({ mediaType: 'image/png', bytes: original })).toMatchObject({ width: 8, height: 6 })
  })

  it('replaces one existing ZIP entry via safe extraction/repack, preserving other contents and the source', async () => {
    const f = await fixture(), original = zip({ 'nested/edit.txt': 'before', 'keep.txt': 'untouched' })
    const c = await copy(f, original, 'source.zip', 'application/zip')
    await f.service.applyFormatEdit(f.token, { artifactId: c.artifactId,
      edit: { kind: 'replace_zip_entry', entryName: 'nested/edit.txt', contentBase64: base64('after') } })
    const { bytes } = await publishedBytes(f, c.publish)
    const root = await mkdtemp(path.join(tmpdir(), 'fil05b-zip-test-'))
    try {
      const extracted = await extractZip(bytes, root)
      expect(await readFile(path.join(extracted.workingDirectory, 'nested/edit.txt'), 'utf8')).toBe('after')
      expect(await readFile(path.join(extracted.workingDirectory, 'keep.txt'), 'utf8')).toBe('untouched')
    } finally { await rm(root, { recursive: true, force: true }) }
    expect(await read(f, c.source)).toEqual(original)
  })

  it('rejects format mismatch, invalid content and unsafe/nonexistent ZIP entry selection without changing snapshots', async () => {
    const f = await fixture(), markdown = await copy(f), before = snapshot(f, markdown.artifactId)
    await expect(f.service.applyFormatEdit(f.token, { artifactId: markdown.artifactId, edit: { kind: 'resize_image', width: 1, height: 1 } }))
      .rejects.toMatchObject({ code: 'FILE_FORMAT_EDIT_UNSUPPORTED' })
    await expect(f.service.applyFormatEdit(f.token, { artifactId: markdown.artifactId, edit: { kind: 'append_text', text: '\u0000' } }))
      .rejects.toMatchObject({ code: 'FILE_FORMAT_CORRUPT' })
    expect(snapshot(f, markdown.artifactId)).toEqual(before)
    const archive = await copy(f, zip({ 'ok.txt': 'contents' }), 'source.zip', 'application/zip')
    const zipBefore = snapshot(f, archive.artifactId)
    for (const entryName of ['../escape', '/tmp/escape', 'missing.txt', 'ok.txt/']) {
      await expect(f.service.applyFormatEdit(f.token, { artifactId: archive.artifactId,
        edit: { kind: 'replace_zip_entry', entryName, contentBase64: '' } })).rejects.toMatchObject({ code: 'FILE_ZIP_ENTRY_NOT_FOUND' })
    }
    expect(snapshot(f, archive.artifactId)).toEqual(zipBefore)
  })
})

describe('FIL-05b bounded additive contracts', () => {
  it('accepts the exact 25 MiB cap and rejects one extra byte even when encoded string length is identical', () => {
    const exact = Buffer.alloc(MAX_FILE_WRITE_BYTES, 0x61).toString('base64')
    const overflow = Buffer.alloc(MAX_FILE_WRITE_BYTES + 1, 0x61).toString('base64')
    expect(exact.length).toBe(overflow.length)
    expect(FileWorkingCopyBytesSchema.safeParse(exact).success).toBe(true)
    expect(FileWorkingCopyBytesSchema.safeParse(overflow).success).toBe(false)
  })

  it('requires canonical base64 and strict opaque-handle inputs, never paths or context selection', () => {
    for (const value of ['', 'AA==', 'AAA=', 'AAAA', 'YWJj']) expect(FileWorkingCopyBytesSchema.safeParse(value).success).toBe(true)
    for (const value of ['A', 'AA', 'AA=', 'AB==', 'AAB=', 'AAAA\n', 'AAA\n', 'AA==\r\n', 'AA-_', '====', 'AA==AAAA']) {
      expect(FileWorkingCopyBytesSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)
    }
    const input = { artifactId: randomUUID(), contentBase64: '' }
    for (const extra of [{ path: '/tmp/file' }, { fileId: randomUUID() }, { scope: {} }, { ownerPrincipalId: 'other' }]) {
      expect(AgentFileWriteWorkingCopyInputSchema.safeParse({ ...input, ...extra }).success).toBe(false)
    }
  })

  it('bounds append text in UTF-8 bytes and rejects an oversize replacement before taking a writer', async () => {
    const f = await fixture(), c = await copy(f), before = snapshot(f, c.artifactId)
    expect(AgentFileApplyFormatEditInputSchema.safeParse({ artifactId: c.artifactId,
      edit: { kind: 'append_text', text: 'é'.repeat(MAX_FILE_READ_BYTES) } }).success).toBe(false)
    await expect(f.service.writeWorkingCopy(f.token, { artifactId: c.artifactId,
      contentBase64: Buffer.alloc(MAX_FILE_WRITE_BYTES + 1).toString('base64') })).rejects.toThrow()
    expect(snapshot(f, c.artifactId)).toEqual(before)
    expect(f.tools.artifacts.get(c.artifactId)?.state).toBe('complete')
  })
})

interface RpcBody {
  result?: { tools?: { name: string; annotations?: { idempotentHint?: boolean } }[]; structuredContent?: unknown; isError?: boolean }
  error?: unknown
}
async function endpoint(f: Fixture) {
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof DomainError ? error.status
      : error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500
    void reply.code(status).send({ error: error instanceof DomainError ? error.code : 'REQUEST_ERROR' })
  })
  registerFileToolsMcp(app, f.service)
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  async function rpc(method: string, params: unknown, token = f.token) {
    const response = await fetch(`${address}${FILE_TOOLS_MCP_PATH}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const body = await response.text()
    const line = body.split('\n').find((value) => value.startsWith('data: '))
    return { status: response.status, body: JSON.parse(line ? line.slice(6) : body) as RpcBody }
  }
  return { app, rpc }
}

describe('FIL-05b authenticated file-only MCP', () => {
  it('discovers and executes write + format edit + publish with pinned readback over the real endpoint', async () => {
    const f = await fixture(), c = await copy(f), { app, rpc } = await endpoint(f)
    try {
      const tools = (await rpc('tools/list', {})).body.result?.tools
      expect(tools?.map((tool) => tool.name).sort()).toEqual([...ALL_FILE_TOOL_NAMES].sort())
      expect(tools?.find((tool) => tool.name === 'files.apply_format_edit')?.annotations?.idempotentHint).toBe(false)
      // Deliberately exceeds the OLD 64 KiB MCP envelope without approaching the new file bound.
      const content = '# header\n' + 'x'.repeat(70_000)
      const write = await rpc('tools/call', { name: 'files.write_working_copy', arguments: { artifactId: c.artifactId, contentBase64: base64(content) } })
      expect(write.status).toBe(200)
      expect(write.body.result?.isError).not.toBe(true)
      const written = AgentFileWorkingCopyEditResultSchema.parse(write.body.result?.structuredContent)
      expect(written.sha256).toBe(hash(Buffer.from(content)))
      // Replace with a small document before append/readback (document text helper cap is 64 KiB).
      const reset = await rpc('tools/call', { name: 'files.write_working_copy', arguments: { artifactId: c.artifactId,
        baseRevisionId: written.revisionId, contentBase64: base64('# reset\n') } })
      const resetValue = AgentFileWorkingCopyEditResultSchema.parse(reset.body.result?.structuredContent)
      const edited = await rpc('tools/call', { name: 'files.apply_format_edit', arguments: { artifactId: c.artifactId,
        baseRevisionId: resetValue.revisionId, edit: { kind: 'append_text', text: '\nMCP marker\n' } } })
      expect(edited.body.result?.isError).not.toBe(true)
      const published = await rpc('tools/call', { name: 'files.publish_result', arguments: c.publish })
      const result = AgentFilePublishResultSchema.parse(published.body.result?.structuredContent)
      const readback = await rpc('tools/call', { name: 'files.read', arguments: {
        fileId: result.value.file.fileId, revisionId: result.value.revision.revisionId } })
      expect(readback.body.result?.isError).not.toBe(true)
      expect((await read(f, { fileId: result.value.file.fileId, revisionId: result.value.revision.revisionId })).toString()).toContain('MCP marker')
    } finally { await app.close() }
  }, 60_000)

  it('omits denied tools, denies direct and foreign calls, and never accepts an Operator/worker token', async () => {
    const f = await fixture(), c = await copy(f), before = snapshot(f, c.artifactId)
    const { app, rpc } = await endpoint(f)
    try {
      const token = await f.issue({ allowMutation: false, allowedTools: [...ALL_FILE_TOOL_NAMES] })
      expect((await rpc('tools/list', {}, token)).body.result?.tools?.map((tool) => tool.name)).toEqual(['files.list', 'files.read'])
      for (const [name, arguments_] of [
        ['files.write_working_copy', { artifactId: c.artifactId, contentBase64: '' }],
        ['files.apply_format_edit', { artifactId: c.artifactId, edit: { kind: 'append_text', text: 'denied' } }],
      ] as const) {
        expect((await rpc('tools/call', { name, arguments: arguments_ }, token)).body.result?.isError).toBe(true)
        const foreign = await f.issue({ scope: f.foreign, allowedTools: [...ALL_FILE_TOOL_NAMES] })
        expect((await rpc('tools/call', { name, arguments: arguments_ }, foreign)).body.result?.isError).toBe(true)
      }
      for (const credential of ['gql_operator_not_a_file_session', 'gql_worker_not_a_file_session', 'invalid']) {
        expect((await rpc('tools/list', {}, credential)).status).toBe(401)
      }
      f.denyWrites()
      expect((await rpc('tools/list', {})).body.result?.tools?.map((tool) => tool.name)).toEqual(['files.list', 'files.read'])
      expect(snapshot(f, c.artifactId)).toEqual(before)
    } finally { await app.close() }
  })
})
