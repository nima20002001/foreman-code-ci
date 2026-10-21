import type { ReadStream } from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { describe, it } from 'vitest'
import type { AgentFileReadInput, FileScope, FileWithRevision, PermanentFileScope, RunFileProvenance } from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../src/modules/errors.js'
import type { FileQuery, StoredFile } from '../src/modules/files/repository.js'
import { AgentReferenceAccess, type AgentReferenceDependencies } from '../src/modules/files/references/agentAccess.js'
import { AgentReferenceService } from '../src/modules/files/references/agentService.js'
import { agentFileReferenceResolver } from '../src/modules/files/tools/referenceResolver.js'
import type { AuthorizedFileCaller } from '../src/modules/files/tools/types.js'
import { conversationReferenceContext, decodeReferenceCursor, encodeReferenceCursor, effectiveReference,
  referenceCursorKey, type ReferenceConversationIdentity, type ReferenceExecutionIdentity } from '../src/modules/files/references/agentLineage.js'
import type { AgentReferenceContext } from '../src/modules/files/references/agentTypes.js'

const createdAt = '2026-09-28T00:00:00.000Z'
const readAt = '2026-09-28T01:00:00.000Z'
// The public service supplies these values from the frozen contract. This suite also runs without runtime schema dependencies.
const limits = { maxPageSize: 100, maxReadBytes: 64 * 1024, maxFileBytes: 25 * 1024 * 1024 }
const A: AgentReferenceContext = { workspaceId: 'W', workflowId: 'A', agentId: 'same-agent', runId: 'run-A', executionId: 'execution-A' }
const B: AgentReferenceContext = { workspaceId: 'W', workflowId: 'B', agentId: 'same-agent', runId: 'run-B', executionId: 'execution-B' }
const Z: AgentReferenceContext = { workspaceId: 'Z', workflowId: 'C', agentId: 'same-agent', runId: 'run-Z', executionId: 'execution-Z' }
const principal = (id: string): ManagementPrincipal => ({ id, name: id, audience: 'worker', agentId: 'same-agent',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [] })
const callerA = principal('caller-A'), callerB = principal('caller-B'), callerZ = principal('caller-Z')
const operator: ManagementPrincipal = { ...principal('operator'), audience: 'operator' }
const subject = { kind: 'execution' as const }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const key = (...parts: string[]) => JSON.stringify(parts)
const input = (fileId: string, revisionId = `rev-${fileId}`, offset = 0, length = limits.maxReadBytes): AgentFileReadInput =>
  ({ fileId, revisionId, offset, length })

