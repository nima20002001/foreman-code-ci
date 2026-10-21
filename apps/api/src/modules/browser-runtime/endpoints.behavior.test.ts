import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { BrowserProfileSchema, BrowserProfileSyncJobSchema } from '@foreman-code/contracts/browser-profiles'
import { BrowserSessionSchema, BrowserControlSchema } from '@foreman-code/contracts/browser-sessions'
import { browserSubjects, browserAgent, endpointFixture } from './endpoints.test-support.js'
import type { BrowserOperationInputs, BrowserOperationName } from './operations.js'
import type { BrowserFileMetadata } from './files.js'

type Fixture = Awaited<ReturnType<typeof endpointFixture>>
type McpClient = Awaited<ReturnType<Fixture['connect']>>
const fixtures: Fixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
  vi.restoreAllMocks()
})
async function fixture() { const value = await endpointFixture(); fixtures.push(value); return value }
async function call<Name extends BrowserOperationName>(f: Fixture, client: McpClient, name: Name, input: BrowserOperationInputs[Name]) {
  return client.callTool({ name, arguments: f.reference(name, input) })
}
async function value<Name extends BrowserOperationName>(f: Fixture, client: McpClient, name: Name, input: BrowserOperationInputs[Name]): Promise<unknown> {
  const result = await call(f, client, name, input)
  expect(result.isError).not.toBe(true)
  return decodeMcpToolResult(result)
}
function ready(value: unknown) {
  const result = value as { kind: unknown; session: unknown; control: unknown }
  expect(result.kind).toBe('ready')
  return { session: BrowserSessionSchema.parse(result.session), control: BrowserControlSchema.parse(result.control) }
}
function errorCode(result: Awaited<ReturnType<typeof call>>, code: string) {
  expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining(`"code":"${code}"`) }] })
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

it('discovers the decided tool inventory and persists profile changes across authenticated MCP and HTTP', async () => {
  const f = await fixture(), client = await f.connect()
  const names = (await client.listTools()).tools.map(tool => tool.name).sort()
  expect(names).toEqual([
    'browser_profiles_list', 'browser_profile_get', 'browser_profile_create', 'browser_profile_update', 'browser_profile_remove',
    'browser_profiles_sync', 'browser_profile_sync_get', 'browser_session_open', 'browser_sessions_list', 'browser_session_get',
    'browser_session_close', 'browser_tabs_list', 'browser_tab_create', 'browser_tab_select', 'browser_tab_close',
    'browser_state_read', 'browser_screenshot', 'browser_action', 'browser_view_open', 'browser_view_read', 'browser_view_close',
    'browser_control_acquire', 'browser_control_release', 'browser_input',
  ].sort())
  const input = { name: 'Work sign-in', computerId: 'main', commandId: 'create-profile' }
  const created = await value(f, client, 'browser_profile_create', input) as { value: unknown }
  const profile = BrowserProfileSchema.parse(created.value)
  const read = await f.http('browser_profile_get', { profileId: profile.id }, 'GET', `/api/browser/profiles/${profile.id}`)
  expect(read.statusCode).toBe(200); expect(read.json().profile).toEqual(profile)
  expect(await value(f, client, 'browser_profile_create', input)).toMatchObject({ value: profile, replayed: true })
  errorCode(await call(f, client, 'browser_profile_create', { ...input, name: 'Different profile' }), 'COMMAND_ID_CONFLICT')
  const renamed = await f.http('browser_profile_update', { intent: 'metadata', profileId: profile.id,
    patch: { name: 'Renamed sign-in' }, expectedRevision: profile.revision, commandId: 'rename' }, 'PATCH', `/api/browser/profiles/${profile.id}`)
  expect(renamed.statusCode).toBe(200)
  const saved = BrowserProfileSchema.parse(renamed.json().value)
  expect(saved).toMatchObject({ name: 'Renamed sign-in', revision: profile.revision + 1 })
  expect(await value(f, client, 'browser_profile_get', { profileId: profile.id })).toMatchObject({ profile: saved })
  errorCode(await call(f, client, 'browser_profile_update', { intent: 'metadata', profileId: profile.id,
    patch: { name: 'Stale edit' }, expectedRevision: profile.revision, commandId: 'stale' }), 'REVISION_CONFLICT')
  const sync = await value(f, client, 'browser_profiles_sync', { profileIds: [profile.id], commandId: 'one-computer-sync' }) as { value: unknown }
  const job = BrowserProfileSyncJobSchema.parse(sync.value)
  expect(job.state).toBe('completed')
  expect(job.targets).toMatchObject([{ computerId: 'main', state: 'excluded', exclusion: 'source', snapshot: null }])
  const jobRead = await f.http('browser_profile_sync_get', { jobId: job.id, limit: 1 }, 'GET', `/api/browser/profile-sync/${job.id}`)
  expect(jobRead.statusCode).toBe(200); expect(jobRead.json().job).toEqual(job)
  const catalog = await value(f, client, 'browser_profiles_list', { computerId: 'main', limit: 1 })
  expect(catalog).toMatchObject({ profiles: [{ id: profile.id }], nextCursor: null })
  const removed = await value(f, client, 'browser_profile_remove', { profileId: profile.id, computerId: 'main', commandId: 'remove-replica' })
  expect(removed).toMatchObject({ value: [{ operation: 'remove', state: 'queued', computerId: 'main' }] })
  expect((await f.http('browser_profile_get', { profileId: profile.id }, 'GET', `/api/browser/profiles/${profile.id}`)).json())
    .toMatchObject({ profile: { sourceComputerId: 'main' }, operations: expect.arrayContaining([
      expect.objectContaining({ operation: 'remove', computerId: 'main', state: 'queued' }),
    ]) })
  expect(f.unexpectedSql).not.toHaveBeenCalled()
})

