import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import pg from 'pg'
import { z } from 'zod'
import { vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { registerOperatorHttpSecurity, requirePrincipal } from '../access/http.js'
import { PostgresAccessService, bearerToken } from '../access/postgres.js'
import { hasAction, isAuthorized, requireAuthorization } from '../access/policy.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { BrowserProfileService } from '../browser-profiles/service.js'
import type { BrowserProfileRepository, BrowserProfileTransaction, BrowserProfileHost, StoredProfile,
  BrowserProfileReplica, BrowserProfileSyncJob, ProfileCommand, ProfileHostIntent,
  BrowserProfileSnapshotManifest } from '../browser-profiles/types.js'
import type { BrowserPairingAuthority, BrowserInstallationBinding } from '../browser-profiles/keys.js'
import { registerBrowserProfileRoutes } from '../../routes/browserProfiles.js'
import { registerBrowserSessionRoutes } from '../../routes/browserSessions.js'
import { createBrowserProfileTools } from '../../mcp/operator/tools/browserProfiles.js'
import { createBrowserSessionTools, createBrowserAgentHandlers } from '../../mcp/operator/tools/browserSessions.js'
import { toolResult, toolFailure } from '../../mcp/shared/results.js'
import type { OperatorServices, OperatorRequestContext } from '../../mcp/operator/types.js'
import { BrowserBroker } from './broker.js'
import { BrowserFileStore } from './files.js'
import { BrowserMediaService } from './media.js'
import { localBrowserMediaSource } from './mediaSocket.js'
import { BrowserSessionService, type BrowserSessionAuthority } from './service.js'
import { createBrowserSessionRouter, type BrowserSessionLocations, type BrowserSessionTransport } from './sessionRouter.js'
import { createBrowserOperationHandlers, type BrowserOperationInputs, type BrowserOperationName,
  type BrowserCanonicalCodecs } from './operations.js'
import type { AgentSubject, BrowserActor, BrowserNativeDriver, BrowserPreparedBinding, BrowserHostFrame,
  BrowserRuntimeJournal, BrowserRuntimeReceipt, BrowserRuntimeSessionRecord, BrowserSession, BrowserSubjectAuthority, NativeBrowserTab } from './types.js'

export function browserSubjects(): AgentSubject[] {
  const agent = { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent',
    productRole: 'coder' as const, displayName: 'Fixture worker', configurationVersionId: 'configuration' }
  return [
    { kind: 'execution', agent, execution: { runId: 'run', workflowVersionId: 'version', executionId: 'execution', attempt: 1 } },
    { kind: 'conversation', agent, conversationId: 'conversation' },
    { kind: 'coordinator_consultation', agent: { ...agent, productRole: 'orchestrator' }, binding: {
      runId: 'run', workflowVersionId: 'version', waitingActivationId: 'waiting', delegationGroupId: 'delegation',
      consultationId: 'consultation', nativeSessionId: 'native-consultation', purpose: 'consultation' } },
  ]
}

export function browserAgent(session: BrowserSession, epoch = 0): BrowserActor {
  return { kind: 'agent', epoch, browserGeneration: session.browserGeneration }
}

function memoryJournal(): BrowserRuntimeJournal {
  const commands = new Map<string, BrowserRuntimeReceipt>(), sessions = new Map<string, BrowserRuntimeSessionRecord>()
  return {
    read: async key => structuredClone(commands.get(key)),
    write: async (key, value) => { commands.set(key, structuredClone(value)) },
    saveSession: async value => { sessions.set(value.session.id, structuredClone(value)) },
    loadSessions: async () => structuredClone([...sessions.values()]),
  }
}

function memoryProfiles(): BrowserProfileRepository {
  const profiles = new Map<string, StoredProfile>(), replicas = new Map<string, BrowserProfileReplica>()
  const jobs = new Map<string, BrowserProfileSyncJob>(), commands = new Map<string, ProfileCommand>()
  const intents = new Map<string, ProfileHostIntent>(), exports = new Map<string, string>()
  const manifests = new Map<string, BrowserProfileSnapshotManifest>(), installations = new Map<string, string>()
  let revision = 0, tail = Promise.resolve()
  const key = (profile: string, computer: string) => `${profile}:${computer}`
  const facts: BrowserProfileTransaction['replicaFacts'] = async (profileId, computerId) => {
    const relevant = [...intents.values()].filter(i => i.profileId === profileId && i.computerId === computerId)
      .sort((a, b) => b.revision - a.revision)
    const last = relevant.find(i => i.state === 'completed')
    return { present: last?.operation === 'create' || last?.operation === 'sync', presenceRevision: last?.revision ?? 0,
      currentIntent: relevant[0] ?? null }
  }
  const tx: BrowserProfileTransaction = {
    pendingWork: async () => [],
    retention: async () => ({ snapshots: [], operations: [], computers: [], revision: 0 }), clearRetention: async () => undefined,
    profile: async id => structuredClone(profiles.get(id)),
    putProfile: async value => { profiles.set(value.profile.id, structuredClone(value)); revision += 1 },
    profiles: async (after, limit) => structuredClone([...profiles.values()].filter(p => !p.deleted && (!after || p.profile.id > after))
      .sort((a, b) => a.profile.id.localeCompare(b.profile.id)).slice(0, limit)),
    catalogRows: async (after, computerIds, limit) => {
      const rows = []
      for (const value of [...profiles.values()].filter(p => !p.deleted).sort((a, b) => a.profile.id.localeCompare(b.profile.id))) {
        for (const computerId of [...computerIds].sort()) {
          if (after && (value.profile.id < after[0] || value.profile.id === after[0] && computerId <= after[1])) continue
          rows.push({ profile: value.profile, computerId, replica: replicas.get(key(value.profile.id, computerId)) ?? null,
            facts: await facts(value.profile.id, computerId) })
        }
      }
      return structuredClone(rows.slice(0, limit))
    },
    replicaFacts: facts,
    replica: async (profileId, computerId) => structuredClone(replicas.get(key(profileId, computerId))),
    replicas: async profileId => structuredClone([...replicas.values()].filter(r => r.profileId === profileId)),
    putReplica: async value => { replicas.set(key(value.profileId, value.computerId), structuredClone(value)); revision += 1 },
    job: async id => structuredClone(jobs.get(id)), putJob: async value => { jobs.set(value.id, structuredClone(value)) },
    command: async id => structuredClone(commands.get(id)), putCommand: async (id, value) => { commands.set(id, structuredClone(value)) },
    intent: async id => structuredClone(intents.get(id)), putIntent: async value => { intents.set(value.id, structuredClone(value)); revision += 1 },
    intents: async profileId => structuredClone([...intents.values()].filter(i => i.profileId === profileId)),
    exportOwner: async id => exports.get(id), setExportOwner: async (id, job) => { if (job) exports.set(id, job); else exports.delete(id) },
    catalogRevision: async () => revision,
    publishedManifest: async id => structuredClone(manifests.get(id)),
    putPublishedManifest: async value => { manifests.set(value.snapshot.profileId, structuredClone(value)) },
    jobInstallation: async (jobId, computerId) => installations.get(key(jobId, computerId)),
    putJobInstallation: async (jobId, computerId, installationId) => { installations.set(key(jobId, computerId), installationId) },
  }
  return {
    read: work => work(tx),
    transaction: (_locks, work) => {
      const task = tail.then(() => work(tx))
      tail = task.then(() => undefined, () => undefined)
      return task
    },
  }
}

function nativeFixture(): BrowserNativeDriver {
  const tabs = new Map<string, NativeBrowserTab & { profile: string; generation: number }>()
  const own = (profile: string, generation: number, target: string) => {
    const tab = tabs.get(target)
    if (!tab || tab.profile !== profile || tab.generation !== generation) throw new Error('Foreign native target reached the fixture')
    return tab
  }
  return {
    openProfile: async () => ({ generation: 1 }), reconnectProfile: async () => ({ generation: 1 }),
    closeProfile: async () => undefined, settlePopups: async () => undefined,
    restoreTab: async (profile, generation, target) => own(profile, generation, target),
    createTab: async (profile, generation) => {
      const tab = { targetId: randomUUID(), title: 'Fixture page', url: 'about:blank', profile, generation }
      tabs.set(tab.targetId, tab); return tab
    },
    closeTab: async (profile, generation, target) => { own(profile, generation, target); tabs.delete(target) },
    dispatch: async (profile, generation, target, method, params) => {
      const tab = own(profile, generation, target)
      if (method === 'Page.navigate') { tab.url = String(params.url); tab.title = 'Navigated fixture' }
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('fixture-image').toString('base64') }
      if (method === 'Foreman.chooserNode') return { backendNodeId: 1 }
      return { title: tab.title, url: tab.url, text: 'Fixture content', dialog: null }
    },
    action: async (action, dispatch) => dispatch(action.kind === 'navigate' ? 'Page.navigate' : 'Fixture.action', action),
    observe: async dispatch => await dispatch('Fixture.observe') as { title: string; url: string; text: string; dialog: null },
    input: async (input, dispatch) => { await dispatch('Fixture.input', { input }) },
    releasePressed: async dispatch => { await dispatch('Fixture.releasePressed') },
    capture: async (_profile, _generation, _target, frame) => {
      const value: BrowserHostFrame = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', width: 100, height: 80,
        viewportOffsetTop: 0, capturedAt: new Date().toISOString() }
      const timer = setInterval(() => frame(value), 120)
      return async () => { clearInterval(timer) }
    },
    openLocal: async () => undefined, facts: () => ({ dialog: null, uploadChooser: null }),
    onTabClosed: () => () => undefined, onPopup: () => () => undefined,
  }
}