function fixture() {
  const contexts = new Map<string, AgentReferenceContext | null>([[callerA.id, A], [callerB.id, B], [callerZ.id, Z], [operator.id, null]])
  const records = new Map<string, StoredFile>(), content = new Map<string, Buffer>(), heads = new Map<string, string>()
  const pins = new Map<string, string>(), facts = new Map<string, RunFileProvenance>()
  const calls = { list: 0, metadata: 0, download: 0, complete: 0, authorize: 0 }
  const streams: Readable[] = []
  let downloadHook: (() => void) | undefined
  const add = (fileId: string, scope: FileScope, text = `bytes for ${fileId}`, revisionId = `rev-${fileId}`) => {
    const bytes = Buffer.from(text)
    const file = { fileId, currentRevisionId: revisionId, createdAt, scope, state: 'ready',
      ...(scope.kind === 'temporary' ? { retentionDurationSeconds: 86400, expiresAt: '2026-09-29T00:00:00.000Z' } : {}) }
    const value = { file, revision: { fileId, revisionId, filename: 'same-name.md', mediaType: 'text/markdown',
      byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), origin: 'upload', createdAt } } as FileWithRevision
    const storageKey = key(fileId, revisionId)
    records.set(storageKey, { value, storageKey, ownerPrincipalId: 'uploader' }); content.set(storageKey, bytes)
    heads.set(fileId, revisionId)
    // A synthetic changed head tests historical-read behavior even though FIL-36 forbids it in production.
    for (const stored of records.values()) if (stored.value.file.fileId === fileId) stored.value.file.currentRevisionId = revisionId
    return value
  }
  const remove = (fileId: string) => {
    for (const stored of records.values()) if (stored.value.file.fileId === fileId) stored.value.file.state = 'removed'
  }
  const sameScope = (left: FileScope, right: FileScope) => left.kind === right.kind && left.kind !== 'temporary'
    && right.kind !== 'temporary' && left.workspaceId === right.workspaceId
    && (left.kind !== 'workflow_reference' || right.kind === 'workflow_reference' && left.workflowId === right.workflowId)
  const dependencies: AgentReferenceDependencies = {
    clock: () => new Date(readAt),
    authorization: { async resolve(who) {
      calls.authorize++
      if (!contexts.has(who.id)) throw new DomainError('AUTH_REVOKED', 'Revoked', 403)
      return clone(contexts.get(who.id)!)
    } },
    files: {
      async read(fileId, revisionId) { calls.metadata++; const stored = records.get(key(fileId, revisionId)); return stored ? clone(stored) : undefined },
      async list(scope, page) {
        calls.list++
        const all = [...heads].map(([id, revision]) => records.get(key(id, revision))!.value)
          .filter((value) => sameScope(value.file.scope, scope)).sort((left, right) => left.file.fileId.localeCompare(right.file.fileId))
        const offset = page.cursor ? Number(page.cursor.slice(3)) : 0
        const items = all.slice(offset, offset + page.limit)
        return { items: clone(items), pageInfo: { nextCursor: offset + items.length < all.length ? `at:${offset + items.length}` : null } }
      },
    },
    bytes: { async download(storageKey, _expected, range) {
      calls.download++; downloadHook?.()
      const bytes = content.get(storageKey)
      if (!bytes) throw new DomainError('FILE_BYTES_UNAVAILABLE', 'Missing bytes', 410)
      const selected = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes
      const stream = Readable.from([selected.subarray(0, 3), selected.subarray(3)])
      streams.push(stream)
      return stream as unknown as ReadStream
    } },
    reads: {
      async pinned(runId, fileIds) {
        return new Map(fileIds.flatMap((fileId) => {
          const revisionId = pins.get(key(runId, fileId)); return revisionId ? [[fileId, revisionId] as const] : []
        }))
      },
      async complete(context, ref, at, authorize) {
        calls.complete++
        await authorize({} as FileQuery)
        const stored = records.get(key(ref.fileId, ref.revisionId))
        if (!stored || !effectiveReference(context, stored.value.file.scope)) return 'not_found'
        if (stored.value.file.state === 'pending' || stored.value.file.state === 'removed') return stored.value.file.state
        if (context.runId) {
          const identity = key(context.runId, ref.fileId), previous = pins.get(identity)
          if (previous && previous !== ref.revisionId) throw new DomainError('FILE_REFERENCE_PIN_CONFLICT', 'Different pin', 409)
          pins.set(identity, ref.revisionId)
          const factKey = key(context.runId, context.executionId, ref.fileId)
          if (!facts.has(factKey)) facts.set(factKey, { ...ref, runId: context.runId, executionId: context.executionId, readAt: at })
        }
        return 'ready'
      },
    },
  }
  add('file-A', { kind: 'workflow_reference', workspaceId: 'W', workflowId: 'A' })
  add('file-B', { kind: 'workflow_reference', workspaceId: 'W', workflowId: 'B' })
  add('file-W', { kind: 'workspace_reference', workspaceId: 'W' })
  add('file-Z', { kind: 'workspace_reference', workspaceId: 'Z' })
  return { access: new AgentReferenceAccess(dependencies, limits), dependencies, contexts, records, heads, content, pins, facts,
    calls, streams, add, remove, onDownload(hook: () => void) { downloadHook = hook } }
}

