import assert from 'node:assert/strict'
import { onTestFinished, test } from 'vitest'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { setImmediate as immediate } from 'node:timers/promises'
import { AgentFileReadResultSchema, FILE_EXTENSIONS_BY_MEDIA_TYPE, FILE_MEDIA_TYPES, FileWithRevisionSchema } from '@foreman-code/contracts/files'
import { CodexFileTurn } from '../src/modules/harnesses/codexFiles/turn.js'
import { assertRegisteredCodexCopy, collectCodexFileBytes, sha256 } from '../src/modules/harnesses/codexFiles/bytes.js'
import type { AcceptedCodexFileTurn, CodexFileServices, CodexFileHostLease, CodexFileCall } from '../src/modules/harnesses/codexFiles/port.js'
import type { CodexFileTurnDependencies } from '../src/modules/harnesses/codexFiles/turn.js'

// These are explicitly in-memory service/host fakes. They do not claim FIL-05,
// PostgreSQL, OS sandbox, reference permission, or existing adapter integration coverage.
const now = new Date('2026-09-28T00:00:00.000Z')
const scope = { kind: 'temporary', chat: { kind: 'operator', ownerPrincipalId: 'owner', operatorId: 'operator', conversationId: 'conversation' } } as const
const ref = { fileId: 'file-a', revisionId: 'revision-a' }
const tools = ['files.list', 'files.read', 'files.create_working_copy', 'files.publish_result'] as const
const token = `gql_file_${'a'.repeat(43)}`
const artifactId = 'artifact-a'
const clone = <T>(value: T): T => structuredClone(value)

