import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceSetupOptionsSchema } from '@foreman-code/contracts/device-setup'
import { ActivitySnapshotV1Schema } from '@foreman-code/contracts/activity'
import { DeviceListResultSchema, DeviceRegistrationSchema, DevicePairingGrantResultSchema, MainDeviceIdentityPublicSchema } from '@foreman-code/contracts/device-identity'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { OperatorConversationStateSchema, CancelOperatorTurnResponseSchema, SessionControlStateSchema, unavailableSessionControls } from '@foreman-code/contracts'
import { buildApp } from '../src/app.js'
import { createGraphqlMcpServer } from '../src/mcp/unified/server.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { firstScheduleAt, dueSchedule } from '../src/modules/workflows/triggerTiming.js'
import { codexModelOptions } from '../src/modules/harnesses/operatorOptions.js'
import { operatorToolAvailable } from '../src/mcp/operator/availability.js'
import { OPERATOR_TOOL_ACTIONS } from '../src/mcp/operator/catalog.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'
import { operatorToolRequirements } from '../src/mcp/operator/availability.js'

const owner: ManagementPrincipal = {id:'owner',name:'Owner',audience:'operator',expiresAt:'2099-01-01T00:00:00Z',revokedAt:null,
  grants:[{actions:[...ManagementActionSchema.options],scope:{}}]}
function context(principal = owner): OperatorRequestContext {
  return {principal,services:{settings:{},interactions:{},extensions:{native:{},agents:{},history:{},lifecycle:{},
    workspace:{provisioningEnabled:true},runs:{},skills:{},triggers:{}}}} as unknown as OperatorRequestContext
}

describe('Operator MCP permission boundaries', () => {
  it('does not borrow location permission from another workspace', () => {
    const principal={...owner,grants:[{actions:['runs:start'] as const,scope:{workspaceIds:['a']}},{actions:['workspace_locations:read'] as const,scope:{workspaceIds:['b']}}]}
    const candidate={...owner,grants:principal.grants.map(g=>({...g,actions:[...g.actions]}))}
    expect(operatorToolAvailable(context(candidate),'run_start')).toBe(false)
  })
  it('does not advertise unavailable services or disabled provisioning', () => {
    const c=context()
    delete c.services.extensions
    expect(operatorToolAvailable(c,'agent_create')).toBe(false)
    delete c.services.interactions
    expect(operatorToolAvailable(c,'interaction_summary')).toBe(false)
    delete c.services.settings
    expect(operatorToolAvailable(c,'agent_defaults_get')).toBe(false)
  })
  it('has unique tool names and separates workflow interaction grants from Operator chat replies', () => {
    expect(new Set(OPERATOR_TOOL_ACTIONS.map(t=>t.name)).size).toBe(OPERATOR_TOOL_ACTIONS.length)
    expect(OPERATOR_TOOL_ACTIONS.find(t=>t.name==='operator_chat_respond')?.action).toBe('operator_chat:respond')
    const chatResponder: ManagementPrincipal = { ...owner, grants: [{
      actions: ['operator_chat:respond', 'interactions:read'], scope: {},
    }] }
    expect(operatorToolAvailable(context(chatResponder), 'interaction_respond')).toBe(false)
    const responseOnly: ManagementPrincipal = { ...owner, grants: [{
      actions: ['interactions:respond'], scope: {},
    }] }
    expect(operatorToolAvailable(context(responseOnly), 'interaction_respond')).toBe(false)
    const workflowResponder: ManagementPrincipal = { ...owner, grants: [{
      actions: ['interactions:read', 'interactions:respond'], scope: { workspaceIds: ['workspace'] },
    }] }
    expect(operatorToolAvailable(context(workflowResponder), 'interaction_respond')).toBe(true)
  })
})

afterEach(() => vi.restoreAllMocks())