it.each(browserSubjects())('preserves $kind scope through MCP preparation, tab ownership, read-only and disabled-tool denials', async subject => {
  const f = await fixture(), request = f.bindSubject(subject)
  f.addCaller('agent', { subject }); f.addCaller('reader', { subject, readOnly: true })
  f.addCaller('disabled', { subject, enabled: false }); f.addCaller('wrong-scope', { subject, wrongScope: true })
  const agent = await f.connect('agent'), reader = await f.connect('reader'), disabled = await f.connect('disabled'), wrongScope = await f.connect('wrong-scope')
  expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain('browser_action')
  expect((await disabled.listTools()).tools).toHaveLength(0)
  const opened = ready(await value(f, agent, 'browser_session_open', { intent: 'prepare', request }))
  expect(opened.session.subject).toEqual(subject)
  expect(ready(await value(f, agent, 'browser_session_open', { intent: 'prepare', request })).session.id).toBe(opened.session.id)
  const actor = browserAgent(opened.session), sessionId = opened.session.id
  const created = await value(f, agent, 'browser_tab_create', { sessionId, actor, commandId: 'second-tab' }) as { createdTabId: string }
  const listed = await value(f, agent, 'browser_tabs_list', { sessionId })
  expect(listed).toMatchObject({ value: expect.arrayContaining([expect.objectContaining({ tabId: created.createdTabId, sessionId })]) })
  const state = { sessionId, tabId: opened.session.selectedTabId!, actor }
  expect(await value(f, reader, 'browser_state_read', state)).toMatchObject({ text: 'Fixture content' })
  errorCode(await call(f, wrongScope, 'browser_session_get', { sessionId }), 'ACCESS_DENIED')
  const action = { ...state, commandId: 'mutate', action: { kind: 'navigate' as const, url: 'https://fixture.test/allowed' } }
  await expect(call(f, reader, 'browser_action', action)).rejects.toMatchObject({ message: 'Tool browser_action not found' })
  await expect(call(f, disabled, 'browser_action', action)).rejects.toMatchObject({
    name: 'ProtocolError', code: -32601, message: 'Method not found',
  })
  expect(await value(f, agent, 'browser_state_read', state)).toMatchObject({ url: 'about:blank' })
  expect(await value(f, agent, 'browser_action', action)).toMatchObject({ state: 'completed' })
  expect(await value(f, agent, 'browser_action', action)).toMatchObject({ state: 'completed' })
  errorCode(await call(f, agent, 'browser_action', { ...action, action: { ...action.action, url: 'https://fixture.test/conflict' } }), 'COMMAND_ID_CONFLICT')
  const read = await f.http('browser_session_get', { sessionId }, 'GET', `/api/browser/sessions/${sessionId}`)
  expect(read.statusCode).toBe(200); expect(read.json().session.subject).toEqual(subject)
  const otherSubject = { ...subject, agent: { ...subject.agent, workflowNodeId: 'other-node' } }
  const other = ready(await f.sessions.open(f.owner, f.bindSubject(otherSubject)))
  errorCode(await call(f, agent, 'browser_action', { ...action, tabId: other.session.selectedTabId!, commandId: 'sibling-target' }), 'BROWSER_TAB_SCOPE')
  expect(await value(f, agent, 'browser_session_close', { sessionId, commandId: 'close' })).toMatchObject({ state: 'closed' })
  expect((await f.http('browser_session_get', { sessionId: other.session.id }, 'GET', `/api/browser/sessions/${other.session.id}`)).json().session.state).toBe('ready')
  f.revoke('agent')
  await expect(agent.callTool({ name: 'browser_session_get', arguments: f.reference('browser_session_get', { sessionId }) })).rejects.toThrow()
})