function fixture(options: { mode?: 'read' | 'write'; allowMutation?: boolean; bytes?: Buffer; mediaType?: string; filename?: string } = {}) {
  const bytes = options.bytes ?? Buffer.from('# Input\noriginal\n')
  const accepted: AcceptedCodexFileTurn = {
    ownerPrincipalId: 'owner', scope: clone(scope), nativeSessionId: 'thread-a', admissionId: 'admission-a',
    messageId: 'message-a', executionHostId: 'execution-host-a', projectMode: options.mode ?? 'write',
    allowMutation: options.allowMutation ?? options.mode !== 'read', allowedTools: [...tools],
    expiresAt: new Date(now.getTime() + 600_000), attachments: [clone(ref)],
  }
  let value = {
    file: { fileId: ref.fileId, currentRevisionId: ref.revisionId, scope: clone(scope), state: 'ready',
      createdAt: now.toISOString(), retentionDurationSeconds: 3600, expiresAt: new Date(now.getTime() + 3600_000).toISOString() },
    revision: { ...ref, filename: options.filename ?? 'input.md', mediaType: options.mediaType ?? 'text/markdown',
      byteSize: bytes.length, sha256: sha256(bytes), origin: 'upload', createdAt: now.toISOString() },
  }
  const calls: string[] = [], issued: unknown[] = []
  const registrations = new Map<string, { bytes: Buffer; writable: boolean; sealed: boolean }>()
  let revoked = false, completed: Buffer | undefined, busy = false, publicationHash: string | undefined
  let hostCalls = 0, sealCalls = 0
  const authenticate = async (given: string, name?: string) => {
    if (given !== token || revoked || (name && !accepted.allowedTools.includes(name as typeof tools[number]))) throw new Error('denied')
    if (name && name !== 'files.list' && name !== 'files.read' && !accepted.allowMutation) throw new Error('denied')
    return { context: issued[0], binding: 'binding', principal: { id: 'owner' } }
  }
  const services = {
    sessions: {
      issueForAcceptedSession: async (context: unknown, expiry: Date) => {
        assert.ok(expiry > now); issued.push(clone(context)); calls.push('issue'); return token
      },
      authenticate,
      revoke: async (given: string) => { assert.equal(given, token); revoked = true; calls.push('revoke') },
    },
    artifacts: {
      beginWrite: async (given: string, id: string) => {
        await authenticate(given, 'files.publish_result'); assert.equal(id, artifactId)
        if (busy) throw new Error('busy'); busy = true; calls.push('beginWrite'); return 'writer-a'
      },
      abortWrite: async () => { busy = false; calls.push('abortWrite') },
      completeWrite: async (given: string, id: string, writer: string, stream: Readable) => {
        assert.equal(id, artifactId); assert.equal(writer, 'writer-a')
        const data = await collectCodexFileBytes(stream, 1024)
        await authenticate(given, 'files.publish_result'); completed = data; busy = false; calls.push('completeWrite')
      },
    },
    list: async (given: string) => { await authenticate(given, 'files.list'); calls.push('list'); return { items: [clone(value)], pageInfo: { nextCursor: null } } },
    read: async (given: string, raw: unknown) => {
      await authenticate(given, 'files.read')
      const input = raw as { fileId: string; revisionId: string; offset: number; length: number }
      assert.equal(input.fileId, ref.fileId); assert.equal(input.revisionId, ref.revisionId)
      calls.push('read')
      const part = bytes.subarray(input.offset, input.offset + input.length)
      return { status: 'ready', ...clone(value), readAt: now.toISOString(), offset: input.offset,
        byteLength: part.length, contentBase64: part.toString('base64'), eof: input.offset + part.length === bytes.length }
    },
    createWorkingCopy: async (given: string) => {
      await authenticate(given, 'files.create_working_copy'); calls.push('copy')
      return { value: { artifactId, source: clone(ref), destination: clone(scope), filename: value.revision.filename,
        createdAt: now.toISOString() }, replayed: calls.filter((call) => call === 'copy').length > 1 }
    },
    writeWorkingCopy: async (given: string, raw: unknown) => {
      await authenticate(given, 'files.write_working_copy')
      completed = Buffer.from((raw as { contentBase64: string }).contentBase64, 'base64')
      calls.push('writeWorkingCopy')
      return { artifactId, revisionId: 'edited-revision', byteSize: completed.length, sha256: sha256(completed) }
    },
    applyFormatEdit: async (given: string, raw: unknown) => {
      await authenticate(given, 'files.apply_format_edit')
      completed = Buffer.concat([completed!, Buffer.from((raw as { edit: { text: string } }).edit.text)])
      calls.push('applyFormatEdit')
      return { artifactId, revisionId: 'formatted-revision', byteSize: completed.length, sha256: sha256(completed) }
    },
    publish: async (given: string) => {
      await authenticate(given, 'files.publish_result')
      if (busy || !completed) throw new Error('incomplete')
      calls.push('publish')
      const hash = sha256(completed)
      if (publicationHash && publicationHash !== hash) throw new Error('conflict')
      const replayed = !!publicationHash; publicationHash = hash
      return { value: { file: { ...value.file, fileId: 'result-file', currentRevisionId: 'result-revision' },
        revision: { ...value.revision, fileId: 'result-file', revisionId: 'result-revision', byteSize: completed.length,
          sha256: hash, origin: hash === value.revision.sha256 ? 'agent_copy' : 'agent_output' } }, replayed }
    },
    publishedForTurn: async (given: string) => { await authenticate(given, 'files.list'); return publicationHash ? [{ fileId: 'result-file', revisionId: 'result-revision' }] : [] },
  } as unknown as CodexFileServices
  const host: CodexFileHostLease = {
    executionHostId: accepted.executionHostId, pathStyle: 'posix',
    materialize: async (input) => {
      const data = await collectCodexFileBytes(input.bytes, 1024)
      assert.equal(sha256(data), input.sha256); assert.equal(data.length, input.byteSize)
      const registrationId = `registration-${++hostCalls}`
      registrations.set(registrationId, { bytes: data, writable: input.writable, sealed: false })
      calls.push(input.writable ? 'materialize:write' : 'materialize:read')
      return { registrationId, executionHostId: accepted.executionHostId,
        executionPath: `/execution-only/lease/${registrationId}/${input.filename}`,
        writable: input.writable, byteSize: data.length, sha256: sha256(data) }
    },
    sealCompleted: async (id) => {
      sealCalls++
      const item = registrations.get(id); assert.ok(item); assert.equal(item.writable, true)
      item.sealed = true; calls.push('seal'); return Readable.from([Buffer.from(item.bytes)])
    },
    close: async () => { calls.push('host:close'); registrations.clear() },
  }
  // Deliberately lightweight test parser; production index.ts uses frozen Zod schemas.
  // Tests below prove parser ordering, not schema implementation equivalence.
  const parseCall: CodexFileTurnDependencies['parseCall'] = (name, raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid')
    const input = raw as Record<string, unknown>
    const keys = name === 'files.list' ? ['scope', 'limit', 'cursor'] : name === 'files.read'
      ? ['fileId', 'revisionId', 'offset', 'length'] : name === 'files.create_working_copy'
        ? ['commandId', 'source', 'destination'] : name === 'files.write_working_copy'
          ? ['artifactId', 'contentBase64', 'baseRevisionId'] : name === 'files.apply_format_edit'
            ? ['artifactId', 'edit', 'baseRevisionId'] : ['commandId', 'artifactId', 'scope', 'filename', 'mediaType']
    if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error('extra field')
    if (name === 'files.publish_result' && (typeof input.artifactId !== 'string' || input.mediaType !== value.revision.mediaType)) throw new Error('invalid')
    return clone(input)
  }
  const dependencies: CodexFileTurnDependencies = {
    files: services, host, limits: { fileBytes: 1024, readBytes: 4, attachments: 10 }, clock: () => now,
    source: {
      open: async () => ({ value: clone(value), stream: Readable.from([Buffer.from(bytes)]) }) as never,
      recheck: async () => clone(value) as never,
    },
    parseRead: (_request, result) => result as Awaited<ReturnType<CodexFileServices['read']>>,
    parseCall,
  }
  const request = (tool: string, arguments_: unknown): CodexFileCall => ({ threadId: accepted.nativeSessionId, turnId: 'turn-a', tool, arguments: arguments_ })
  const copyRequest = () => request('files_create_working_copy', { commandId: 'copy-command', source: ref, destination: scope })
  const publishRequest = () => request('files_publish_result', { commandId: 'publish-command', artifactId, scope,
    filename: 'result.md', mediaType: value.revision.mediaType })
  return {
    accepted, dependencies, services, host, calls, issued, registrations, bytes, request, copyRequest, publishRequest,
    prepare: () => CodexFileTurn.prepare(accepted, dependencies),
    value: () => value, setValue: (next: typeof value) => { value = next },
    completed: () => completed, sealCalls: () => sealCalls,
    edit: (text: string) => {
      const writable = [...registrations.values()].find((item) => item.writable)
      assert.ok(writable); assert.equal(writable.sealed, false); writable.bytes = Buffer.from(text)
    },
  }
}

