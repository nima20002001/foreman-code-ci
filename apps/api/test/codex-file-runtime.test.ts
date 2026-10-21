import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { AgentFileReadResultSchema } from '@foreman-code/contracts/files'
import type { CodexChatFileAdmission } from '../src/modules/harnesses/codexFiles/production.js'
import type { CodexChatFiles } from '../src/modules/harnesses/codexFiles/runtime.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calls, collect, emit, finish, fixtureQualification, input, until, type Fixture } from './fixtures/codex-test-helpers.js'
import { filePorts, fileRuntimeFixture, fileScope, publishedRef, sourceRef } from './fixtures/codex-file-runtime-helpers.js'
import { deferred } from './helpers/deferred.js'

// Only qualification, FIL-05 storage/auth, and the execution-host ports are doubles.
// The production adapter, FIL-08 bridge, session manager and stdio transport run.
vi.doMock('../src/modules/harnesses/codexProtocol.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/codexProtocol.js')>('../src/modules/harnesses/codexProtocol.js')
  return { ...actual, qualifyCodex: fixtureQualification, assertCodexUnchanged: async () => undefined }
})
let ports: ReturnType<typeof filePorts>
vi.doMock('../src/modules/files/tools/production.js', () => ({ productionFileTools: () => ports.files }))
const { CodexAppServerSessionManager } = await import('../src/modules/harnesses/codexAppServer.js')
const { productionCodexChatFiles } = await import('../src/modules/harnesses/codexFiles/production.js')
const { codexResponseSurfaceFixtures } = await import('./fixtures/codex-response-surfaces.js')
type Manager = InstanceType<typeof CodexAppServerSessionManager>
let f: Fixture
let manager: Manager
let source: ReturnType<typeof input>
let prepareCount: number
let admissionGate: Promise<void> | undefined
let mismatch: boolean
const managers: Manager[] = []
const adopted = new Map<string, typeof publishedRef[]>()
function makeManager(custom?: CodexChatFiles) {
  const port = custom ?? productionCodexChatFiles(() => ({} as FastifyInstance), 'conversation-a', {
    async resolve({ session, clientCorrelationId, signal }): Promise<CodexChatFileAdmission> {
      prepareCount++
      await admissionGate
      signal.throwIfAborted()
      const messageId = `message-${clientCorrelationId}`
      return {
        clientCorrelationId,
        accepted: {
          ownerPrincipalId: 'owner-a', scope: fileScope, nativeSessionId: mismatch ? 'foreign-session' : session.nativeSessionId,
          admissionId: `receipt-${clientCorrelationId}`, messageId, executionHostId: 'execution-host-a',
          projectMode: 'write', allowMutation: true,
          allowedTools: ['files.list', 'files.read', 'files.create_working_copy', 'files.publish_result'],
          expiresAt: new Date(Date.now() + 60_000), attachments: [sourceRef],
        },
        dependencies: ports.dependencies,
        async adoptPublished(turnId, refs) {
          assert.equal(turnId, ports.issued.at(-1)?.turnId)
          if (refs.length) assert.deepEqual(refs, [publishedRef])
          ports.events.push(`adopt:${messageId}`)
          adopted.set(messageId, refs.map((ref) => ({ ...ref })))
        },
      }
    },
  })
  const value = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'none', port)
  managers.push(value)
  return value
}
async function wire(method?: string) {
  return (await calls(f.directory)).flatMap((entry) => {
    const value = entry.wire as { id?: string | number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> } | undefined
    return value && (!method || value.method === method) ? [value] : []
  })
}
async function response(id: string | number) {
  return until(async () => (await wire()).find((value) => value.id === id && value.result)?.result)
}
async function sendTool(session: NativeSessionReference, id: string, tool: string, arguments_: unknown,
  extra: Record<string, unknown> = {}) {
  await emit(f.directory, { id, method: 'item/tool/call', params: {
    threadId: session.nativeSessionId, turnId: ports.issued.at(-1)?.turnId, callId: id, namespace: null, tool, arguments: arguments_, ...extra,
  } })
  return response(id)
}
async function begin(session: NativeSessionReference, correlation = 'first') {
  const result = collect(manager.startTurn(session, { prompt: 'Please use the attachment.', clientCorrelationId: correlation,
    onSubmitted: async () => { ports.events.push('submitted') } }))
  await until(async () => ports.events.includes('issue:ready'))
  return result
}