it('denies obsolete conversation browser input and retires it while its replacement profile is unavailable over MCP', async () => {
  const f = await fixture()
  const subject = browserSubjects().find(value => value.kind === 'conversation')!
  const request = f.bindSubject(subject)
  f.addCaller('agent', { subject })
  f.addCaller('other-scope', { subject, wrongScope: true })
  const client = await f.connect('agent')
  const denied = await f.connect('other-scope')
  const first = ready(await value(f, client, 'browser_session_open', { intent: 'prepare', request })).session
  const replacement = f.bindSubject(subject, 'missing-profile', false, { availability: 'profile_missing' })
  errorCode(await call(f, client, 'browser_action', { sessionId: first.id, tabId: first.selectedTabId!,
    actor: browserAgent(first), commandId: 'obsolete-profile-action', action: { kind: 'navigate', url: 'https://fixture.test/' } }),
  'BROWSER_SCOPE_MISMATCH')
  errorCode(await call(f, denied, 'browser_session_get', { sessionId: first.id }), 'ACCESS_DENIED')
  expect(await value(f, client, 'browser_session_open', { intent: 'prepare', request: replacement }))
    .toEqual({ kind: 'unavailable', reason: 'profile_missing', retryable: true })
  expect(await value(f, client, 'browser_session_get', { sessionId: first.id }))
    .toMatchObject({ session: { id: first.id, state: 'closed', selectedTabId: null }, tabs: [] })
})