async function active(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options), turn = await f.prepare()
  await turn.activate('turn-a')
  return { ...f, turn }
}

test('delivery contains only execution-host paths, exact pins and unchanged user text', async () => {
  const f = fixture(), turn = await f.prepare(), input = await turn.nativeInput('Read this')
  assert.equal(f.issued.length, 0)
  assert.equal(input.length, 1); assert.equal(input[0]!.type, 'text')
  const text = JSON.stringify(input)
  assert.match(text, /execution-only/); assert.match(text, /revision-a/)
  assert.ok(!text.includes(f.bytes.toString('base64'))); assert.ok(!text.includes('original'))
  assert.equal([...f.registrations.values()][0]!.writable, false)
  assert.deepEqual(await turn.nativeInput('Read this'), input)
  await turn.close()
})

test('attached file instructions provide the accepted scope needed by file tools', async () => {
  const f = fixture(), turn = await f.prepare()
  const input = await turn.nativeInput('Edit the attachment')
  assert.equal(input[0]?.type, 'text')
  const prompt = input[0].text
  const match = prompt.match(/File tool scope \(use this exact value for scope or destination\): (\{[^\n]+\})/)
  assert.ok(match)
  const suppliedScope = JSON.parse(match[1]!)
  assert.deepEqual(suppliedScope, scope)
  await turn.activate('turn-a')
  assert.equal((await turn.call(f.request('files_create_working_copy', {
    commandId: 'from-instructions', source: ref, destination: suppliedScope,
  }))).success, true)
  assert.ok(f.calls.includes('copy'))
  await turn.close()
})

test('image delivered by native localImage path, with first-frame notice rather than inline binary', async () => {
  const f = fixture({ mediaType: 'image/gif', filename: 'animation.gif', bytes: Buffer.from('fake-gif-bytes') })
  f.dependencies.prepareImage = async () => ({ bytes: Buffer.from('fake-png-preview'), mediaType: 'image/png', firstFrameOnly: true })
  const turn = await f.prepare(), input = await turn.nativeInput('Look')
  assert.equal(input.length, 2)
  assert.deepEqual(input[1], { type: 'localImage', path: '/execution-only/lease/registration-2/preview.png' })
  assert.match(JSON.stringify(input[0]), /first frame/)
  assert.ok(!JSON.stringify(input).includes(Buffer.from('fake-png-preview').toString('base64')))
  await turn.close()
})

test('missing image capability fails before native submission and cleans host allocations', async () => {
  const f = fixture({ mediaType: 'image/png', filename: 'image.png' })
  await assert.rejects(f.prepare(), /CODEX_IMAGE_CAPABILITY_REQUIRED/)
  assert.equal(f.issued.length, 0); assert.deepEqual(f.calls.slice(-1), ['host:close'])
})

test('image transformation failure cleans initial copy', async () => {
  const f = fixture({ mediaType: 'image/png', filename: 'image.png' })
  f.dependencies.prepareImage = async () => { throw new Error('bad image') }
  await assert.rejects(f.prepare(), /bad image/); assert.equal(f.registrations.size, 0)
})

test('same-image native preparation reuses registered input rather than copying again', async () => {
  const f = fixture({ mediaType: 'image/png', filename: 'image.png' })
  f.dependencies.prepareImage = async (bytes) => ({ bytes, mediaType: 'image/png', firstFrameOnly: false })
  const turn = await f.prepare(); assert.equal(f.registrations.size, 1)
  assert.equal((await turn.nativeInput('Image'))[1]!.type, 'localImage'); await turn.close()
})