describe('FIL-37 effective reference access', () => {
  it('adapts the authenticated conversation to scoped file-tool list and bounded read', async () => {
    const f = fixture()
    const resolver = agentFileReferenceResolver(new AgentReferenceService(f.dependencies), {
      read: async (fileId, revisionId) => f.records.get(key(fileId, revisionId)),
    })
    const caller: AuthorizedFileCaller = { principal: callerA, binding: 'binding', context: {
      ownerPrincipalId: callerA.id, nativeSessionId: 'native', turnId: 'turn', allowMutation: false,
      allowedTools: ['files.list', 'files.read'], scope: { kind: 'temporary', chat: {
        kind: 'agent', conversationId: 'chat-A', agentId: 'same-agent', workspaceId: 'W', workflowId: 'A',
        runId: 'run-A', executionId: 'execution-A',
      } },
    } }
    const workflow = await resolver.list(caller, { kind: 'workflow_reference', workspaceId: 'W', workflowId: 'A' }, { limit: 100 })
    const workspace = await resolver.list(caller, { kind: 'workspace_reference', workspaceId: 'W' }, { limit: 100 })
    assert.deepEqual(workflow.items.map((row) => row.file.fileId), ['file-A'])
    assert.deepEqual(workspace.items.map((row) => row.file.fileId), ['file-W'])
    const result = await resolver.read(caller, input('file-A', 'rev-file-A', 0, 5))
    assert.equal(result.status, 'ready')
    if (result.status === 'ready') assert.equal(Buffer.from(result.contentBase64, 'base64').toString(), 'bytes')
    assert.equal(f.facts.size, 1)
    assert.deepEqual(await resolver.read(caller, input('file-B')), {
      status: 'unavailable', ref: { fileId: 'file-B', revisionId: 'rev-file-B' }, reason: 'not_found',
    })
    f.contexts.delete(callerA.id)
    await assert.rejects(resolver.list(caller, { kind: 'workspace_reference', workspaceId: 'W' }, { limit: 100 }), { code: 'AUTH_REVOKED' })
  })

  it('A and B inherit W only; same Agent IDs and filenames do not grant sibling or Z access', async () => {
    const f = fixture()
    assert.deepEqual((await f.access.list(callerA, subject, { limit: 100 })).items.map((row) => row.fileId), ['file-A', 'file-W'])
    assert.deepEqual((await f.access.list(callerB, subject, { limit: 100 })).items.map((row) => row.fileId), ['file-B', 'file-W'])
    assert.deepEqual((await f.access.list(callerZ, subject, { limit: 100 })).items.map((row) => row.fileId), ['file-Z'])
    for (const fileId of ['file-B', 'file-Z', 'missing']) {
      assert.deepEqual(await f.access.read(callerA, subject, input(fileId)), {
        status: 'unavailable', ref: { fileId, revisionId: `rev-${fileId}` }, reason: 'not_found',
      })
    }
    assert.equal(f.calls.download, 0); assert.equal(f.facts.size, 0)
  })

  it('lists only compact metadata, keeps duplicate names, and does not pin or read bytes', async () => {
    const f = fixture(), result = await f.access.list(callerA, subject, { limit: 100 })
    assert.equal(result.items.length, 2)
    for (const item of result.items) {
      assert.equal(item.filename, 'same-name.md')
      assert.deepEqual(Object.keys(item).sort(), ['fileId', 'revisionId', 'filename', 'mediaType', 'byteSize', 'scope', 'state'].sort())
    }
    assert.equal(f.calls.download, 0); assert.equal(f.facts.size, 0); assert.equal(f.pins.size, 0)
  })

  it('a global Operator gets nothing and never probes a file, even with a known valid pin', async () => {
    const f = fixture()
    assert.deepEqual(await f.access.list(operator, subject, { limit: 10 }), { items: [], pageInfo: { nextCursor: null } })
    assert.equal((await f.access.read(operator, subject, input('file-A'))).status, 'unavailable')
    assert.equal(f.calls.list, 0); assert.equal(f.calls.metadata, 0); assert.equal(f.calls.download, 0)
  })

  it('never admits temporary conversation files through inherited reference reads', async () => {
    const f = fixture()
    f.add('temporary', { kind: 'temporary', chat: { kind: 'agent', conversationId: 'chat-A',
      workspaceId: 'W', workflowId: 'A', agentId: 'same-agent', runId: 'run-A', executionId: 'execution-A' } })
    assert.equal((await f.access.read(callerA, subject, input('temporary'))).status, 'unavailable')
    assert.equal(f.calls.download, 0); assert.equal(f.calls.complete, 0)
  })

  it('pages both exact scopes with no duplicate IDs, at most two queries per page', async () => {
    const f = fixture(), ids: string[] = []
    for (let n = 0; n < 5; n++) f.add(`extra-${n}`, { kind: 'workflow_reference', workspaceId: 'W', workflowId: 'A' })
    let cursor: string | undefined
    let pages = 0
    do {
      const before = f.calls.list
      const page = await f.access.list(callerA, subject, { limit: 2, ...(cursor ? { cursor } : {}) })
      assert.ok(page.items.length <= 2); assert.ok(f.calls.list - before <= 2)
      ids.push(...page.items.map((item) => item.fileId)); cursor = page.pageInfo.nextCursor ?? undefined
      assert.ok(++pages <= 5)
    } while (cursor)
    assert.equal(ids.length, 7); assert.equal(new Set(ids).size, 7); assert.ok(ids.includes('file-W'))
  })

  it('rejects cross-Run, cross-execution, cross-caller, and corrupt cursors before listing metadata', async () => {
    const f = fixture()
    const cursor = (await f.access.list(callerA, subject, { limit: 1 })).pageInfo.nextCursor!
    for (const who of [callerB, callerZ, { ...callerA, id: 'other-caller' }]) {
      if (who.id === 'other-caller') f.contexts.set(who.id, A)
      const before = f.calls.list
      await assert.rejects(f.access.list(who, subject, { limit: 1, cursor }), { code: 'FILE_CURSOR_INVALID' })
      assert.equal(f.calls.list, before)
    }
    f.contexts.set(callerA.id, { ...A, executionId: 'different-execution' })
    await assert.rejects(f.access.list(callerA, subject, { limit: 1, cursor }), { code: 'FILE_CURSOR_INVALID' })
    for (const bad of ['', 'x', cursor + '=', 'a'.repeat(4097)]) {
      await assert.rejects(f.access.list(callerB, subject, { limit: 1, cursor: bad }), { code: 'FILE_CURSOR_INVALID' })
    }
  })

  it('reads exact bounded bytes, closes the descriptor and records the exact Run/execution pin', async () => {
    const f = fixture()
    const result = await f.access.read(callerA, subject, input('file-A', undefined, 2, 4))
    assert.equal(result.status, 'ready')
    if (result.status !== 'ready') return
    assert.equal(Buffer.from(result.contentBase64, 'base64').toString(), 'tes ')
    assert.equal(result.offset, 2); assert.equal(result.byteLength, 4); assert.equal(result.eof, false)
    assert.equal(f.streams[0]!.destroyed, true)
    assert.deepEqual([...f.facts.values()], [{ fileId: 'file-A', revisionId: 'rev-file-A', runId: A.runId,
      executionId: A.executionId, readAt }])
  })

  it('clips EOF and accepts empty Markdown, while invalid ranges never touch bytes or provenance', async () => {
    const f = fixture()
    f.add('empty', { kind: 'workflow_reference', workspaceId: 'W', workflowId: 'A' }, '')
    const empty = await f.access.read(callerA, subject, input('empty'))
    assert.equal(empty.status, 'ready')
    if (empty.status === 'ready') { assert.equal(empty.contentBase64, ''); assert.equal(empty.byteLength, 0); assert.equal(empty.eof, true) }
    const size = f.records.get(key('file-A', 'rev-file-A'))!.value.revision.byteSize
    const eof = await f.access.read(callerA, subject, input('file-A', undefined, size))
    assert.equal(eof.status, 'ready')
    if (eof.status === 'ready') { assert.equal(eof.byteLength, 0); assert.equal(eof.eof, true) }
    const before = f.calls.download, facts = f.facts.size
    for (const [offset, length] of [[-1, 1], [0, 0], [0, 65537], [0.5, 1], [size + 1, 1], [Infinity, 1]]) {
      await assert.rejects(f.access.read(callerA, subject, input('file-A', undefined, offset, length)), { code: 'FILE_RANGE_INVALID' })
    }
    assert.equal(f.calls.download, before); assert.equal(f.facts.size, facts)
  })

  it('caps large-file read responses at the frozen 64 KiB range', async () => {
    const f = fixture()
    f.add('large', { kind: 'workflow_reference', workspaceId: 'W', workflowId: 'A' }, 'x'.repeat(200_000))
    const result = await f.access.read(callerA, subject, input('large'))
    assert.equal(result.status, 'ready')
    if (result.status === 'ready') { assert.equal(result.byteLength, 65536); assert.equal(result.eof, false) }
  })

  it('mixed file/revision IDs never fall back to a head', async () => {
    const f = fixture()
    assert.equal((await f.access.read(callerA, subject, input('file-A', 'rev-file-B'))).status, 'unavailable')
    assert.equal(f.calls.download, 0); assert.equal(f.facts.size, 0)
  })

  it('a missing object is unavailable and never creates provenance', async () => {
    const f = fixture(); f.content.delete(key('file-A', 'rev-file-A'))
    assert.deepEqual(await f.access.read(callerA, subject, input('file-A')), {
      status: 'unavailable', ref: { fileId: 'file-A', revisionId: 'rev-file-A' }, reason: 'not_found',
    })
    assert.equal(f.facts.size, 0); assert.equal(f.calls.complete, 0)
  })

  it('truncated or failed storage reads close streams and never create provenance', async () => {
    for (const fails of [false, true]) {
      const f = fixture()
      const source = fails ? Readable.from((async function* () { yield Buffer.from('x'); throw new Error('storage failed') })())
        : Readable.from([Buffer.from('x')])
      f.dependencies.bytes.download = async () => source as unknown as ReadStream
      await assert.rejects(f.access.read(callerA, subject, input('file-A')))
      assert.equal(source.destroyed, true); assert.equal(f.facts.size, 0); assert.equal(f.calls.complete, 0)
    }
  })

  it('repeated reads and ranges keep one immutable first-read fact per execution', async () => {
    const f = fixture()
    await f.access.read(callerA, subject, input('file-A'))
    f.dependencies.clock = () => new Date('2026-09-28T02:00:00.000Z')
    await f.access.read(callerA, subject, input('file-A', undefined, 1, 2))
    assert.equal(f.facts.size, 1); assert.equal([...f.facts.values()][0]!.readAt, readAt)
    f.contexts.set(callerA.id, { ...A, executionId: 'second-execution-A' })
    await f.access.read(callerA, subject, input('file-A'))
    assert.equal(f.pins.size, 1); assert.equal(f.facts.size, 2)
  })

  it('old Runs list/read their old revision; a new Run can pin a different revision', async () => {
    const f = fixture()
    await f.access.read(callerA, subject, input('file-A'))
    f.add('file-A', { kind: 'workflow_reference', workspaceId: 'W', workflowId: 'A' }, 'new bytes', 'new-revision')
    const oldManifest = await f.access.list(callerA, subject, { limit: 100 })
    assert.equal(oldManifest.items.find((item) => item.fileId === 'file-A')!.revisionId, 'rev-file-A')
    const old = await f.access.read(callerA, subject, input('file-A'))
    assert.equal(old.status, 'ready')
    if (old.status === 'ready') assert.equal(Buffer.from(old.contentBase64, 'base64').toString(), 'bytes for file-A')
    const before = f.calls.download
    await assert.rejects(f.access.read(callerA, subject, input('file-A', 'new-revision')), { code: 'FILE_REFERENCE_PIN_CONFLICT' })
    assert.equal(f.calls.download, before)
    f.contexts.set(callerA.id, { ...A, runId: 'new-run-A', executionId: 'new-execution-A' })
    const newer = await f.access.read(callerA, subject, input('file-A', 'new-revision'))
    assert.equal(newer.status, 'ready')
    assert.equal(f.pins.get(key('run-A', 'file-A')), 'rev-file-A')
    assert.equal(f.pins.get(key('new-run-A', 'file-A')), 'new-revision')
  })

  it('a removed previously-read reference stays unavailable and preserves old pins and facts', async () => {
    const f = fixture()
    await f.access.read(callerA, subject, input('file-A'))
    const facts = clone([...f.facts.values()]); f.remove('file-A')
    assert.deepEqual(await f.access.read(callerA, subject, input('file-A')), {
      status: 'unavailable', ref: { fileId: 'file-A', revisionId: 'rev-file-A' }, reason: 'removed',
    })
    assert.equal(f.calls.download, 1); assert.deepEqual([...f.facts.values()], facts)
    assert.equal((await f.access.list(callerA, subject, { limit: 100 })).items.find((row) => row.fileId === 'file-A')!.state, 'removed')
  })

  it('removal while bytes are being read prevents a ready response and a first-use pin', async () => {
    const f = fixture(); f.onDownload(() => f.remove('file-A'))
    const result = await f.access.read(callerA, subject, input('file-A'))
    assert.equal(result.status, 'unavailable')
    if (result.status === 'unavailable') assert.equal(result.reason, 'removed')
    assert.equal(f.facts.size, 0); assert.equal(f.pins.size, 0); assert.equal(f.streams[0]!.destroyed, true)
  })

  it('revocation and conversation/execution changes during a read fail before provenance or content delivery', async () => {
    for (const revoke of [true, false]) {
      const f = fixture()
      f.onDownload(() => { if (revoke) f.contexts.delete(callerA.id); else f.contexts.set(callerA.id, B) })
      await assert.rejects(f.access.read(callerA, subject, input('file-A')), {
        code: revoke ? 'AUTH_REVOKED' : 'FILE_REFERENCE_CONTEXT_CHANGED',
      })
      assert.equal(f.facts.size, 0); assert.equal(f.pins.size, 0); assert.equal(f.streams[0]!.destroyed, true)
    }
  })

  it('ordinary Agent conversations inherit their workflow but do not invent Run provenance', async () => {
    const f = fixture()
    f.contexts.set(callerA.id, { workspaceId: 'W', workflowId: 'A', agentId: 'same-agent', conversationId: 'chat-A' })
    assert.equal((await f.access.list(callerA, { kind: 'conversation', conversationId: 'chat-A' }, { limit: 100 })).items.length, 2)
    assert.equal((await f.access.read(callerA, { kind: 'conversation', conversationId: 'chat-A' }, input('file-A'))).status, 'ready')
    assert.equal(f.facts.size, 0); assert.equal(f.pins.size, 0)
  })

  it('pending references are unavailable and there are no Agent mutation methods', async () => {
    const f = fixture(); f.records.get(key('file-A', 'rev-file-A'))!.value.file.state = 'pending'
    const result = await f.access.read(callerA, subject, input('file-A'))
    assert.equal(result.status, 'unavailable')
    if (result.status === 'unavailable') assert.equal(result.reason, 'pending')
    for (const method of ['write', 'replace', 'remove', 'publish', 'upload', 'finalize', 'allocate']) {
      assert.equal(method in f.access, false)
    }
    assert.equal(f.calls.download, 0); assert.equal(f.facts.size, 0)
  })
})