// A reference-only codec is a typed substitute for D/C0's absent request-envelope binding.
// It deliberately does not restate, validate, or claim coverage of the canonical wire schemas.
const ReferenceSchema = z.object({ reference: z.string() })
function fixtureCodec<Name extends BrowserOperationName>() {
  const values = new Map<string, BrowserOperationInputs[Name]>()
  const decode = (value: unknown) => {
    const reference = ReferenceSchema.parse(value).reference, input = values.get(reference)
    if (!input) throw new Error('Unknown typed fixture input')
    return input
  }
  return {
    inputSchema: ReferenceSchema,
    decodeMcp: decode,
    decodeHttp: (request: { params: unknown; query: unknown; body: unknown; method?: string }) =>
      decode(request.method === 'GET' || request.method === 'PUT' ? request.query : request.body),
    encode: (value: unknown) => value instanceof Uint8Array ? { bytesBase64: Buffer.from(value).toString('base64') } : value,
    bind: (input: BrowserOperationInputs[Name]) => { const reference = randomUUID(); values.set(reference, input); return { reference } },
  }
}

type FixtureCodecs = { [Name in BrowserOperationName]: ReturnType<typeof fixtureCodec<Name>> }

function fixtureCodecs(): FixtureCodecs {
  const action = fixtureCodec<'browser_action'>()
  return {
    browser_profiles_list: fixtureCodec<'browser_profiles_list'>(), browser_profile_get: fixtureCodec<'browser_profile_get'>(),
    browser_profile_create: fixtureCodec<'browser_profile_create'>(), browser_profile_update: fixtureCodec<'browser_profile_update'>(),
    browser_profile_remove: fixtureCodec<'browser_profile_remove'>(), browser_profiles_sync: fixtureCodec<'browser_profiles_sync'>(),
    browser_profile_sync_get: fixtureCodec<'browser_profile_sync_get'>(), browser_session_open: fixtureCodec<'browser_session_open'>(),
    browser_sessions_list: fixtureCodec<'browser_sessions_list'>(), browser_session_get: fixtureCodec<'browser_session_get'>(),
    browser_session_close: fixtureCodec<'browser_session_close'>(), browser_tabs_list: fixtureCodec<'browser_tabs_list'>(),
    browser_tab_create: fixtureCodec<'browser_tab_create'>(), browser_tab_select: fixtureCodec<'browser_tab_select'>(),
    browser_tab_close: fixtureCodec<'browser_tab_close'>(), browser_state_read: fixtureCodec<'browser_state_read'>(),
    browser_screenshot: fixtureCodec<'browser_screenshot'>(),
    browser_action: { ...action, decodeHttp: (request: Parameters<typeof action.decodeHttp>[0]) => {
      const input = action.decodeHttp(request)
      if (request.method !== 'PUT' || input.intent !== 'file' || input.phase !== 'write') return input
      if (!(request.body instanceof Uint8Array)) throw new Error('The real HTTP parser did not preserve upload bytes')
      return { ...input, bytes: request.body }
    } },
    browser_view_open: fixtureCodec<'browser_view_open'>(), browser_view_read: fixtureCodec<'browser_view_read'>(),
    browser_view_close: fixtureCodec<'browser_view_close'>(), browser_control_acquire: fixtureCodec<'browser_control_acquire'>(),
    browser_control_release: fixtureCodec<'browser_control_release'>(), browser_input: fixtureCodec<'browser_input'>(),
  } satisfies BrowserCanonicalCodecs
}