describe('current device and Operator control MCP parity', () => {
  async function fixture(options: { settings?: boolean; operatorChat?: boolean } = {}) {
    // Reuse the discovery fixture. Only the changed ports and authenticated
    // endpoint are exercised; the pool must never connect in this unit suite.
    const c = context()
    const pool = new pg.Pool()
    const connectSql = vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('Unexpected SQL') })
    c.services.commands = new PostgresCommandCoordinator(pool)
    const audit = vi.spyOn(c.services.commands, 'recordDenied').mockResolvedValue(undefined)
    const registration = DeviceRegistrationSchema.parse({ mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, status: 'paired',
      scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'a'.repeat(64) })
    let saved = registration
    const revoke = vi.fn<NonNullable<typeof c.services.devices>['revoke']>(async (_principal, id, revision) => {
      if (id !== saved.deviceId || revision !== saved.authorizationRevision) throw new DomainError('conflict', 'Revision changed.', 409)
      saved = { ...saved, status: 'revoked', authorizationRevision: revision + 1 }
      return saved
    })
    const grant = vi.fn<NonNullable<typeof c.services.devices>['createPairingGrant']>(async (_principal, input) => {
      saved = { ...saved, status: 'pending', workerInstallationId: input.workerInstallationId,
        publicKeyFingerprint: input.expectedFingerprint, scopes: input.scopes }
      return { registration: saved, grant: 'g'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' }
    })
    c.services.devices = {
      readMainIdentity: async () => ({ mainId: registration.mainId, mainPublicKey: 'public-key', mainPublicKeyFingerprint: 'b'.repeat(64) }),
      list: async () => [saved], revoke,
      createPairingGrant: grant,
      createSetupCode: vi.fn(async () => {
        throw new Error('Enrollment is covered by the PostgreSQL integration test.')
      }),
      readSetupOptions: vi.fn(async () => ({ endpoint: null, available: false, reason: 'listener-unconfigured' as const })),
    }
    const activitySnapshot = ActivitySnapshotV1Schema.parse({ schemaVersion: 1,
      scope: { kind: 'operator_chat', conversationId: 'conversation' }, revision: '7',
      active: [{ ref: { kind: 'chat_request', conversationId: 'conversation', requestId: 'request' },
        phase: 'active', outcome: null, delivery: 'accepted', evidence: 'confirmed', startedAt: '2026-10-01T00:00:00.000Z' }], queued: [],
      latest: { kind: 'chat_request', conversationId: 'conversation', requestId: 'request' },
      pendingInteractions: [], activities: [], page: { before: null, nextCursor: null, hasMore: false } })
    let state = OperatorConversationStateSchema.parse({ activitySnapshot, conversation: { id: 'conversation', agentId: 'operator',
      scope: 'application', operatorConfigurationVersionId: 'configuration' }, messages: [], turnState: 'active',
      revision: 7, activeRequestId: 'request', qualificationKey: 'c'.repeat(64) })
    const cancel = vi.fn<NonNullable<typeof c.services.operatorChat>['cancel']>(async () => {
      state = { ...state, turnState: 'canceling', revision: 8 }
      return state
    })
    const respond = vi.fn<NonNullable<typeof c.services.operatorChat>['respond']>(async () => {
      state = { ...state, responseDelivery: 'submitted', revision: 9 }
      return state
    })
    const controls = SessionControlStateSchema.parse({
      conversationId: state.conversation.id,
      revision: 7,
      profileKey: 'configuration',
      desiredMode: 'regular',
      appliedMode: 'regular',
      defaults: {},
      desired: {},
      applied: {},
      applicability: 'applied',
      capabilities: unavailableSessionControls('configuration'),
      context: null,
      nativeSessionId: null,
      nativeProviderVersion: null,
      compaction: null,
      compactions: [],
      busyReason: 'Wait for the active turn to finish.',
    })
    const chat: NonNullable<typeof c.services.operatorChat> = {
      readSessionControls: vi.fn(async () => controls),
      changeSessionControls: vi.fn(async () => controls),
      cancel, respond, get: async () => ({ ...state, activitySnapshot, qualificationKey: 'c'.repeat(64) }),
      setup: async () => ({ harness: 'codex', status: 'configured', endpoint: 'http://127.0.0.1/mcp', checkedAt: new Date().toISOString() }),
      create: async () => state.conversation, send: async () => ({ state, replayed: false }),
      list: async () => [state.conversation],
      setDeleted: async id => ({ conversationId: id }),
      history: async () => ({ conversationId: state.conversation.id, revision: state.revision,
        activeRequestId: state.activeRequestId, entries: [], nextCursor: null }),
      activityPage: async () => ({ activities: [], nextCursor: null }),
      handoffHistory: async () => ({ sourceConversationId: 'source', messages: [], nextCursor: null }),
    }
    c.services.operatorChat = chat
    const reader: ManagementPrincipal = { ...owner, id: 'reader', grants: [{ actions: ['settings:read', 'operator_chat:read'], scope: {} }] }
    const scoped: ManagementPrincipal = { ...owner, id: 'scoped', grants: [{ actions: [...ManagementActionSchema.options], scope: { workspaceIds: ['workspace'] } }] }
    const access = new PostgresAccessService(pool)
    vi.spyOn(access, 'authenticate').mockImplementation(async token => {
      if (token === 'owner') return owner
      if (token === 'reader') return reader
      if (token === 'scoped') return scoped
      throw new DomainError('AUTH_REQUIRED', 'Invalid bearer.', 401)
    })
    if (options.settings === false) delete c.services.settings
    if (options.operatorChat === false) delete c.services.operatorChat
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: c.services } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const clients: Client[] = []
    const connect = async (token: string) => {
      const client = new Client({ name: 'parity-fixture', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    return { c, app, registration, revoke, grant, cancel, respond, chat, audit, connectSql, connect,
      close: async () => { await Promise.all(clients.map(client => client.close())); await app.close(); await pool.end() } }
  }

  it('discovers only globally authorized concrete device/control ports and audits hidden writes', async () => {
    const f = await fixture()
    try {
      const [ownerClient, reader, scoped] = await Promise.all([
        f.connect('owner'), f.connect('reader'), f.connect('scoped'),
      ])
      const names = ['device_main_identity_get', 'device_setup_options_get', 'devices_list', 'device_setup_code_create', 'device_pairing_grant_create', 'device_revoke', 'operator_chat_cancel', 'operator_chat_respond']
      const [ownerTools, capability, readerTools, scopedTools] = await Promise.all([
        ownerClient.listTools(),
        ownerClient.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } }),
        reader.listTools(),
        scoped.listTools(),
      ])
      expect(ownerTools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(names))
      expect(decodeMcpToolResult(capability)).toMatchObject({ tools: expect.arrayContaining(names) })
      const readerNames = readerTools.tools.map(tool => tool.name)
      expect(readerNames).toContain('devices_list')
      for (const name of names.filter(name => !['device_main_identity_get', 'device_setup_options_get', 'devices_list'].includes(name))) expect(readerNames).not.toContain(name)
      const scopedNames = scopedTools.tools.map(tool => tool.name)
      for (const name of names) expect(scopedNames).not.toContain(name)
      await Promise.all(['device_pairing_grant_create', 'device_setup_code_create', 'device_revoke', 'operator_chat_cancel', 'operator_chat_respond'].map(async name => {
        const denied = await reader.callTool({ name, arguments: {} })
        expect(denied.isError).toBe(true)
        expect(f.audit).toHaveBeenCalledWith('reader', 'mcp', name, `mcp:${name}`)
      }))
      expect(f.c.services.devices!.createSetupCode).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled(); expect(f.revoke).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
      delete f.c.services.devices; delete f.c.services.operatorChat
      for (const name of ['device_revoke', 'operator_chat_cancel', 'operator_chat_respond'] as const) expect(operatorToolAvailable(f.c, name)).toBe(false)
      expect(f.connectSql).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

  it('constructs the complete control composition once without settings', async () => {
    const f = await fixture({ settings: false })
    try {
      const server = await createGraphqlMcpServer({ role: 'operator', principal: owner, operator: f.c.services })
      await server.close()
      const client = await f.connect('owner')
      const names = (await client.listTools()).tools.map(tool => tool.name)
      for (const name of ['operator_chat_cancel', 'operator_chat_respond']) expect(names.filter(candidate => candidate === name)).toHaveLength(1)
      expect(names).not.toContain('agent_defaults_get')
      expect(f.connectSql).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

  it('preserves unavailable control responses when chat is absent at construction', async () => {
    const f = await fixture({ operatorChat: false })
    try {
      const client = await f.connect('owner')
      const names = (await client.listTools()).tools.map(tool => tool.name)
      for (const name of ['operator_chat_cancel', 'operator_chat_respond']) {
        expect(names).not.toContain(name)
        const unavailable = await client.callTool({ name, arguments: {} })
        expect(unavailable).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('"code":"OPERATOR_CHAT_UNAVAILABLE"') }] })
      }
      expect(f.cancel).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
      expect(f.connectSql).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

  it('passes exact revisions and receipt identities to existing services and reads saved results', async () => {
    const f = await fixture()
    try {
      const client = await f.connect('owner')
      expect(MainDeviceIdentityPublicSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'device_main_identity_get', arguments: {} })))).mainId).toBe(f.registration.mainId)
      expect(DeviceSetupOptionsSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'device_setup_options_get', arguments: {} }))))).toEqual({ endpoint: null, available: false, reason: 'listener-unconfigured' })
      expect(f.c.services.devices!.readSetupOptions).toHaveBeenCalledWith(owner)
      const grantInput = { workerInstallationId: f.registration.workerInstallationId, publicKey: 'approved-public-key',
        expectedFingerprint: f.registration.publicKeyFingerprint, scopes: f.registration.scopes, commandId: randomUUID() }
      const issued = DevicePairingGrantResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'device_pairing_grant_create', arguments: grantInput }))))
      expect(f.grant).toHaveBeenCalledWith(owner, grantInput, 'mcp')
      const pending = DeviceListResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'devices_list', arguments: {} }))))
      expect(pending.devices).toEqual([issued.registration])
      expect(JSON.stringify(pending)).not.toContain(issued.grant)
      const revokeInput = { deviceId: f.registration.deviceId, expectedRevision: 1, commandId: randomUUID() }
      const revoked = DeviceRegistrationSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'device_revoke', arguments: revokeInput }))))
      expect(f.revoke).toHaveBeenCalledWith(owner, revokeInput.deviceId, 1, revokeInput.commandId, 'mcp')
      expect(DeviceListResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'devices_list', arguments: {} })))).devices).toEqual([revoked])
      const commandId = randomUUID()
      await client.callTool({ name: 'operator_chat_cancel', arguments: { conversationId: 'conversation', request: { requestId: 'request', commandId } } })
      expect(f.cancel).toHaveBeenCalledWith('conversation', 'request', owner, commandId, 'mcp')
      const response = { requestId: 'request', nativeRequestId: 'native-question', optionId: 'native-option', commandId: randomUUID() }
      const responded = CancelOperatorTurnResponseSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'operator_chat_respond', arguments: { conversationId: 'conversation', request: response } }))))
      expect(f.respond).toHaveBeenCalledWith('conversation', response, owner, 'mcp')
      expect(OperatorConversationStateSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'operator_chat_get', arguments: { conversationId: 'conversation' } }))))).toEqual(responded.state)
      expect(f.connectSql).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

  it('requires global read access alongside each protected-state Operator control', async () => {
    const f = await fixture()
    try { for (const name of ['operator_chat_cancel', 'operator_chat_respond'] as const) {
      const action = name === 'operator_chat_cancel' ? 'operator_chat:cancel' : 'operator_chat:respond'
      expect(operatorToolRequirements(name)).toEqual([{ action, scope: 'global' }, { action: 'operator_chat:read', scope: 'global' }])
      const commandOnly: ManagementPrincipal = { ...owner, grants: [{ actions: [action], scope: {} }] }
      const c = context(commandOnly)
      // Service existence is enough for discovery; permissions fail before use.
      c.services.operatorChat = f.chat
      expect(operatorToolAvailable(c, name)).toBe(false)
      c.principal = { ...owner, grants: [{ actions: [action], scope: {} }, { actions: ['operator_chat:read'], scope: { workspaceIds: ['workspace'] } }] }
      expect(operatorToolAvailable(c, name, { workspaceId: 'workspace' })).toBe(false)
    } } finally { await f.close() }
  })
})

describe('native discovery and interval scheduling', () => {

  it('reports model-specific Codex effort and tier support', () => {
    expect(codexModelOptions({models:[{slug:'m',supported_reasoning_levels:[{effort:'low'}],additional_speed_tiers:['fast']}]}))
      .toEqual([{id:'m',reasoningEfforts:['low'],variants:[],serviceTiers:['standard','priority']}])

  })
  it('does not burst missed schedule intervals', () => {
    const trigger={kind:'schedule',startsAt:'2026-09-17T00:00:00Z',intervalSeconds:60,missed:'skip',input:{}} as const
    const start=Date.parse(trigger.startsAt)
    expect(firstScheduleAt(trigger,start+1)).toBe(start+60_000)
    expect(dueSchedule(trigger,start,start+180_000)).toEqual({fireAt:null,nextAt:start+240_000})
    expect(dueSchedule({...trigger,missed:'latest'},start,start+180_000)).toEqual({fireAt:start+180_000,nextAt:start+240_000})
  })
})