it('uses one authenticated setup lease for tabs, views, control, native fallback, input and replay-safe close', async () => {
  const f = await fixture(), client = await f.connect()
  const opened = await f.http('browser_session_open', { intent: 'setup', profileId: 'profile', computerId: 'main', commandId: 'setup' }, 'POST', '/api/browser/sessions/open')
  expect(opened.statusCode).toBe(200)
  const { session } = ready(opened.json()), sessionId = session.id, browserGeneration = session.browserGeneration, viewerId = 'setup-viewer'
  expect(session).toMatchObject({ setupForProfileId: 'profile' }); expect(session.subject).toBeUndefined()
  expect(await value(f, client, 'browser_sessions_list', { setupForProfileId: 'profile', computerId: 'main' }))
    .toMatchObject({ sessions: [{ id: sessionId }], nextCursor: null })
  const acquired = BrowserControlSchema.parse(await value(f, client, 'browser_control_acquire', { sessionId, viewerId, browserGeneration, commandId: 'take' }))
  const actor = { kind: 'viewer' as const, viewerId, browserGeneration, epoch: acquired.epoch }
  const created = await value(f, client, 'browser_tab_create', { sessionId, actor, commandId: 'new-tab' }) as { createdTabId: string }
  const tabId = created.createdTabId
  expect((await f.http('browser_tab_select', { sessionId, tabId, actor, commandId: 'select' }, 'POST', `/api/browser/sessions/${sessionId}/tabs/${tabId}/select`)).statusCode).toBe(200)
  const action = { sessionId, tabId, actor, action: { kind: 'navigate' as const, url: 'https://fixture.test/first' } }
  expect(await value(f, client, 'browser_action', action)).toMatchObject({ state: 'completed' })
  expect(await value(f, client, 'browser_action', { ...action, action: { ...action.action, url: 'https://fixture.test/second' } })).toMatchObject({ state: 'completed' })
  expect(await value(f, client, 'browser_state_read', { sessionId, tabId, actor })).toMatchObject({ url: 'https://fixture.test/second' })
  expect((await f.http('browser_screenshot', { sessionId, tabId, actor }, 'POST', `/api/browser/sessions/${sessionId}/screenshot`)).json())
    .toMatchObject({ mimeType: 'image/png', sessionId, tabId })
  const viewInput = { sessionId, tabId, browserGeneration, viewerId, commandId: 'open-view' }
  const view = await value(f, client, 'browser_view_open', viewInput) as { id: string }
  expect(await value(f, client, 'browser_view_open', viewInput)).toEqual(view)
  errorCode(await call(f, client, 'browser_view_open', { ...viewInput, tabId: session.selectedTabId! }), 'COMMAND_ID_CONFLICT')
  await expect.poll(async () => (await value(f, client, 'browser_view_read', { viewId: view.id })) as { frame: unknown })
    .toMatchObject({ frame: { mimeType: 'image/png' } })
  for (let index = 0; index < 2; index += 1) {
    const read = await f.http('browser_view_read', { viewId: view.id }, 'GET', `/api/browser/sessions/${sessionId}/views/${view.id}`)
    expect(read.statusCode).toBe(200); expect(read.json().view.id).toBe(view.id)
  }
  expect(await value(f, client, 'browser_view_close', { viewId: view.id })).toEqual({ closed: true })
  const input = { sessionId, tabId, actor, firstSequence: 1, gestures: [{ kind: 'composition' as const, phase: 'end' as const, text: '日本語' }] }
  expect((await f.http('browser_input', input, 'POST', `/api/browser/sessions/${sessionId}/input`)).statusCode).toBe(200)
  const local = BrowserControlSchema.parse(await value(f, client, 'browser_session_open', { intent: 'native_window', sessionId, tabId, actor, commandId: 'local-window' }))
  expect(local).toMatchObject({ state: 'paused', controllingViewerId: viewerId })
  expect(await value(f, client, 'browser_control_release', { sessionId, viewerId, epoch: local.epoch, commandId: 'return' })).toMatchObject({ state: 'paused', controllingViewerId: null })
  const stale = await f.http('browser_input', { ...input, firstSequence: 2 }, 'POST', `/api/browser/sessions/${sessionId}/input`)
  expect(stale.statusCode).toBe(409)
  const reacquired = BrowserControlSchema.parse(await value(f, client, 'browser_control_acquire', { sessionId, viewerId, browserGeneration, commandId: 'take-again' }))
  expect(await value(f, client, 'browser_tab_close', { sessionId, tabId, actor: { ...actor, epoch: reacquired.epoch }, commandId: 'close-tab' })).toMatchObject({ tabs: [{ tabId: session.selectedTabId }] })
  const closed = await f.http('browser_session_close', { sessionId, commandId: 'done' }, 'POST', `/api/browser/sessions/${sessionId}/close`)
  expect(closed.json()).toMatchObject({ state: 'closed' })
  expect(await value(f, client, 'browser_session_close', { sessionId, commandId: 'done' })).toMatchObject({ state: 'already_closed' })
  expect(await value(f, client, 'browser_session_get', { sessionId })).toMatchObject({ session: { state: 'closed' }, files: [] })
})