test('scope mismatch, stale pins, permanent source, pending and overdue input all fail closed', async () => {
  for (const kind of ['scope', 'pins', 'permanent', 'pending', 'expired', 'invalid-expiry', 'size', 'hash'] as const) {
    await (async () => {
      const f = fixture(), value = f.value()
      if (kind === 'scope') value.file.scope = { ...scope, chat: { ...scope.chat, conversationId: 'other' as 'conversation' } }
      if (kind === 'pins') value.revision.revisionId = 'other'
      if (kind === 'permanent') value.file.scope = { kind: 'workspace_reference', workspaceId: 'workspace' } as never
      if (kind === 'pending') value.file.state = 'pending'
      if (kind === 'expired') value.file.expiresAt = now.toISOString()
      if (kind === 'invalid-expiry') value.file.expiresAt = 'invalid'
      if (kind === 'size') value.revision.byteSize++
      if (kind === 'hash') value.revision.sha256 = 'b'.repeat(64)
      await assert.rejects(f.prepare()); assert.equal(f.issued.length, 0); assert.equal(f.registrations.size, 0)
    })()
  }
})

test('metadata rechecked after copying and again before each turn input', async () => {
  const f = fixture(), original = f.host.materialize
  f.host.materialize = async (input) => { const copy = await original(input); f.value().file.state = 'expired'; return copy }
  await assert.rejects(f.prepare(), /CODEX_FILE_UNAVAILABLE/)
  const g = fixture(), turn = await g.prepare(); g.value().file.state = 'removed'
  await assert.rejects(turn.nativeInput('Late'), /CODEX_FILE_UNAVAILABLE/); await turn.close()
})

test('same pins with changed immutable revision metadata rejected on later input', async () => {
  const f = fixture(), turn = await f.prepare(); f.value().revision.filename = 'changed.md'
  await assert.rejects(turn.nativeInput('Late'), /CODEX_FILE_BYTES_CHANGED/); await turn.close()
})

test('duplicate or excessive attachment identities denied before source/host work', async () => {
  const f = fixture(); f.accepted.attachments = [ref, ref]
  await assert.rejects(f.prepare(), /CODEX_FILE_ADMISSION_INVALID/)
  assert.deepEqual(f.calls, ['host:close'])
})

test('accepted host cannot fall back to the API host', async () => {
  const f = fixture(); f.accepted.executionHostId = 'api-host'
  await assert.rejects(f.prepare(), /CODEX_FILE_ADMISSION_INVALID/)
  assert.deepEqual(f.calls, ['host:close'])
})

test('host receipt verifies path, host, hash, length and requested write policy', () => {
  const expected = { executionHostId: 'remote', pathStyle: 'posix' as const, writable: false, byteSize: 3, sha256: 'a'.repeat(64) }
  const good = { ...expected, registrationId: 'reg', executionPath: '/remote/file.md' }
  assert.doesNotThrow(() => assertRegisteredCodexCopy(good, expected))
  for (const change of [{ executionPath: '../file.md' }, { executionPath: '/remote/../file.md' }, { executionPath: '/remote/\0file' },
    { executionHostId: 'api' }, { sha256: 'b'.repeat(64) }, { byteSize: 4 }, { writable: true }]) {
    assert.throws(() => assertRegisteredCodexCopy({ ...good, ...change }, expected), /CODEX_FILE_HOST_RECEIPT_INVALID/)
  }
  assert.doesNotThrow(() => assertRegisteredCodexCopy({ ...good, executionPath: 'C:\\runner\\file.md' }, { ...expected, pathStyle: 'win32' }))
})

test('host cannot return the same registration/path for two inputs', async () => {
  const f = fixture({ mediaType: 'image/gif', filename: 'a.gif' })
  f.dependencies.prepareImage = async () => ({ bytes: Buffer.from('preview'), mediaType: 'image/png', firstFrameOnly: true })
  const original = f.host.materialize
  f.host.materialize = async (input) => ({ ...await original(input), registrationId: 'same' })
  await assert.rejects(f.prepare(), /CODEX_FILE_HOST_COLLISION/); assert.equal(f.registrations.size, 0)
})

test('issueForAcceptedSession receives exact owner, conversation, provider turn and message once', async () => {
  const f = fixture(), turn = await f.prepare()
  assert.equal((await turn.call(f.request('files_list', { scope }))).success, false)
  await Promise.all([turn.activate('turn-a'), turn.activate('turn-a')])
  assert.deepEqual(f.issued, [{ ownerPrincipalId: 'owner', scope, nativeSessionId: 'thread-a', turnId: 'turn-a',
    messageId: 'message-a', allowMutation: true, allowedTools: [...tools] }])
  await assert.rejects(turn.activate('turn-b'), /CODEX_FILE_TURN_MISMATCH/)
  assert.equal(JSON.stringify(turn), '{}'); assert.ok(!JSON.stringify(await turn.nativeInput('Hi')).includes(token))
  await turn.close()
})