function missingPort<T extends object>(name: string): T {
  // An intentionally unusable typed shared port; an accidental call fails instead of returning invented data.
  return new Proxy(Object.create(null) as T, { get: () => { throw new Error(`Unexpected shared service: ${name}`) } })
}

interface Caller { principal: ManagementPrincipal; subject?: AgentSubject; readOnly: boolean; enabled: boolean; wrongScope?: boolean }
export async function endpointFixture(options: {
  repository?: BrowserProfileRepository
  codecs?: BrowserCanonicalCodecs
  computers?: Array<{ id: string; online: boolean }>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'browser-endpoints-')), pool = new pg.Pool()
  const unexpectedSql = vi.spyOn(pool, 'connect').mockRejectedValue(new Error('Unexpected SQL in the typed peer fixture'))
  const owner: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', expiresAt: '2099-01-01T00:00:00.000Z',
    revokedAt: null, grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] }
  const callers = new Map<string, Caller>([['owner', { principal: owner, readOnly: false, enabled: true }]])
  const assignments = new Map<string, BrowserPreparedBinding>(), subjectKey = (subject: AgentSubject) => JSON.stringify(subject)
  const caller = (principal: ManagementPrincipal) => {
    const value = callers.get(principal.id)
    if (!value || value.principal.revokedAt) throw new DomainError('AUTH_REQUIRED', 'This caller is no longer authorized.', 401)
    return value
  }
  const authorizeSubject = async (principal: ManagementPrincipal, subject: AgentSubject, mutate: boolean) => {
    const value = caller(principal)
    if (!value.enabled || value.subject && subjectKey(value.subject) !== subjectKey(subject)) throw new DomainError('BROWSER_SCOPE_MISMATCH', 'The exact subject is unavailable to this caller.', 403)
    if (mutate && value.readOnly) throw new DomainError('BROWSER_READ_ONLY', 'This caller is read-only.', 403)
    if (value.wrongScope) throw new DomainError('ACCESS_DENIED', 'This exact subject is outside the fixture credential scope.', 403)
    // Scoped-agent authority is a D/C peer port. Operator management grants intentionally reject Worker audiences.
    if (principal.audience === 'operator') requireAuthorization(principal, mutate ? 'workflows:update' : 'workflows:read',
      { workspaceId: subject.agent.workspaceId, workflowId: subject.agent.workflowId })
  }
  const authority: BrowserSessionAuthority<ManagementPrincipal> = {
    callerId: principal => caller(principal).principal.id,
    subject: authorizeSubject,
    setup: async (principal, _profile, _computer, mutate) => { caller(principal); requireAuthorization(principal, mutate ? 'settings:update' : 'settings:read', {}) },
    session: async (principal, session, mutate) => session.subject ? authorizeSubject(principal, session.subject, mutate)
      : authority.setup(principal, session.profileId, session.computerId, mutate),
    actor: async principal => caller(principal).subject ? 'agent' : 'viewer',
  }
  const subjectAuthority: BrowserSubjectAuthority = {
    resolve: async subject => { const binding = assignments.get(subjectKey(subject)); if (!binding) throw new DomainError('BROWSER_SCOPE_MISMATCH', 'The subject has no saved assignment.', 403); return structuredClone(binding) },
    assertCurrent: async (subject, assignment?: { profileId: string }) => {
      const accepted = assignments.get(subjectKey(subject))
      if (!accepted) throw new DomainError('AGENT_SUBJECT_ENDED', 'This subject ended.', 403)
      if (assignment && accepted.browser.profileId !== assignment.profileId) {
        throw new DomainError('BROWSER_SCOPE_MISMATCH', 'The browser profile assignment changed.', 409)
      }
    },
  }
  const driver = nativeFixture(), broker = new BrowserBroker({ computerId: 'main', driver, journal: memoryJournal(), authority: subjectAuthority })
  const media = new BrowserMediaService(broker), files = new BrowserFileStore(join(root, 'files'), async (input, mutate) => {
    const current = broker.read(input.sessionId)
    if (mutate && (current.session.state === 'closed' || !current.tabs.some(tab => tab.tabId === input.tabId && tab.browserGeneration === input.browserGeneration))) {
      throw new DomainError('BROWSER_FILE_SCOPE', 'The exact upload owner is no longer live.', 403)
    }
  })
  const local = new BrowserSessionService(broker, media, files, authority)
  const locationsById = new Map<string, { session: BrowserSession; installationId: string }>(), views = new Map<string, string>()
  const locations: BrowserSessionLocations = {
    session: async id => structuredClone(locationsById.get(id)), save: async (session, installationId) => { locationsById.set(session.id, { session: structuredClone(session), installationId }) },
    view: async id => views.get(id), saveView: async (id, sessionId) => { views.set(id, sessionId) },
  }
  const binding: BrowserInstallationBinding = { computerId: 'main', installationId: 'installation', connectionId: 'connection' }
  const pairing: BrowserPairingAuthority = {
    current: async computer => { if (computer !== 'main') throw new Error('Unexpected computer'); return binding },
    assertCurrent: async value => { if (JSON.stringify(value) !== JSON.stringify(binding)) throw new Error('Stale pairing') },
    assertInstallation: async (computer, installation) => { if (computer !== binding.computerId || installation !== binding.installationId) throw new Error('Stale installation') },
    wrappingKey: async () => { throw new Error('Endpoint fixtures do not request snapshot keys') },
  }
  const transport: BrowserSessionTransport<ManagementPrincipal> = { invoke: async () => { throw new Error('Unexpected remote command') } }
  const sessions = createBrowserSessionRouter({ localComputerId: 'main', local, locations, pairing, transport, authority,
    computers: async () => ['main'], subjectComputer: async () => 'main', media: () => localBrowserMediaSource(local) })
  const host: BrowserProfileHost = {
    installation: async () => binding.installationId, status: async () => 'ready', create: async () => undefined, remove: async () => undefined,
    export: async () => { throw new Error('A one-computer profile fixture has no destination export') },
    receive: async () => { throw new Error('Unexpected snapshot receive') }, apply: async () => { throw new Error('Unexpected snapshot apply') },
    prune: async () => undefined, checkOrigin: async input => ({ origin: input.origin, state: 'signed_in',
      checkedAt: '2026-10-21T00:00:00.000Z', evidence: 'site_probe', reason: null }),
  }
  const profiles = new BrowserProfileService({ repository: options.repository ?? memoryProfiles(), host, authority: {
    authorize: async (principal, action) => { caller(principal); requireAuthorization(principal, action, {}) },
    computers: async () => options.computers ?? [{ id: 'main', online: true }],
  } })
  const codecs = fixtureCodecs(), handlers = createBrowserOperationHandlers(profiles, sessions)
  if (options.codecs) for (const name of Object.keys(codecs) as BrowserOperationName[]) Object.assign(codecs[name], options.codecs[name])
  const definitions = [...createBrowserProfileTools(handlers, codecs), ...createBrowserSessionTools(handlers, codecs)]
  const commands = new PostgresCommandCoordinator(pool), denied = vi.spyOn(commands, 'recordDenied').mockResolvedValue(undefined)
  const services: OperatorServices = { commands, workspaces: missingPort('workspaces'), locations: missingPort('locations'),
    workflows: missingPort('workflows'), agents: missingPort('agents'), harnesses: missingPort('harnesses'), runs: missingPort('runs') }
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    const found = token ? callers.get(token) : undefined
    if (!found || found.principal.revokedAt) throw new DomainError('AUTH_REQUIRED', 'Invalid fixture bearer.', 401)
    return found.principal
  })
  const app = Fastify({ logger: false })
  app.setErrorHandler<Error & { statusCode?: number; code?: string }>((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } })
    return reply.code(error.statusCode ?? 500).send({ error: { code: error.code ?? 'FIXTURE_FAILURE', message: error.message } })
  })
  registerOperatorHttpSecurity(app, access)
  registerBrowserProfileRoutes(app, handlers, codecs)
  registerBrowserSessionRoutes(app, handlers, codecs, sessions)
  // D owns the unified registry mount. This real SDK endpoint substitutes only that missing registration seam.
  app.post('/mcp', { onRequest: async request => { request.operatorPrincipal = await access.authenticate(bearerToken(request.headers.authorization), ['operator', 'worker']) } }, async (request, reply) => {
    const principal = requirePrincipal(request), context: OperatorRequestContext = { principal, services }
    const server = new McpServer({ name: 'browser-endpoint-fixture', version: '1' }), identity = caller(principal)
    if (identity.subject) {
      for (const handler of createBrowserAgentHandlers(handlers, codecs)) {
        if (!identity.enabled || identity.readOnly && !handler.readOnly) continue
        server.registerTool(handler.name, { inputSchema: handler.inputSchema }, async input => {
          try { return toolResult(await handler.invoke(principal, input)) } catch (error) { return toolFailure(error) }
        })
      }
    } else for (const definition of definitions) {
      const available = definition.discoverable?.(context) ?? definition.requires.every(([action, scope]) =>
        scope === 'global' ? isAuthorized(principal, action, {}) : hasAction(principal, action))
      if (!available) continue
      server.registerTool(definition.name, {
        inputSchema: definition.inputSchema,
        description: definition.description,
        annotations: definition.annotations,
      }, async input => {
        try {
          return toolResult(await definition.run(context, input))
        } catch (error) {
          if (error instanceof DomainError && error.status === 403) {
            await commands.recordDenied(principal.id, 'mcp', definition.name, `mcp:${definition.name}`)
          }
          return toolFailure(error)
        }
      })
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport); reply.hijack()
    try {
      const handle = toNodeHandler({ fetch: (webRequest, options) => transport.handleRequest(webRequest, options) })
      await handle({ method: request.method, url: request.url, headers: request.raw.headers,
        [Symbol.asyncIterator]: () => request.raw[Symbol.asyncIterator]() }, reply.raw, request.body)
    } finally { await transport.close(); await server.close() }
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 }), clients: Client[] = []
  const connect = async (token = 'owner') => {
    const client = new Client({ name: 'browser-parity', version: '1' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    return client
  }
  const reference = <Name extends BrowserOperationName>(name: Name, input: BrowserOperationInputs[Name]) =>
    codecs[name].bind(input)
  return { app, owner, profiles, broker, driver, subjectAuthority, files, sessions, codecs, denied, unexpectedSql, connect, reference,
    addCaller(id: string, options: { subject?: AgentSubject; readOnly?: boolean; enabled?: boolean; wrongScope?: boolean } = {}) {
      const principal: ManagementPrincipal = { ...owner, id, audience: options.subject ? 'worker' : 'operator', grants: [{
        actions: options.readOnly ? ['capabilities:read', 'settings:read', 'workflows:read'] : [...ManagementActionSchema.options],
        scope: options.wrongScope ? { workspaceIds: ['other-workspace'] } : {},
      }] }
      callers.set(id, { principal, ...(options.subject ? { subject: options.subject } : {}), readOnly: options.readOnly ?? false,
        enabled: options.enabled ?? true, wrongScope: options.wrongScope ?? false })
      return principal
    },
    bindSubject(subject: AgentSubject, profileId = 'profile', readOnly = false,
      options: { availability?: BrowserPreparedBinding['availability'] } = {}) {
      const browser = { enabled: true, profileId }
      assignments.set(subjectKey(subject), { subject, browser, computerId: 'main', readOnly, availability: options.availability ?? 'ready' })
      return { subject, browser, computerId: 'main', commandId: randomUUID() }
    },
    revoke(id: string) { const value = callers.get(id); if (value) value.principal = { ...value.principal, revokedAt: new Date().toISOString() } },
    async http<Name extends BrowserOperationName>(name: Name, input: BrowserOperationInputs[Name], method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, token = 'owner', bytes?: Uint8Array) {
      const ref = reference(name, input), query = method === 'GET' || method === 'PUT'
      return app.inject({ method, url: query ? `${url}?reference=${encodeURIComponent(ref.reference)}` : url,
        headers: { authorization: `Bearer ${token}`, ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}) },
        ...(method === 'PUT' ? { payload: Buffer.from(bytes ?? []) } : query ? {} : { payload: ref }) })
    },
    async close() {
      for (const session of broker.list()) await media.closeSession(session.id)
      await Promise.all(clients.map(client => client.close())); await app.close(); await pool.end()
      await rm(root, { recursive: true, force: true })
    },
  }
}