it('preserves real upload bytes through HTTP and MCP phases and denies foreign, unauthenticated and oversized writes', async () => {
  const f = await fixture(), client = await f.connect(), subject = browserSubjects()[0]!
  f.addCaller('agent', { subject }); const agent = await f.connect('agent')
  const { session } = ready(await value(f, agent, 'browser_session_open', { intent: 'prepare', request: f.bindSubject(subject) }))
  const owner = { sessionId: session.id, tabId: session.selectedTabId!, browserGeneration: session.browserGeneration }
  const bytes = Buffer.from([0, 255, 128, 10, 13, 34, 92, 200]), commandId = 'file-begin'
  const upload = await value(f, agent, 'browser_action', { intent: 'file', phase: 'begin', ...owner,
    name: 'binary.dat', mimeType: 'application/octet-stream', byteLength: bytes.length, commandId }) as BrowserFileMetadata
  const write = { intent: 'file' as const, phase: 'write' as const, sessionId: session.id, fileId: upload.id, offset: 0, bytes: new Uint8Array() }
  const url = `/api/browser/sessions/${session.id}/uploads/${upload.id}/bytes`
  const received = await f.http('browser_action', write, 'PUT', url, 'owner', bytes)
  expect(received.statusCode).toBe(200); expect(received.json().receivedBytes).toBe(bytes.length)
  const finished = await value(f, agent, 'browser_action', { intent: 'file', phase: 'finish', sessionId: session.id, fileId: upload.id })
  expect(finished).toMatchObject({ state: 'ready', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  const readInput = { intent: 'file' as const, phase: 'read' as const, sessionId: session.id, fileId: upload.id, offset: 0, length: bytes.length }
  const downloaded = await f.http('browser_action', readInput, 'GET', `/api/browser/sessions/${session.id}/files/${upload.id}/bytes`)
  expect(downloaded.statusCode).toBe(200); expect(downloaded.headers['content-type']).toContain('application/octet-stream')
  expect(downloaded.rawPayload).toEqual(bytes)
  const mcpBytes = await value(f, agent, 'browser_action', readInput) as { bytesBase64: string }
  expect(Buffer.from(mcpBytes.bytesBase64, 'base64')).toEqual(bytes)
  const other = ready(await value(f, client, 'browser_session_open', { intent: 'setup', profileId: 'other-profile', computerId: 'main', commandId: 'other-setup' }))
  const foreign = await f.http('browser_action', { ...readInput, sessionId: other.session.id }, 'GET', `/api/browser/sessions/${other.session.id}/files/${upload.id}/bytes`)
  expect(foreign.statusCode).toBe(403); expect(foreign.json().error.code).toBe('BROWSER_FILE_SCOPE')
  const oversized = await value(f, agent, 'browser_action', { intent: 'file', phase: 'begin', ...owner, name: 'large.dat',
    mimeType: 'application/octet-stream', byteLength: 262_145, commandId: 'oversized' }) as BrowserFileMetadata
  const largeUrl = `/api/browser/sessions/${session.id}/uploads/${oversized.id}/bytes`
  expect((await f.http('browser_action', { ...write, fileId: oversized.id }, 'PUT', largeUrl, 'owner', Buffer.alloc(262_145))).statusCode).toBe(413)
  expect(await value(f, agent, 'browser_action', { intent: 'file', phase: 'metadata', sessionId: session.id, fileId: oversized.id }))
    .toMatchObject({ receivedBytes: 0, state: 'uploading' })
  expect((await f.app.inject({ method: 'PUT', url: largeUrl, headers: { authorization: 'Bearer unknown', 'content-type': 'application/octet-stream' }, payload: bytes })).statusCode).toBe(401)
  expect((await f.app.inject({ method: 'PUT', url: largeUrl, headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, payload: { bytes: [1] } })).statusCode).toBe(415)
  const attached = await value(f, agent, 'browser_action', { intent: 'file', phase: 'attach', sessionId: session.id,
    tabId: owner.tabId, actor: browserAgent(session), fileId: upload.id, selector: '#file', commandId: 'attach' })
  expect(attached).toMatchObject({ state: 'attached' })
  expect(await value(f, agent, 'browser_action', { intent: 'file', phase: 'cancel', sessionId: session.id, fileId: oversized.id })).toMatchObject({ state: 'canceled' })
})

it('retries an unconfirmed native capture close without allocating the same view command again', async () => {
  const f = await fixture(), client = await f.connect()
  const { session } = ready(await value(f, client, 'browser_session_open', { intent: 'setup', profileId: 'profile', computerId: 'main', commandId: 'setup' }))
  const stop = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('Native stop reply lost')).mockResolvedValue(undefined)
  const capture = vi.spyOn(f.driver, 'capture').mockResolvedValueOnce(stop)
  const input = { sessionId: session.id, tabId: session.selectedTabId!, browserGeneration: session.browserGeneration,
    viewerId: 'viewer', commandId: 'view' }
  const view = await value(f, client, 'browser_view_open', input) as { id: string }
  expect((await call(f, client, 'browser_view_close', { viewId: view.id })).isError).toBe(true)
  expect(await value(f, client, 'browser_view_close', { viewId: view.id })).toEqual({ closed: true })
  expect(stop).toHaveBeenCalledTimes(2)
  errorCode(await call(f, client, 'browser_view_open', input), 'BROWSER_VIEW_CLOSED')
  expect(capture).toHaveBeenCalledTimes(1)
})

it('serializes concurrent preparation commands before accepting a changed saved assignment', async () => {
  const f = await fixture(), subject = browserSubjects()[0]!, first = f.bindSubject(subject, 'first-profile')
  const entered = deferred(), release = deferred(), secondResolved = deferred()
  const nativeOpen = f.driver.openProfile.bind(f.driver), resolve = f.subjectAuthority.resolve.bind(f.subjectAuthority)
  vi.spyOn(f.driver, 'openProfile').mockImplementationOnce(async profileId => { entered.resolve(); await release.promise; return nativeOpen(profileId) })
  vi.spyOn(f.subjectAuthority, 'resolve').mockImplementation(async value => {
    const binding = await resolve(value)
    if (binding.browser.profileId === 'second-profile') secondResolved.resolve()
    return binding
  })
  const pendingFirst = f.http('browser_session_open', { intent: 'prepare', request: first }, 'POST', '/api/browser/sessions/open')
  await entered.promise
  const second = { ...f.bindSubject(subject, 'second-profile'), commandId: first.commandId }
  const pendingSecond = f.http('browser_session_open', { intent: 'prepare', request: second }, 'POST', '/api/browser/sessions/open')
  try { await secondResolved.promise } finally { release.resolve() }
  const [original, conflicting] = await Promise.all([pendingFirst, pendingSecond])
  expect(original.statusCode).toBe(200)
  expect(conflicting.statusCode).toBe(409); expect(conflicting.json().error.code).toBe('COMMAND_ID_CONFLICT')
  expect((await f.http('browser_sessions_list', { subject }, 'GET', '/api/browser/sessions')).json().sessions).toHaveLength(1)
  expect(f.driver.openProfile).toHaveBeenCalledTimes(1)
})