test('foreign native session, turn, namespace and non-file tool rejected before service call', async () => {
  const f = await active(), before = [...f.calls]
  for (const change of [{ threadId: 'thread-b' }, { turnId: 'turn-b' }, { namespace: 'other' },
    { tool: 'graphql' }, { tool: 'constructor' }, { tool: 'files.remove' }]) {
    assert.equal((await f.turn.call({ ...f.request('files_list', { scope }), ...change })).success, false)
  }
  assert.deepEqual(f.calls, before); await f.turn.close()
})

test('read mode stays read-only and advertises no copy/publish tools', async () => {
  const f = await active({ mode: 'read' })
  assert.deepEqual(f.turn.allowedTools(), ['files.list', 'files.read'])
  assert.equal((await f.turn.call(f.copyRequest())).success, false)
  assert.equal((await f.turn.call(f.publishRequest())).success, false)
  assert.ok(!JSON.stringify(await f.turn.nativeInput('Read')).includes('files_create_working_copy'))
  assert.equal((await f.turn.call(f.request('files_list', { scope }))).success, true)
  assert.ok(!f.calls.includes('beginWrite')); await f.turn.close()
})

test('read mode cannot be upgraded with an owner-derived mutation flag', async () => {
  const f = fixture({ mode: 'read', allowMutation: true })
  await assert.rejects(f.prepare(), /CODEX_READ_MODE_FILE_EDIT_UNSUPPORTED/)
  assert.equal(f.issued.length, 0)
})

test('Write-mode direct edits are sealed then completed through FIL-05 before publication', async () => {
  const f = await active()
  const copy = await f.turn.call(f.copyRequest())
  assert.equal(copy.success, true); assert.match(JSON.stringify(copy), /execution-only/)
  f.edit('# Input\nedited\n')
  const result = await f.turn.call(f.publishRequest())
  assert.equal(result.success, true); assert.match(JSON.stringify(result), /agent_output/)
  assert.equal(f.completed()!.toString(), '# Input\nedited\n')
  assert.equal(f.bytes.toString(), '# Input\noriginal\n')
  assert.ok(f.calls.indexOf('beginWrite') < f.calls.indexOf('materialize:write'))
  assert.ok(f.calls.indexOf('seal') < f.calls.indexOf('completeWrite'))
  assert.ok(f.calls.indexOf('completeWrite') < f.calls.indexOf('publish'))
  assert.deepEqual(await f.turn.publications(), [{ fileId: 'result-file', revisionId: 'result-revision' }])
  assert.ok(!JSON.stringify(result).includes(token)); await f.turn.close()
})

test('production-style FIL-05b edits publish a snapshot without a writable host path', async () => {
  const f = fixture()
  f.accepted.allowedTools = [...tools, 'files.write_working_copy', 'files.apply_format_edit']
  f.dependencies.editsOnly = true
  const turn = await f.prepare()
  await turn.activate('turn-a')
  const copy = await turn.call(f.copyRequest())
  assert.equal(copy.success, true)
  assert.ok(!JSON.stringify(copy).includes('/execution-only/'))
  assert.equal([...f.registrations.values()].filter((registration) => registration.writable).length, 0)
  const write = await turn.call(f.request('files_write_working_copy', {
    artifactId, contentBase64: Buffer.from('# rewritten').toString('base64'),
  }))
  assert.equal(write.success, true)
  const edit = await turn.call(f.request('files_apply_format_edit', { artifactId,
    edit: { kind: 'append_text', text: '\nend' } }))
  assert.equal(edit.success, true)
  const published = await turn.call(f.publishRequest())
  assert.equal(published.success, true)
  assert.equal(f.completed()?.toString(), '# rewritten\nend')
  assert.equal(f.sealCalls(), 0)
  await turn.close()
})

