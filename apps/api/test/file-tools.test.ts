import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { FileToolArtifacts } from '../src/modules/files/tools/artifacts.js'
import { AgentFileToolService } from '../src/modules/files/tools/service.js'
import { registerFileToolsMcp, FILE_TOOLS_MCP_PATH } from '../src/modules/files/tools/mcp.js'
import { FILE_TOOL_NAMES } from '../src/modules/files/tools/types.js'
import type { FileByteStorage } from '../src/modules/files/storage.js'
import { fileToolFixture } from './support/fileTools.js'

type Fixture = Awaited<ReturnType<typeof fileToolFixture>>
async function workingCopy(f: Fixture) {
  const source = await f.upload()
  const copy = await f.service.createWorkingCopy(f.token, { commandId: randomUUID(), source, destination: f.scope })
  return { source, copy, input: { commandId: randomUUID(), artifactId: copy.value.artifactId,
    scope: f.scope, filename: 'result.md', mediaType: 'text/markdown' as const } }
}
const text = (result: Awaited<ReturnType<Fixture['service']['read']>>) => result.status === 'ready'
  ? Buffer.from(result.contentBase64, 'base64').toString('utf8') : result.reason

// Test transport uses the real Fastify + pinned MCP SDK, but in-memory persistence/byte boundaries.
async function endpoint(f: Fixture, service = f.service) {
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof DomainError ? error.status : 500
    void reply.code(status).send({ error: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' })
  })
  registerFileToolsMcp(app, service)
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  async function rpc(method: string, params: unknown, token = f.token) {
    const response = await fetch(new URL(FILE_TOOLS_MCP_PATH, address), { method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
        'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const body = await response.text()
    const line = body.split('\n').find((value) => value.startsWith('data: '))
    const result = JSON.parse(line ? line.slice(6) : body) as {
      result?: { tools?: { name: string }[]; structuredContent?: unknown; isError?: boolean; content?: { text: string }[] }
      error?: unknown
    }
    return { status: response.status, body: result }
  }
  return { app, rpc, address }
}

describe('FIL-05 authenticated file tools over FIL-03', () => {

  it('routes permitted reference list/read through the read-only resolver', async () => {
    const f = await fileToolFixture(), ref = await f.upload('reference bytes')
    const stored = f.repository.values.get(ref.fileId)!
    const scope = { kind: 'workflow_reference' as const, workspaceId: 'workspace-a', workflowId: 'workflow-a' }
    stored.value.file = { fileId: ref.fileId, currentRevisionId: ref.revisionId,
      createdAt: stored.value.file.createdAt, state: 'ready', scope }
    const read = vi.fn(async () => ({ status: 'ready' as const, ...stored.value, readAt: f.clock().toISOString(),
      offset: 0, byteLength: 5, contentBase64: Buffer.from('refer').toString('base64'), eof: false }))
    const list = vi.fn(async () => ({ items: [stored.value], pageInfo: { nextCursor: null } }))
    const service = new AgentFileToolService(f.files, f.sessions, f.artifacts, f.tools, { list, read }, f.clock)
    const token = await f.issue({ allowMutation: false })
    expect((await service.list(token, { scope })).items.map((row) => row.file.fileId)).toEqual([ref.fileId])
    expect(text(await service.read(token, { ...ref, offset: 0, length: 5 }))).toBe('refer')
    expect(read).toHaveBeenCalledOnce()
    expect(f.tools.reads).toHaveLength(0)
    const { app, rpc } = await endpoint(f, service)
    try {
      expect((await rpc('tools/call', { name: 'files.list', arguments: { scope } }, token))
        .body.result?.structuredContent).toMatchObject({ items: [{ file: { fileId: ref.fileId } }] })
      expect((await rpc('tools/call', { name: 'files.read', arguments: { ...ref, offset: 0, length: 5 } }, token))
        .body.result?.structuredContent).toMatchObject({ status: 'ready', byteLength: 5 })
      expect((await rpc('tools/call', { name: 'files.read', arguments: ref }, 'invalid')).status).toBe(401)
    } finally { await app.close() }
    await expect(service.createWorkingCopy(token, { commandId: randomUUID(), source: ref, destination: f.scope }))
      .rejects.toMatchObject({ code: 'FILE_TOOL_DENIED' })
  })

  it('reads pinned bounded ranges and never substitutes the current head', async () => {
    const f = await fileToolFixture(), ref = await f.upload('abcdefgh')
    expect(text(await f.service.read(f.token, { ...ref, offset: 2, length: 3 }))).toBe('cde')
    expect(await f.service.read(f.token, { ...ref, offset: 8 })).toMatchObject({ status: 'ready', byteLength: 0, eof: true })
    expect(await f.service.read(f.token, { ...ref, revisionId: randomUUID() })).toMatchObject({ status: 'unavailable', reason: 'not_found' })
    await expect(f.service.read(f.token, { ...ref, length: 65_537 })).rejects.toThrow()
    await expect(f.service.read(f.token, { ...ref, offset: 9 })).rejects.toMatchObject({ code: 'FILE_RANGE_INVALID' })
    expect(f.tools.reads[0]).toMatchObject({ runId: 'run-a', executionId: 'execution-a', ...ref })
  })

  it('copies, publishes new immutable IDs, links the originating turn, and reads back unchanged bytes', async () => {
    const f = await fileToolFixture(), { source, input } = await workingCopy(f)
    const published = await f.service.publish(f.token, input)
    expect(published.value.file.fileId).not.toBe(source.fileId)
    expect(published.value.revision.revisionId).not.toBe(source.revisionId)
    expect(published.value.revision.origin).toBe('agent_copy')
    const ref = { fileId: published.value.file.fileId, revisionId: published.value.revision.revisionId }
    expect(text(await f.service.read(f.token, ref))).toBe('# original\n')
    expect(await f.service.publishedForTurn(f.token)).toEqual([ref])
    expect([...f.tools.links.values()][0]?.context).toMatchObject({ nativeSessionId: 'native-a', turnId: 'turn-a', scope: f.scope })
    const page = await f.service.list(f.token, { scope: f.scope })
    expect(page.items.map((item) => item.file.fileId)).toContain(ref.fileId)
  })

  it('editing uses detached snapshot bytes, leaves the original pinned bytes unchanged, and publishes agent_output', async () => {
    const f = await fileToolFixture(), { source, input } = await workingCopy(f)
    const writeId = await f.artifacts.beginWrite(f.token, input.artifactId)
    await f.artifacts.completeWrite(f.token, input.artifactId, writeId, Readable.from([Buffer.from('# edited\n')]))
    const published = await f.service.publish(f.token, input)
    expect(published.value.revision.origin).toBe('agent_output')
    expect(text(await f.service.read(f.token, source))).toBe('# original\n')
    expect(text(await f.service.read(f.token, { fileId: published.value.file.fileId, revisionId: published.value.revision.revisionId }))).toBe('# edited\n')
  })

  it('duplicate publish replays; changed bytes or metadata under the same commandId conflict', async () => {
    const f = await fileToolFixture(), { input } = await workingCopy(f)
    const first = await f.service.publish(f.token, input), count = f.repository.values.size
    const retry = await f.service.publish(f.token, input)
    expect(retry).toEqual({ ...first, replayed: true })
    expect(f.repository.values.size).toBe(count)
    await expect(f.service.publish(f.token, { ...input, filename: 'renamed.md' })).rejects.toMatchObject({ code: 'FILE_REQUEST_CONFLICT' })
    const write = await f.artifacts.beginWrite(f.token, input.artifactId)
    await f.artifacts.completeWrite(f.token, input.artifactId, write, Readable.from([Buffer.from('changed')]))
    await expect(f.service.publish(f.token, input)).rejects.toMatchObject({ code: 'FILE_REQUEST_CONFLICT' })
    expect(f.repository.values.size).toBe(count)
    expect(f.tools.links.size).toBe(1)
  })

  it('persists retry identity across service reconstruction and a lost finalization acknowledgement', async () => {
    const f = await fileToolFixture(), { input } = await workingCopy(f)
    const finalize = f.files.finalize.bind(f.files)
    let lost = true
    vi.spyOn(f.files, 'finalize').mockImplementation(async (...args) => {
      const result = await finalize(...args)
      if (lost) { lost = false; throw new Error('lost acknowledgement') }
      return result
    })
    await expect(f.service.publish(f.token, input)).rejects.toThrow('lost acknowledgement')
    expect(f.tools.links.size).toBe(1)
    const links = await f.service.publishedForTurn(f.token)
    const restartedArtifacts = new FileToolArtifacts(f.tools, f.bytes as unknown as FileByteStorage, f.sessions, f.clock)
    const restarted = new AgentFileToolService(f.files, f.sessions, restartedArtifacts, f.tools, undefined, f.clock)
    const retry = await restarted.publish(f.token, input)
    expect(retry.replayed).toBe(true)
    expect(await restarted.publishedForTurn(f.token)).toEqual(links)
    expect(retry.value.file.fileId).toBe(links[0]?.fileId)
  })

  it('does not finalize or expose an attachment when the durable turn link fails', async () => {
    const f = await fileToolFixture(), { input } = await workingCopy(f)
    const fail = vi.spyOn(f.tools, 'linkPublication').mockRejectedValueOnce(new Error('database unavailable'))
    await expect(f.service.publish(f.token, input)).rejects.toThrow('database unavailable')
    expect(await f.service.publishedForTurn(f.token)).toEqual([])
    expect([...f.repository.allocations.values()].filter((value) => value.stored.value.revision.origin !== 'upload').every((value) => value.state === 'allocated')).toBe(true)
    fail.mockRestore()
    expect((await f.service.publish(f.token, input)).replayed).toBe(true)
  })

  it('deduplicates concurrent publishes in independent service instances', async () => {
    const f = await fileToolFixture(), { input } = await workingCopy(f)
    const other = new AgentFileToolService(f.files, f.sessions, f.artifacts, f.tools, undefined, f.clock)
    const [a, b] = await Promise.all([f.service.publish(f.token, input), other.publish(f.token, input)])
    expect(a.value).toEqual(b.value)
    expect(f.tools.links.size).toBe(1)
  })

  it('rejects foreign conversation scope, source and artifact despite matching Agent IDs', async () => {
    const f = await fileToolFixture(), foreignRef = await f.upload('secret', f.foreign)
    const downloads = f.bytes.downloads
    expect(await f.service.read(f.token, foreignRef)).toMatchObject({ status: 'unavailable', reason: 'forbidden' })
    await expect(f.service.list(f.token, { scope: f.foreign })).rejects.toMatchObject({ reason: 'forbidden' })
    await expect(f.service.createWorkingCopy(f.token, { commandId: randomUUID(), source: foreignRef, destination: f.scope })).rejects.toMatchObject({ reason: 'forbidden' })
    expect(f.bytes.downloads).toBe(downloads)
    const b = await f.issue({ scope: f.foreign, turnId: 'turn-b' })
    const artifact = await f.artifacts.create(b, 'result.md', 'text/markdown')
    await f.artifacts.completeWrite(b, artifact.artifactId, artifact.writeId, Readable.from([Buffer.from('secret')]))
    await expect(f.service.publish(f.token, { commandId: randomUUID(), artifactId: artifact.artifactId, scope: f.scope,
      filename: 'result.md', mediaType: 'text/markdown' })).rejects.toMatchObject({ code: 'FILE_ARTIFACT_NOT_FOUND' })
  })

  it('scope is only an assertion; extra caller/context/path fields are rejected', async () => {
    const f = await fileToolFixture(), { source, input } = await workingCopy(f)
    await expect(f.service.read(f.token, { ...source, ownerPrincipalId: 'owner-2' })).rejects.toThrow()
    await expect(f.service.publish(f.token, { ...input, scope: f.foreign })).rejects.toThrow()
    await expect(f.service.publish(f.token, { ...input, context: f.context })).rejects.toThrow()
    await expect(f.service.publish(f.token, { ...input, filename: '../outside.md' })).rejects.toThrow()
    const count = f.repository.values.size
    for (const artifactId of ['../outside', '/etc/passwd', 'file:///etc/passwd', 'https://example.invalid/file']) {
      await expect(f.service.publish(f.token, { ...input, artifactId })).rejects.toThrow()
    }
    expect(f.repository.values.size).toBe(count)
  })

  it('rejects every permanent destination and has no replace/remove operation', async () => {
    const f = await fileToolFixture(), { source, input } = await workingCopy(f)
    for (const scope of [{ kind: 'workspace_reference', workspaceId: 'workspace-a' },
      { kind: 'workflow_reference', workspaceId: 'workspace-a', workflowId: 'workflow-a' }]) {
      await expect(f.service.publish(f.token, { ...input, scope })).rejects.toThrow()
      await expect(f.service.createWorkingCopy(f.token, { commandId: randomUUID(), source, destination: scope })).rejects.toThrow()
    }
    await expect(f.service.publish(f.token, { ...input, target: source })).rejects.toThrow()
    expect(FILE_TOOL_NAMES).not.toContain('files.remove')
    expect(FILE_TOOL_NAMES).not.toContain('files.replace')
    await expect(f.service.list(f.token, { scope: { kind: 'workspace_reference', workspaceId: 'workspace-a' } })).rejects.toMatchObject({ code: 'FILE_REFERENCE_RESOLVER_REQUIRED' })
  })

  it('preserves accepted harness read-only restrictions and current owner grants', async () => {
    const f = await fileToolFixture(), { source, input } = await workingCopy(f)
    const readOnly = await f.issue({ allowMutation: false })
    expect((await f.service.read(readOnly, source)).status).toBe('ready')
    await expect(f.service.createWorkingCopy(readOnly, { commandId: randomUUID(), source, destination: f.scope })).rejects.toMatchObject({ code: 'FILE_TOOL_DENIED' })
    await expect(f.service.publish(readOnly, input)).rejects.toMatchObject({ code: 'FILE_TOOL_DENIED' })
    f.denyWrites()
    await expect(f.service.publish(f.token, input)).rejects.toMatchObject({ code: 'DENIED' })
  })

  it('a copy-only allowlist works without granting publish', async () => {
    const f = await fileToolFixture(), source = await f.upload()
    const token = await f.issue({ allowedTools: ['files.create_working_copy'] })
    const result = await f.service.createWorkingCopy(token, { commandId: randomUUID(), source, destination: f.scope })
    await expect(f.service.publish(token, { commandId: randomUUID(), artifactId: result.value.artifactId,
      scope: f.scope, filename: 'result.md', mediaType: 'text/markdown' })).rejects.toMatchObject({ code: 'FILE_TOOL_DENIED' })
  })

  it('rejects incomplete, interrupted and stale writers; never publishes a prior snapshot while writing', async () => {
    const f = await fileToolFixture(), handle = await f.artifacts.create(f.token, 'result.md', 'text/markdown')
    const input = { commandId: randomUUID(), artifactId: handle.artifactId, scope: f.scope, filename: 'result.md', mediaType: 'text/markdown' }
    await expect(f.service.publish(f.token, input)).rejects.toMatchObject({ code: 'FILE_ARTIFACT_INCOMPLETE' })
    const partial = Readable.from((async function* () { yield Buffer.from('half'); throw new Error('interrupted') })())
    await expect(f.artifacts.completeWrite(f.token, handle.artifactId, handle.writeId, partial)).rejects.toThrow('interrupted')
    await expect(f.service.publish(f.token, input)).rejects.toMatchObject({ code: 'FILE_ARTIFACT_INCOMPLETE' })
    const writeId = await f.artifacts.beginWrite(f.token, handle.artifactId)
    await expect(f.artifacts.completeWrite(f.token, handle.artifactId, handle.writeId, Readable.from([Buffer.from('stale')]))).rejects.toMatchObject({ code: 'FILE_ARTIFACT_WRITE_STALE' })
    await f.artifacts.completeWrite(f.token, handle.artifactId, writeId, Readable.from([Buffer.from('done')]))
    await f.artifacts.beginWrite(f.token, handle.artifactId)
    await expect(f.service.publish(f.token, input)).rejects.toMatchObject({ code: 'FILE_ARTIFACT_INCOMPLETE' })
    expect(f.tools.links.size).toBe(0)
  })

  it('denies expired reads, copies and source-backed publications without resurrecting bytes', async () => {
    const f = await fileToolFixture(), { source, input } = await workingCopy(f)
    await f.service.publish(f.token, input)
    f.advance(7 * 24 * 60 * 60 * 1_000)
    const token = await f.issue()
    expect(await f.service.read(token, source)).toMatchObject({ status: 'unavailable', reason: 'expired' })
    await expect(f.service.createWorkingCopy(token, { commandId: randomUUID(), source, destination: f.scope })).rejects.toMatchObject({ reason: 'expired' })
    await expect(f.service.publish(token, input)).rejects.toMatchObject({ reason: 'expired' })
    expect((await f.service.publishedForTurn(token)).length).toBe(1)
  })

  it('rejects a revoked owner after receiving bytes, before making the artifact complete', async () => {
    const f = await fileToolFixture(), handle = await f.artifacts.create(f.token, 'result.md', 'text/markdown')
    const source = Readable.from((async function* () { yield Buffer.from('complete'); f.revoke() })())
    await expect(f.artifacts.completeWrite(f.token, handle.artifactId, handle.writeId, source)).rejects.toMatchObject({ code: 'REVOKED' })
    expect(f.tools.artifacts.get(handle.artifactId)?.state).toBe('failed')
    expect(f.tools.links.size).toBe(0)
  })

  it('MCP authenticates with file-only credentials, limits discovery, denies writes and supports persisted readback', async () => {
    const f = await fileToolFixture(), { input } = await workingCopy(f), { app, rpc } = await endpoint(f)
    try {
      const catalog = await rpc('tools/list', {})
      expect(catalog.body.result?.tools?.map((tool) => tool.name).sort()).toEqual([...FILE_TOOL_NAMES].sort())
      for (const token of ['opm_operator-secret', 'worker-secret', 'invalid']) expect((await rpc('tools/list', {}, token)).status).toBe(401)
      const readOnly = await f.issue({ allowMutation: false })
      expect((await rpc('tools/list', {}, readOnly)).body.result?.tools?.map((tool) => tool.name).sort()).toEqual(['files.list', 'files.read'])
      const denied = await rpc('tools/call', { name: 'files.publish_result', arguments: input }, readOnly)
      expect(denied.body.result?.isError).toBe(true)
      expect(denied.body.result?.content?.[0]?.text).toContain('FILE_TOOL_DENIED')
      expect(f.tools.links.size).toBe(0)
      const published = await rpc('tools/call', { name: 'files.publish_result', arguments: input })
      expect(published.body.result?.isError).not.toBe(true)
      const readback = await rpc('tools/call', { name: 'files.list', arguments: { scope: f.scope } })
      expect(JSON.stringify(readback.body.result?.structuredContent)).toContain('result.md')
      expect(f.tools.links.size).toBe(1)
      await f.sessions.revoke(f.token)
      expect((await rpc('tools/list', {})).status).toBe(401)
    } finally { await app.close() }
  })
})