describe('FIL-37 persisted conversation lineage and cursor policy', () => {
  const row: ReferenceConversationIdentity = { id: 'chat-A', kind: 'agent', workspace_id: 'W', workflow_id: 'A',
    agent_id: 'same-agent', origin_run_id: 'run-A', origin_execution_id: 'execution-A' }
  const origin: ReferenceExecutionIdentity = { workspace_id: 'W', workflow_id: 'A', agent_id: 'same-agent',
    run_id: 'run-A', execution_id: 'execution-A' }

  it('preserves the historical origin without a current graph or Agent definition', () => {
    assert.deepEqual(conversationReferenceContext(row, origin), { ...A, conversationId: 'chat-A' })
  })
  for (const field of ['workspace_id', 'workflow_id', 'agent_id', 'run_id', 'execution_id'] as const) {
    it(`rejects a mixed historical ${field}, even if the other IDs match`, () => {
      assert.throws(() => conversationReferenceContext(row, { ...origin, [field]: 'different' }), { code: 'FILE_REFERENCE_ACCESS_DENIED' })
    })
  }
  it('rejects incomplete or missing origins and malformed Agent conversations', () => {
    assert.throws(() => conversationReferenceContext(row), { code: 'FILE_REFERENCE_ACCESS_DENIED' })
    for (const field of ['origin_run_id', 'origin_execution_id', 'workspace_id', 'workflow_id', 'agent_id'] as const) {
      assert.throws(() => conversationReferenceContext({ ...row, [field]: null }, origin), { code: 'FILE_REFERENCE_ACCESS_DENIED' })
    }
  })
  it('never derives a global Operator scope from Board-looking columns', () => {
    assert.equal(conversationReferenceContext({ ...row, kind: 'operator' }, origin), null)
  })
  it('supports a real non-Run Agent conversation without inventing execution IDs', () => {
    assert.deepEqual(conversationReferenceContext({ ...row, origin_run_id: null, origin_execution_id: null }), {
      conversationId: 'chat-A', workspaceId: 'W', workflowId: 'A', agentId: 'same-agent',
    })
  })
  it('checks both scope dimensions; same workflow ID in another workspace is foreign', () => {
    const scopes: PermanentFileScope[] = [
      { kind: 'workflow_reference', workspaceId: 'Z', workflowId: 'A' },
      { kind: 'workflow_reference', workspaceId: 'W', workflowId: 'B' },
      { kind: 'workspace_reference', workspaceId: 'Z' },
    ]
    for (const scope of scopes) assert.equal(effectiveReference(A, scope), false)
  })
  it('round-trips strict versioned cursors and rejects extra input fields', () => {
    const scope = referenceCursorKey(callerA.id, A)
    assert.deepEqual(decodeReferenceCursor(encodeReferenceCursor(scope, { phase: 1, cursor: 'inner' }), scope), { phase: 1, cursor: 'inner' })
    for (const value of [{ version: 1, key: scope, phase: 2 }, { version: 1, key: scope, phase: 0, workflowId: 'B' },
      { version: 1, key: scope, phase: 0, cursor: '' }, []]) {
      assert.throws(() => decodeReferenceCursor(Buffer.from(JSON.stringify(value)).toString('base64url'), scope), { code: 'FILE_CURSOR_INVALID' })
    }
  })
})