// Executable provider fixture uses a POSIX shebang, matching the existing suite.
describe.skipIf(process.platform === 'win32')('FIL-08a: real Codex manager file turns', () => {
  beforeEach(async () => {
    f = await fileRuntimeFixture(); ports = filePorts(); prepareCount = 0; mismatch = false
    admissionGate = undefined; adopted.clear()
    await writeFile(join(f.directory, 'file-turn'), '')
    source = input(f.directory)
    delete source.environment // Chat has neither worker nor Operator credentials.
    source.request.configuration.prompt.system = 'STARTUP-ONCE'
    const harness = source.request.configuration.harness
    if (harness.harness !== 'codex') throw new Error('The fixture must use Codex.')
    harness.sandbox = 'workspace-write'
    manager = makeManager()
  })
  afterEach(async () => {
    const outcomes = await Promise.allSettled(managers.splice(0).map((value) => value.shutdown()))
    await rm(f.directory, { recursive: true, force: true })
    const failed = outcomes.find((value) => value.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  })

  it('prepares execution-host inputs once and stages a pre-ACK call until durable submission', async () => {
    await writeFile(join(f.directory, 'file-before-ack.json'), JSON.stringify({ id: 'early-list', params: {
      callId: 'early-list', namespace: null, tool: 'files_list', arguments: { scope: fileScope },
    } }))
    const session = await manager.createSession(source)
    const gate = deferred(), submitted = deferred()
    const result = collect(manager.startTurn(session, { prompt: 'Use this.', clientCorrelationId: 'first', onSubmitted: async () => {
      submitted.resolve(); await gate.promise; ports.events.push('submitted')
    } }))
    await submitted.promise
    assert.equal(ports.issued.length, 0)
    assert(!ports.events.includes('list'))
    gate.resolve()
    assert.equal((await response('early-list'))?.success, true)
    assert(ports.events.indexOf('submitted') < ports.events.indexOf('issue:entered'))
    assert(ports.events.indexOf('issue:ready') < ports.events.indexOf('list'))
    const start = (await wire('turn/start'))[0]!
    const nativeInput = start.params!.input as Array<{ text?: string; path?: string }>
    assert.match(nativeInput[0]!.text!, /\/execution-only\/copy-1\/notes\.md/)
    assert(!nativeInput[0]!.text!.includes('# Attached document'))
    assert(!nativeInput[0]!.text!.includes('STARTUP-ONCE'))
    assert.equal(prepareCount, 1)
    assert.deepEqual(ports.materialized.map((copy) => copy.writable), [false])
    const thread = (await wire('thread/start'))[0]!
    assert.match(String(thread.params!.developerInstructions), /STARTUP-ONCE/)
    assert((thread.params!.dynamicTools as Array<{ type: string; name: string }>).every((tool) => tool.type === 'function' && tool.name.startsWith('files_')))
    assert(Object.entries(thread.params!.config as Record<string, unknown>).some(([name, value]) => /^mcp_servers\..+\.enabled$/.test(name) && value === false))
    assert(!JSON.stringify(await wire()).includes('gql_file_'))
    assert(!JSON.stringify(await wire()).includes('token-agent-a'))
    await finish(f.directory, session.nativeSessionId); await result
    assert.equal(ports.tokens.size, 0)
    assert(ports.events.indexOf('revoke') < ports.events.indexOf('host:close'))
  })

  it('returns pinned Markdown bytes and exact text through the native callback', async () => {
    const session = await manager.createSession(source)
    const running = begin(session)
    await until(async () => ports.events.includes('issue:ready'))
    const result = await sendTool(session, 'read-markdown', 'files_read', {
      ...sourceRef, offset: 0, length: 65536,
    })
    assert.equal(result?.success, true)
    const content = result!.contentItems as Array<{ type: string; text: string }>
    const read = AgentFileReadResultSchema.parse(JSON.parse(content[0]!.text))
    assert.equal(read.status, 'ready')
    if (read.status !== 'ready') throw new Error('Expected authorized Markdown bytes.')
    assert.equal(read.file.fileId, sourceRef.fileId)
    assert.equal(read.revision.revisionId, sourceRef.revisionId)
    assert.deepEqual(content[1], { type: 'inputText', text: '# Attached document\n' })
    assert.equal(Buffer.from(read.contentBase64, 'base64').toString('utf8'), content[1]!.text)
    await finish(f.directory, session.nativeSessionId)
    await running
  })

  it('dispatches copy/publish and adopts only into the originating message; duplicate calls do not republish', async () => {
    const session = await manager.createSession(source)
    const result = begin(session) // Keep the stream alive while tool calls execute.
    await until(async () => ports.events.includes('issue:ready'))
    assert.equal((await sendTool(session, 'copy', 'files_create_working_copy', {
      commandId: 'copy-command-1', source: sourceRef, destination: fileScope,
    }))?.success, true)
    const publish = { commandId: 'publish-command-1', artifactId: 'artifact-a', scope: fileScope, filename: 'result.md', mediaType: 'text/markdown' }
    assert.equal((await sendTool(session, 'publish-a', 'files_publish_result', publish, { callId: 'same-publish' }))?.success, true)
    assert.equal((await sendTool(session, 'publish-b', 'files_publish_result', publish, { callId: 'same-publish' }))?.success, true)
    assert.deepEqual(adopted.get('message-first'), [publishedRef])
    assert.equal(adopted.size, 1)
    assert.equal(ports.events.filter((event) => event === 'publish:ready').length, 1)
    assert.equal(ports.events.filter((event) => event === 'seal').length, 0)
    assert.deepEqual(ports.materialized.map((copy) => copy.writable), [false])
    assert.equal((await sendTool(session, 'publish-changed', 'files_publish_result', { ...publish, filename: 'other.md' }, { callId: 'same-publish' }))?.success, false)
    assert.equal((await sendTool(session, 'foreign-turn', 'files_publish_result', publish, { callId: 'same-publish', turnId: 'another-turn' }))?.success, false)
    assert.equal(ports.events.filter((event) => event === 'publish:ready').length, 1)
    await finish(f.directory, session.nativeSessionId); await result
    assert.equal(ports.tokens.size, 0)
  })

  it('restarts/resumes without delivering old files or startup text; the next turn gets a fresh token and cleanup', async () => {
    const session = await manager.createSession(source)
    const first = begin(session)
    await until(async () => ports.events.includes('issue:ready'))
    await finish(f.directory, session.nativeSessionId); await first
    await manager.closeForRestart(session)
    const previousInputs = (await wire('turn/start')).length, previousPreparations = prepareCount
    ports = filePorts()
    manager = makeManager()
    await manager.attachSession(session, { ...source, nativeTurnId: 'turn-1', correlationId: 'first', instructionsDelivered: true })
    await manager.reconcile(session, 'first')
    assert.equal(prepareCount, previousPreparations)
    assert.equal((await wire('turn/start')).length, previousInputs)
    const resumes = await wire('thread/resume')
    assert(resumes.length > 0)
    assert(resumes.every((request) => !Object.hasOwn(request.params!, 'developerInstructions')))
    const second = begin(session, 'second')
    await until(async () => ports.events.includes('issue:ready'))
    await finish(f.directory, session.nativeSessionId); await second
    assert.equal(prepareCount, previousPreparations + 1)
    assert.equal(ports.tokens.size, 0)
    assert(ports.events.includes('host:close'))
  })

  it('cleans each successive turn on the same process, not just the first bridge', async () => {
    const session = await manager.createSession(source)
    const firstPorts = ports
    const first = begin(session)
    await until(async () => firstPorts.events.includes('issue:ready'))
    await finish(f.directory, session.nativeSessionId); await first
    ports = filePorts()
    const second = begin(session, 'second')
    await until(async () => ports.events.includes('issue:ready'))
    await finish(f.directory, session.nativeSessionId); await second
    assert.equal(firstPorts.tokens.size, 0)
    assert.equal(ports.tokens.size, 0)
    assert(firstPorts.events.includes('host:close'))
    assert(ports.events.includes('host:close'))
    assert.equal((await wire('thread/start')).length, 1)
    assert.equal((await wire('turn/start')).length, 2)
  })

  it('cancel during token issuance never opens the staged handler and revokes the eventual token', async () => {
    const gate = deferred(); ports.setIssueGate(gate.promise)
    const session = await manager.createSession(source)
    const result = begin(session)
    await until(async () => ports.events.includes('issue:entered'))
    const canceled = manager.cancel(session, AbortSignal.timeout(5000), 'turn-1')
    gate.resolve()
    await canceled; await result
    assert.equal(ports.tokens.size, 0)
    assert(!ports.events.includes('list'))
    assert(ports.events.includes('revoke'))
    assert(ports.events.includes('host:close'))
  })

  it('cancel before preparation completes sends no native input or token', async () => {
    const gate = deferred(); admissionGate = gate.promise
    const session = await manager.createSession(source)
    const result = collect(manager.startTurn(session, { prompt: 'Do not send.', clientCorrelationId: 'cancel-before-input' }))
    await until(async () => prepareCount === 1)
    const rejected = assert.rejects(result)
    const canceled = manager.cancel(session, AbortSignal.timeout(5000))
    gate.resolve()
    assert.equal(await canceled, false); await rejected
    assert.equal((await wire('turn/start')).length, 0)
    assert.equal(ports.issued.length, 0)
  })

  it('rejects a foreign admission before native input and releases its host lease', async () => {
    mismatch = true
    const session = await manager.createSession(source)
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'No.', clientCorrelationId: 'foreign' })), /CODEX_FILE_ADMISSION_MISMATCH/)
    assert.equal((await wire('turn/start')).length, 0)
    assert.equal(ports.issued.length, 0)
    assert(ports.events.includes('host:close'))
  })

  it('requires durable acknowledgement persistence before sending a file turn', async () => {
    const session = await manager.createSession(source)
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'No.', clientCorrelationId: 'missing-receipt' })), /durable native identity persistence/)
    assert.equal((await wire('turn/start')).length, 0)
    assert.equal(ports.issued.length, 0)
    assert(ports.events.includes('host:close'))
  })

  it.each(['workflow', 'agent-chat', 'selected-run-continuation'] as const)(
    'rejects management credentials with file ports for %s before native or file work', async (surface) => {
      const prepare = vi.fn(async () => undefined)
      const scoped = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'scoped', { prepare })
      managers.push(scoped)
      const start = codexResponseSurfaceFixtures(f.directory).find(value => value.surface === surface)!.source
      await expect(scoped.createSession(start)).rejects.toMatchObject({
        result: { error: { code: 'CODEX_FILE_CHAT_ISOLATION_REQUIRED' } },
      })
      expect(prepare).not.toHaveBeenCalled()
      expect(await calls(f.directory)).toEqual([])
      expect(ports.issued).toEqual([])
    },
  )

  it('creates an Operator session with separate management credentials and file declarations', async () => {
    const prepare = vi.fn(async () => undefined)
    const scoped = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'scoped', { prepare })
    managers.push(scoped)
    const start = codexResponseSurfaceFixtures(f.directory).find(value => value.surface === 'operator')!.source
    const session = await scoped.createSession(start)
    expect(session).toMatchObject({ harness: 'codex', nativeSessionId: expect.any(String) })
    const threads = await wire('thread/start')
    expect(threads).toHaveLength(1)
    expect(threads[0]!.params?.dynamicTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'files_read' }),
    ]))
    expect(prepare).not.toHaveBeenCalled()
    expect(ports.issued).toEqual([])
  })

  it('keeps file dispatch separate from native approval interactions', async () => {
    const session = await manager.createSession(source)
    const result = begin(session)
    await until(async () => ports.events.includes('issue:ready'))
    assert.equal((await sendTool(session, 'unknown-tool', 'context_get', {}))?.success, false)
    assert.equal((await sendTool(session, 'wrong-namespace', 'files_list', { scope: fileScope }, { namespace: 'graphql' }))?.success, false)
    assert.equal(await manager.pending(session), undefined)
    assert(!ports.events.includes('list'))
    const stateBefore = await readFile(join(f.directory, `state-${session.nativeSessionId}.json`), 'utf8')
    assert.match(stateBefore, /inProgress/)
    await manager.cancel(session, AbortSignal.timeout(5000), 'turn-1'); await result
    assert.equal(ports.tokens.size, 0)
  })
})