test('unchanged copy retains byte identity and publish retries do not resnapshot', async () => {
  const f = await active(); await f.turn.call(f.copyRequest())
  const first = await f.turn.call(f.publishRequest()), second = await f.turn.call(f.publishRequest())
  assert.equal(first.success, true); assert.match(JSON.stringify(first), /agent_copy/)
  assert.equal(second.success, true); assert.match(JSON.stringify(second), /replayed\\?":true/)
  assert.equal(f.sealCalls(), 1); assert.deepEqual(f.completed(), f.bytes); await f.turn.close()
})

test('arbitrary artifact paths, URLs and unknown handles never reach host seal', async () => {
  const f = await active(); await f.turn.call(f.copyRequest())
  for (const id of ['/etc/passwd', '../source', 'https://example.test/file', 'other-artifact']) {
    const request = f.publishRequest(); request.arguments = { ...request.arguments as object, artifactId: id }
    assert.equal((await f.turn.call(request)).success, false)
  }
  assert.equal(f.sealCalls(), 0); await f.turn.close()
})

test('strict input parsing and same-scope checks run before host or artifact mutations', async () => {
  const f = await active(); await f.turn.call(f.copyRequest())
  for (const extra of [{ path: '/etc/passwd' }, { target: ref }, { scope: { kind: 'workflow_reference', workspaceId: 'w', workflowId: 'f' } },
    { scope: { ...scope, chat: { ...scope.chat, conversationId: 'other' } } }]) {
    const request = f.publishRequest(); request.arguments = { ...request.arguments as object, ...extra }
    assert.equal((await f.turn.call(request)).success, false)
  }
  assert.equal(f.sealCalls(), 0); assert.ok(!f.calls.includes('completeWrite')); await f.turn.close()
})

test('incomplete/live host writer refuses publication without completing artifact', async () => {
  const f = await active(); await f.turn.call(f.copyRequest())
  f.host.sealCompleted = async () => { throw new Error('writer remains active') }
  assert.equal((await f.turn.call(f.publishRequest())).success, false)
  assert.ok(!f.calls.includes('completeWrite')); assert.ok(!f.calls.includes('publish')); await f.turn.close()
})

test('interrupted byte snapshot does not publish', async () => {
  const f = await active(); await f.turn.call(f.copyRequest())
  f.host.sealCompleted = async () => new Readable({ read() { this.push('partial'); this.destroy(new Error('lost host')) } })
  assert.equal((await f.turn.call(f.publishRequest())).success, false)
  assert.ok(!f.calls.includes('publish')); await f.turn.close()
})

test('copy materialization failure aborts its artifact writer', async () => {
  const f = await active()
  f.host.materialize = async () => { throw new Error('no capacity') }
  assert.equal((await f.turn.call(f.copyRequest())).success, false)
  assert.deepEqual(f.calls.slice(-2), ['beginWrite', 'abortWrite']); await f.turn.close()
})

test('read range corruption fails before materializing a writable working copy', async () => {
  const f = await active(), original = f.services.read.bind(f.services)
  f.services.read = async (given, raw) => ({ ...await original(given, raw), offset: 9 }) as never
  assert.equal((await f.turn.call(f.copyRequest())).success, false)
  assert.ok(!f.calls.includes('beginWrite')); await f.turn.close()
})

test('revoked session denies call; backend error text and credentials do not leak', async () => {
  const f = await active()
  f.services.sessions.authenticate = async () => { throw new Error(`secret ${token} api path /api/private/file`) }
  const result = await f.turn.call(f.request('files_list', { scope }))
  assert.deepEqual(result, { success: false, contentItems: [{ type: 'inputText', text: 'File operation unavailable or denied.' }] })
  await f.turn.close()
})

test('closing revokes once and cleans only its host lease; closed turn cannot be reused', async () => {
  const f = await active(); await Promise.all([f.turn.close(), f.turn.close()])
  assert.deepEqual(f.calls.slice(-2), ['revoke', 'host:close'])
  assert.equal(f.calls.filter((call) => call === 'revoke').length, 1)
  assert.equal((await f.turn.call(f.copyRequest())).success, false)
  await assert.rejects(f.turn.nativeInput('after'), /CODEX_FILE_TURN_CLOSED/)
  await assert.rejects(f.turn.activate('turn-a'), /CODEX_FILE_TURN_CLOSED/)
})

test('close racing token issuance waits, revokes the issued token, then cleans', async () => {
  const f = fixture(), turn = await f.prepare()
  let resolve!: () => void
  const waiting = new Promise<void>((done) => { resolve = done })
  const original = f.services.sessions.issueForAcceptedSession.bind(f.services.sessions)
  f.services.sessions.issueForAcceptedSession = async (...args) => { await waiting; return original(...args) }
  const activation = turn.activate('turn-a'), closed = turn.close()
  await immediate(); assert.ok(!f.calls.includes('host:close')); resolve()
  await Promise.all([activation, closed]); assert.deepEqual(f.calls.slice(-3), ['issue', 'revoke', 'host:close'])
})

test('cleanup failure stays closed and explicit close retries cleanup', async () => {
  const f = await active(), close = f.host.close
  let failures = 0
  f.host.close = async () => { if (!failures++) throw new Error('retry cleanup'); await close() }
  await assert.rejects(f.turn.close(), /retry cleanup/)
  assert.equal((await f.turn.call(f.copyRequest())).success, false)
  await f.turn.close(); assert.equal(f.registrations.size, 0)
})

test('byte transfer owns a reused chunk before generator prefetch mutates it', async () => {
  const data = Buffer.alloc(3)
  async function* source() { data.fill(65); yield data; data.fill(66); yield data }
  assert.equal((await collectCodexFileBytes(Readable.from(source()), 6)).toString(), 'AAABBB')
})

test('byte transfer caps actual size, rejects text mode and notices premature close', async () => {
  await assert.rejects(collectCodexFileBytes(Readable.from([Buffer.alloc(5)]), 4), /CODEX_FILE_SIZE_LIMIT/)
  await assert.rejects(collectCodexFileBytes(Readable.from(['text']), 4), /CODEX_FILE_BYTES_REQUIRED/)
  await assert.rejects(collectCodexFileBytes(new Readable({ read() { this.destroy() } }), 4), /CODEX_FILE_TRANSFER_INCOMPLETE/)
  const controller = new AbortController(), hanging = new Readable({ read() {} })
  const operation = collectCodexFileBytes(hanging, 4, controller.signal); controller.abort()
  await assert.rejects(operation, /CODEX_FILE_TRANSFER_ABORTED/)
})


test('publish concurrency does not run two host seals for one working copy', async () => {
  const f = await active(); await f.turn.call(f.copyRequest())
  const seal = f.host.sealCompleted
  let release!: () => void
  const hold = new Promise<void>((done) => { release = done })
  f.host.sealCompleted = async (id) => { await hold; return seal(id) }
  const first = f.turn.call(f.publishRequest())
  await immediate()
  assert.equal((await f.turn.call(f.publishRequest())).success, false)
  release(); assert.equal((await first).success, true); assert.equal(f.sealCalls(), 1)
  await f.turn.close()
})

test('Agent Run-origin scope is preserved without adopting the open browser workspace', async () => {
  const f = fixture(); f.accepted.attachments = []
  f.accepted.scope = { kind: 'temporary', chat: { kind: 'agent', conversationId: 'chat', agentId: 'agent',
    workspaceId: 'saved-workspace', workflowId: 'saved-workflow', runId: 'saved-run', executionId: 'saved-execution' } }
  const turn = await f.prepare(); await turn.activate('turn-a')
  assert.deepEqual((f.issued[0] as { scope: unknown }).scope, f.accepted.scope)
  await turn.close()
})

test('an invalid/global credential from the issuer is never used for native file calls', async () => {
  const f = fixture(), turn = await f.prepare()
  const revoked: string[] = []
  f.services.sessions.issueForAcceptedSession = async () => 'gql_operator_secret'
  f.services.sessions.revoke = async (value) => { revoked.push(value) }
  await assert.rejects(turn.activate('turn-a'), /CODEX_FILE_SESSION_INVALID/)
  assert.equal((await turn.call(f.request('files_list', { scope }))).success, false)
  assert.deepEqual(revoked, ['gql_operator_secret']); await turn.close()
})

// This drives a real subprocess with fake app-server frames, NOT the existing
// CodexAppServerSessionManager. It specifies the still-unwired staging protocol.
test('fake app-server: stage pre-ack tool calls, bind after persistence, reject foreign turn, omit startup on resume',
  { timeout: 5000 }, async () => {
    const f = fixture(), turn = await f.prepare()
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/codex-files-app-server.mjs', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.resume()
    onTestFinished(async () => { child.stdin.end(); child.kill(); await turn.close() })
    const pending = new Map<number, (value: Record<string, unknown>) => void>()
    const queue: Array<Record<string, unknown>> = []
    let nextId = 0, queued: (() => void) | undefined
    let complete!: (value: Record<string, unknown>) => void
    const terminal = new Promise<Record<string, unknown>>((resolve) => { complete = resolve })
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n')
    const request = (method: string, params: unknown) => new Promise<Record<string, unknown>>((resolve) => {
      const id = ++nextId; pending.set(id, resolve); send({ id, method, params })
    })
    const reader = (async () => {
      for await (const line of createInterface({ input: child.stdout })) {
        const value = JSON.parse(line) as Record<string, unknown>
        if (value.method === 'item/tool/call') { queue.push(value); queued?.(); queued = undefined }
        else if (value.method === 'turn/completed') complete(value.params as Record<string, unknown>)
        else if (typeof value.id === 'number') { pending.get(value.id)?.(value.result as Record<string, unknown>); pending.delete(value.id) }
      }
    })()
    await request('initialize', { capabilities: { experimentalApi: true } }); send({ method: 'initialized' })
    await request('thread/start', { config: { 'mcp_servers.graphql.enabled': false }, developerInstructions: 'STARTUP-ONCE',
      dynamicTools: turn.allowedTools().map((name) => ({ type: 'function', name: name.replaceAll('.', '_') })) })
    await request('thread/resume', { threadId: 'thread-a', config: { 'mcp_servers.graphql.enabled': false } })
    const started = await request('turn/start', { threadId: 'thread-a', input: await turn.nativeInput('Read the file'), testScope: scope })
    assert.equal(f.issued.length, 0); assert.equal(f.calls.includes('list'), false)
    const providerId = (started.turn as { id: string }).id
    f.calls.push('persist-native-turn')
    await turn.activate(providerId)
    for (let i = 0; i < 2; i++) {
      if (!queue.length) await new Promise<void>((resolve) => { queued = resolve })
      const frame = queue.shift()!
      send({ id: frame.id, result: await turn.call(frame.params as unknown as CodexFileCall) })
    }
    const result = await terminal
    assert.equal(result.resumed, true)
    assert.ok(f.calls.indexOf('persist-native-turn') < f.calls.indexOf('issue'))
    assert.equal(f.calls.filter((call) => call === 'list').length, 1)
    child.stdin.end(); await reader
  })


test('lost completeWrite acknowledgement retries the same sealed bytes instead of a new mutable read', async () => {
  const f = await active(); await f.turn.call(f.copyRequest()); f.edit('# Input\nfinal edit\n')
  const complete = f.services.artifacts.completeWrite.bind(f.services.artifacts)
  let first = true
  f.services.artifacts.completeWrite = async (...args) => {
    await complete(...args)
    if (first) { first = false; throw new Error('lost complete acknowledgement') }
  }
  assert.equal((await f.turn.call(f.publishRequest())).success, false)
  assert.ok(!f.calls.includes('publish'))
  assert.equal((await f.turn.call(f.publishRequest())).success, true)
  assert.equal(f.completed()!.toString(), '# Input\nfinal edit\n')
  await f.turn.close()
})

test('copy reauthorizes after slow host materialization before revealing a writable path', async () => {
  const f = await active(), materialize = f.host.materialize
  f.host.materialize = async (input) => {
    const copy = await materialize(input)
    f.services.sessions.authenticate = async () => { throw new Error('owner revoked') }
    return copy
  }
  const result = await f.turn.call(f.copyRequest())
  assert.equal(result.success, false)
  assert.ok(!JSON.stringify(result).includes('execution-only'))
  assert.ok(!f.calls.includes('publish')); await f.turn.close()
})


test('Job revisions never enter native attachment bytes or image preparation', async () => {
  const f = fixture()
  const bytes = Buffer.from('job output')
  const job = FileWithRevisionSchema.parse({
    file: { ...f.value().file, scope: { kind: 'job_execution', workspaceId: 'workspace', jobExecutionId: 'job' } },
    revision: { ...f.value().revision, byteClass: 'ci-output', filename: 'job.zip', mediaType: 'application/zip',
      byteSize: bytes.length, sha256: sha256(bytes), origin: 'job_output' },
  })
  let read = false, image = false
  const stream = new Readable({ read() { read = true; this.push(bytes); this.push(null) } })
  f.dependencies.source.open = async () => ({ value: job, stream })
  f.dependencies.prepareImage = async () => { image = true; throw new Error('Unexpected image preparation') }
  await assert.rejects(f.prepare(), /CODEX_FILE_DOCUMENT_REQUIRED/)
  assert.equal(read, false)
  assert.equal(image, false)
  assert.equal(stream.destroyed, true)
  assert.equal(f.registrations.size, 0)
  assert.equal(f.issued.length, 0)
})

test('Job read results are denied before native tool output or writable host effects', async () => {
  const f = fixture()
  const turn = await f.prepare()
  await turn.activate('turn-a')
  const bytes = Buffer.from('JOB')
  const jobRead = AgentFileReadResultSchema.parse({
    status: 'ready', file: { ...f.value().file,
      scope: { kind: 'job_execution', workspaceId: 'workspace', jobExecutionId: 'job' } },
    revision: { ...f.value().revision, byteClass: 'ci-output', filename: 'job.zip', mediaType: 'application/zip',
      byteSize: bytes.length, sha256: sha256(bytes), origin: 'job_output' },
    readAt: now.toISOString(), offset: 0, byteLength: bytes.length, contentBase64: bytes.toString('base64'), eof: true,
  })
  f.dependencies.files.read = async () => jobRead
  const deniedRead = await turn.call(f.request('files_read', { ...ref, offset: 0, length: 4 }))
  assert.equal(deniedRead.success, false)
  assert(!JSON.stringify(deniedRead).includes(bytes.toString('base64')))
  assert.equal((await turn.call(f.copyRequest())).success, false)
  assert(!f.calls.includes('beginWrite'))
  assert(!f.calls.includes('materialize:write'))
  await turn.close()
})


for (const mediaType of FILE_MEDIA_TYPES) test(`native preparation retains document media ${mediaType}`, async () => {
  const f = fixture({ mediaType, filename: `input.${FILE_EXTENSIONS_BY_MEDIA_TYPE[mediaType][0]}` })
  if (mediaType.startsWith('image/')) f.dependencies.prepareImage = async (bytes) => ({
    bytes, mediaType: mediaType === 'image/jpeg' ? 'image/jpeg' : mediaType === 'image/webp' ? 'image/webp' : 'image/png',
    firstFrameOnly: mediaType === 'image/gif',
  })
  const turn = await f.prepare()
  assert.equal((await turn.nativeInput('Read the document'))[0]?.type, 'text')
  await turn.close()
})
