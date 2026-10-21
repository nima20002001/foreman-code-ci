import type pg from 'pg'
import { EventEmitter, once } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { PendingNativeInteractionSchema } from '@foreman-code/contracts'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { createPostgresClaudeInteractionBridge, PostgresClaudeInteractionAuthority } from '../src/modules/harnesses/claudeSdk/domainAuthority.js'
import { claudeCallbackDatabase } from './support/claudeCallbackDatabase.js'
const configuration: ClaudeHarnessConfiguration = { harness: 'claude', model: 'fixture', authMode: 'subscription', configDirectory: '/fixture', permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Read', 'AskUserQuestion'], permissionRules: [], instructions: '', mcpServers: {} }
const session = { harness: 'claude' as const, nativeSessionId: 'native-session', providerVersion: 'fixture-cli' }
const identity = { ownerPrincipalId: 'sender', attemptId: 'model-request', nativeSessionId: session.nativeSessionId, nativeMessageId: 'input-message', clientCorrelationId: 'accepted-correlation', generation: 'sdk-generation', toolUseId: 'tool-use', nativeRequestId: 'control-request', nativeRequestType: 'can_use_tool' as const }
/** SQL modeled existing tables/claims; no live DB, fabricated native ACK or second application store. */
function fixture(kind: 'operator' | 'agent' = 'operator') {
  const pending = new EventEmitter()
  const principals = new Map(['sender', 'responder'].map((id) => [id, { id, name: id, audience: 'operator', grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:respond', 'agent_chat:read', 'agent_chat:write', 'agent_chat:respond'], scope: {} }], expires_at: new Date('2099-01-01'), revoked_at: null, delegated_from: null }]))
  const row = { kind, owner_principal_id: kind === 'operator' ? 'sender' : null, workspace_id: 'workspace', workflow_id: 'workflow', origin_run_id: null,
    active_request_id: 'model-request' as string | null, native_session_id: session.nativeSessionId, provider_version: session.providerVersion, cancel_requested: false, deleted_at: null, record: { status: 'open' },
    payload: { ownerPrincipalId: 'sender', nativeSubmission: { kind: 'message', nativeSessionId: session.nativeSessionId, nativeMessageId: identity.nativeMessageId, clientCorrelationId: identity.clientCorrelationId } },
    pending_interaction: null as unknown, response_delivery: null as string | null }
  let receipts: unknown[] = []
  const callbacks = claudeCallbackDatabase()
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    const callbackResult = callbacks(text, values)
    if (callbackResult) return callbackResult
    const result = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount, command: 'SELECT', oid: 0, fields: [] })
    if (text.includes('from management_principals where id=')) return result(principals.has(values[0] as string) ? [principals.get(values[0] as string)] : [])
    if (text.startsWith('select * from operator_conversations') || text.startsWith('select active_request_id from operator_conversations')) return result([row])
    if (text.includes('join operator_conversation_turns t')) { expect(values[0]).toBe('conversation'); expect([null, 'model-request']).toContain(values[1]); return result([structuredClone(row)]) }
    if (text.includes('select principal_id,result from management_command_receipts')
      || text.includes('select result from management_command_receipts')) return result(receipts)
    if (text.includes('set pending_interaction=')) {
      expect(values[0]).toBe('conversation'); expect(values[1]).toBe('model-request')
      row.pending_interaction = values[2] ? JSON.parse(values[2] as string) : null
      if (kind === 'operator') row.response_delivery = 'offered'
      if (row.pending_interaction) pending.emit('offered')
      return result([], 1)
    }
    if (text.includes("set response_delivery='submitted'")) {
      if (row.response_delivery !== 'offered' || row.cancel_requested) return result([], 0)
      row.response_delivery = 'submitted'; return result([], 1)
    }
    throw new Error('Unexpected SQL boundary: ' + text.slice(0, 100))
  })
  const database = { query } as unknown as pg.Pool
  const operator = new PostgresOperatorConversationRepository(database)
  const agent = new PostgresAgentChatRepository(database)
  const manager = { nativeCallbackContext: vi.fn(() => ({ nativeSessionId: session.nativeSessionId, nativeMessageId: identity.nativeMessageId, clientCorrelationId: identity.clientCorrelationId, generation: identity.generation })) }
  const port = createPostgresClaudeInteractionBridge({ database, configuration, manager,
    binding: kind === 'operator' ? { kind, conversationId: 'conversation', repository: operator }
      : { kind, conversationId: 'conversation', workspaceId: 'workspace', repository: agent } })
  const claim = async (optionId = 'allow_once', generation = identity.generation, callback = identity) => {
    if (kind === 'operator') expect(await operator.claimResponse('conversation', 'model-request', callback.nativeRequestId)).toBe(true)
    // Existing NativeConversationControlCommands persisted reservation fixture, including actual observed generation.
    receipts = [{ principal_id: 'responder', result: { status: 'pending', acceptedControl: { modelRequestId: 'model-request', conversationId: 'conversation', scope: { kind: kind === 'operator' ? 'operator_chat' : 'agent_chat', conversationId: 'conversation', workspaceId: 'workspace', workflowId: 'workflow' }, native: { harness: 'claude', providerVersion: session.providerVersion, sessionId: session.nativeSessionId, messageId: identity.nativeMessageId, generation, requestId: callback.nativeRequestId, requestType: identity.nativeRequestType }, choice: { optionId, semantic: optionId === 'allow_once' ? 'approve_once' : optionId === 'deny' ? 'reject' : 'cancel' } } } }]
  }
  return { ...port, row, principals, query, claim, manager, waitForPending: () => once(pending, 'offered', { signal: AbortSignal.timeout(1000) }) }
}
async function offered(f: ReturnType<typeof fixture>) {
  const pending = f.bridge.canUseTool(identity, 'Read', { path: 'scope-owned' }, new AbortController().signal)
  await f.waitForPending()
  expect(f.row.pending_interaction).not.toBeNull()
  const descriptor = (await f.interactionPort.pending(session))!
  return { pending, descriptor }
}

it.each(['operator', 'agent'] as const)('publishes an owned worker %s callback through the existing pending record', async kind => {
  const f = fixture(kind)
  const request = { toolName: 'Read', input: { path: 'selected-file' }, nativeMessageId: identity.nativeMessageId,
    toolUseId: identity.toolUseId, generation: identity.generation, attemptId: identity.attemptId }
  const pending = PendingNativeInteractionSchema.parse({ session,
    turn: { nativeMessageId: identity.nativeMessageId, nativeRequestId: identity.nativeRequestId },
    nativeRequestType: identity.nativeRequestType,
    request,
    responseOptions: [{ optionId: 'allow_once', semantic: 'approve_once', label: 'Allow once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }] })
  expect(f.bridge.pendingInteractions(session)).toHaveLength(0)
  await f.authority.publishPending(identity, pending)
  expect(f.row.pending_interaction).toEqual(pending)
  expect(f.bridge.pendingInteractions(session)).toHaveLength(0)
  await expect(f.authority.publishPending(identity, { ...pending,
    request: { ...request, generation: 'another-query' } })).rejects.toMatchObject({ code: 'CLAUDE_CALLBACK_SCOPE_DENIED' })
  expect(f.row.pending_interaction).toEqual(pending)
  f.principals.get('sender')!.grants[0]!.actions = [kind === 'operator' ? 'operator_chat:read' : 'agent_chat:read']
  await expect(f.authority.publishPending(identity, pending)).rejects.toMatchObject({ status: 403 })
})
it.each(['operator', 'agent'] as const)('derives actual %s sender/attempt and persists pending through its existing repository', async (kind) => {
  const f = fixture(kind)
  expect(await f.callbackAdmission()).toEqual({ ownerPrincipalId: 'sender', attemptId: 'model-request' })
  const offer = await offered(f)
  expect(offer.descriptor.turn).toEqual({ nativeMessageId: 'input-message', nativeRequestId: 'control-request' })
  expect(f.row.pending_interaction).toEqual(offer.descriptor)
  await f.claim()
  await f.interactionPort.respond(session, identity.nativeRequestId, offer.descriptor.responseOptions[0]!)
  expect(await offer.pending).toEqual({ behavior: 'allow', updatedInput: { path: 'scope-owned' } })
  const observed = await f.interactionPort.reconcileResponse(session, { nativeRequestId: identity.nativeRequestId, option: offer.descriptor.responseOptions[0]! })
  expect(observed.responseDeliveries).toEqual([]); expect(observed.interactionDeliveries).toEqual([{ nativeRequestId: identity.nativeRequestId, state: 'submitted', selectedOptionId: 'allow_once' }])
  await expect(f.interactionPort.respond(session, identity.nativeRequestId, offer.descriptor.responseOptions[0]!)).rejects.toThrow()
})
it('retains compact consumed decisions without granting a second callback or resending a response', async () => {
  const f = fixture(), offer = await offered(f)
  await f.claim()
  await f.interactionPort.respond(session, identity.nativeRequestId, offer.descriptor.responseOptions[0]!)
  await offer.pending
  expect(await f.interactionPort.pending(session)).toBeUndefined()
  expect(f.bridge.inspectCallbackAvailability({ ...identity, nativeRequestType: identity.nativeRequestType })).toMatchObject({
    state: 'unavailable', reason: 'request_consumed',
  })
  expect(await f.bridge.canUseTool(identity, 'Read', { path: 'scope-owned' }, new AbortController().signal)).toMatchObject({ behavior: 'deny' })
  await expect(f.bridge.canUseTool(identity, 'Read', { path: 'changed' }, new AbortController().signal)).rejects.toThrow('different input')
  await f.bridge.observeToolResult(identity, 'Read', 'executed')
  const observation = await f.interactionPort.reconcileResponse(session, { nativeRequestId: identity.nativeRequestId,
    option: offer.descriptor.responseOptions[0]! })
  expect(observation.responseDeliveries).toMatchObject([{ nativeIdentity: {
    kind: 'message', nativeMessageId: identity.nativeMessageId, generation: identity.generation,
  }, optionId: 'allow_once' }])
  await expect(f.interactionPort.respond(session, identity.nativeRequestId, offer.descriptor.responseOptions[0]!)).rejects.toThrow()
})

it('admits later permission callbacks while retaining replay protection for earlier callbacks', async () => {
  const f = fixture()
  for (let index = 0; index < 300; index += 1) {
    const callback = { ...identity, toolUseId: `tool-${index}`, nativeRequestId: `permission-${index}` }
    const decision = f.bridge.canUseTool(callback, 'Read', { path: 'owned' }, new AbortController().signal)
    await f.waitForPending()
    expect(f.row.pending_interaction).toMatchObject({ turn: { nativeRequestId: callback.nativeRequestId } })
    const pending = (await f.interactionPort.pending(session))!
    await f.claim('allow_once', identity.generation, callback)
    await f.interactionPort.respond(session, callback.nativeRequestId, pending.responseOptions[0]!)
    expect(await decision).toMatchObject({ behavior: 'allow' })
  }
  const extra = { ...identity, toolUseId: 'overflow-tool', nativeRequestId: 'overflow-permission' }
  const next = f.bridge.canUseTool(extra, 'Read', { path: 'owned' }, new AbortController().signal)
  await f.waitForPending()
  expect(f.row.pending_interaction).toMatchObject({ turn: { nativeRequestId: extra.nativeRequestId } })
  const pending = (await f.interactionPort.pending(session))!
  await f.claim('allow_once', identity.generation, extra)
  await f.interactionPort.respond(session, extra.nativeRequestId, pending.responseOptions[0]!)
  expect(await next).toMatchObject({ behavior: 'allow' })
  const first = { ...identity, toolUseId: 'tool-0', nativeRequestId: 'permission-0' }
  expect(await f.bridge.canUseTool(first, 'Read', { path: 'owned' }, new AbortController().signal)).toMatchObject({ behavior: 'deny' })
}, 30_000)

it('does not resolve the SDK permission without an existing exact response receipt/claim', async () => {
  const f = fixture(), offer = await offered(f)
  await expect(f.interactionPort.respond(session, identity.nativeRequestId, offer.descriptor.responseOptions[0]!)).rejects.toThrow('no longer matches')
  expect(f.bridge.inspectCallbackAvailability({ ...identity, nativeRequestId: identity.nativeRequestId, nativeRequestType: identity.nativeRequestType })).toMatchObject({ state: 'available' })
  expect(f.bridge.inspectCallbackAvailability({ ...identity, expectedNativeMessageId: identity.nativeMessageId,
    expectedGeneration: identity.generation })).toMatchObject({ state: 'available', nativeMessageId: identity.nativeMessageId, generation: identity.generation })
  expect(f.bridge.inspectCallbackAvailability({ ...identity, expectedNativeMessageId: 'older-message' })).toMatchObject({ state: 'unavailable', reason: 'identity_mismatch' })
  expect(f.bridge.inspectCallbackAvailability({ ...identity, expectedGeneration: 'older-generation' })).toMatchObject({ state: 'unavailable', reason: 'identity_mismatch' })

  f.bridge.close(); expect((await offer.pending).behavior).toBe('deny')
})
it('denies an admitted sender with revoked or removed write grants and never issues Operator credentials to Agent chat', async () => {
  const f = fixture('agent'); f.principals.get('sender')!.grants = []
  await expect(f.callbackAdmission()).rejects.toThrow('not authorized')
  expect(f.query.mock.calls.every(([text]) => !text.includes('insert into management_principals'))).toBe(true)
})
it('rejects wrong owner, stale actual message and expired response-generation reservation', async () => {
  const f = fixture()
  await expect(f.authority.validate({ ...identity, ownerPrincipalId: 'uploader' })).rejects.toThrow('no longer matches')
  f.row.payload.nativeSubmission.nativeMessageId = 'different-message'
  await expect(f.authority.validate(identity)).rejects.toThrow('no longer matches')
  f.row.payload.nativeSubmission.nativeMessageId = identity.nativeMessageId
  const offer = await offered(f); await f.claim('allow_once', 'old-process-generation')
  await expect(f.interactionPort.respond(session, identity.nativeRequestId, offer.descriptor.responseOptions[0]!)).rejects.toThrow('no longer matches')
  f.bridge.close(); await offer.pending
})
it('revalidates the actual responder grants after current receipt lookup', async () => {
  const f = fixture(), offer = await offered(f); await f.claim()
  f.principals.get('responder')!.grants = []
  await expect(f.interactionPort.respond(session, identity.nativeRequestId, offer.descriptor.responseOptions[0]!)).rejects.toThrow('not authorized')
  f.bridge.close(); await offer.pending
})
it('structured questions are denied explicitly rather than bypassing the existing answer contract', async () => {
  const f = fixture()
  const answer = await f.bridge.canUseTool(identity, 'AskUserQuestion', { questions: [{ question: 'Choose', header: 'Choice', multiSelect: true, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] }, new AbortController().signal)
  expect(answer).toMatchObject({ behavior: 'deny', message: expect.stringContaining('current persisted response contract') })
  expect(f.row.pending_interaction).toBeNull()
})
it('notifies the actual owned observer after map insertion with distinct control and message identities', async () => {
  const f = fixture(), wake = vi.fn()
  const remove = f.bridge.subscribePending(wake)
  const offer = await offered(f)
  expect(wake).toHaveBeenCalledExactlyOnceWith({ nativeSessionId: identity.nativeSessionId, nativeMessageId: identity.nativeMessageId,
    clientCorrelationId: identity.clientCorrelationId, generation: identity.generation, nativeRequestId: identity.nativeRequestId, nativeRequestType: identity.nativeRequestType })
  expect(f.query.mock.calls.every(([sql]) => !sql.includes('insert into durable_interactions'))).toBe(true)
  remove(); f.bridge.close(); await offer.pending
})

it('workflow response uses original-source readback plus active delivery lease after the old drive owner is released', async () => {
  const { AgentConfigurationVersionSchema, HarnessExecutionSchema, DurableInteractionSchema } = await import('@foreman-code/contracts')
  const { WorkflowRunV3Schema, WorkflowVersionV3Schema } = await import('@foreman-code/contracts/wave25')
  const createdAt = '2026-10-01T00:00:00.000Z'
  const approval = { handler: 'user' as const }
  const cfg = AgentConfigurationVersionSchema.parse({ id: 'cfg', workspaceId: 'ws', agentId: 'agent', version: 1, productRole: 'coder', harness: configuration, prompt: {}, assignedSkills: [], contentHash: `sha256:${'0'.repeat(64)}`, createdAt })
  const version = WorkflowVersionV3Schema.parse({ id: 'version', workspaceId: 'ws', workflowId: 'wf', version: 1, executionSemanticsVersion: 3, entryNodeId: 'node', approval,
    agentConfigurationVersionIds: { agent: cfg.id }, contentHash: `sha256:${'0'.repeat(64)}`, createdAt,
    definition: { id: 'wf', workspaceId: 'ws', name: 'Synthetic domain fixture', version: 1, executionSemanticsVersion: 3, entryNodeId: 'node', approval, executionCondition: { kind: 'manual' }, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 }, nodes: [{ id: 'node', agentId: 'agent', name: 'Fixture' }], edges: [] } })
  const run = WorkflowRunV3Schema.parse({ id: 'run', workspaceId: 'ws', workflowId: 'wf', workflowVersionId: version.id, executionSemanticsVersion: 3, agentConfigurationVersionIds: version.agentConfigurationVersionIds, approval, executionCondition: { kind: 'manual' }, executionState: 'waiting', outcome: 'pending', input: {}, createdAt })
  const execution = HarnessExecutionSchema.parse({ id: 'exec', runId: run.id, workflowNodeId: 'node', agentId: 'agent', agentConfigurationVersionId: cfg.id, attempt: 2, nativeSessionId: session.nativeSessionId, state: 'waiting', input: {}, createdAt })
  const persisted: { interaction?: unknown } = {}; let claimed = false
  const callbacks = claudeCallbackDatabase()
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const callbackResult = callbacks(sql, values)
    if (callbackResult) return callbackResult
    const rows = sql.includes('e.record as execution') ? [{ run, version, execution, configuration: cfg, attempt: 2, stopped: false, execution_closed: false, native_reference: session, finalized: false, generation: '1', native_owner: 'agent', budget_active: true }]
      : sql.includes("record->>'authorizationPrincipalId'") ? [{ principal_id: 'sender' }]
      : sql.includes('from management_principals where id=') ? [{ id: 'sender', name: 'Synthetic sender', audience: 'operator', grants: [{ actions: ['runs:start'], scope: {} }], expires_at: new Date('2099-01-01'), revoked_at: null, delegated_from: null }]
      : sql.includes('from durable_interactions d') ? persisted.interaction ? [{ record: persisted.interaction, claimed }] : [] : (() => { throw new Error('Unexpected workflow SQL ' + sql.slice(0, 100)) })()
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
  })
  const database = { query } as unknown as pg.Pool
  let owner: import('../src/modules/runs/ownership.js').RunOwnership | undefined = { runId: 'run', client: database, assertOwned() {}, readOneShotFence: async () => ({ ownerId: 'modeled-session', fence: 'modeled-fence' }) } as unknown as import('../src/modules/runs/ownership.js').RunOwnership
  const callback = { ...identity, attemptId: '2', clientCorrelationId: 'execution:exec' }
  const port = createPostgresClaudeInteractionBridge({ database, configuration, binding: { kind: 'workflow', runId: 'run', executionId: 'exec', attempt: 2, getOwner: () => owner }, manager: { nativeCallbackContext: () => ({ nativeSessionId: callback.nativeSessionId, nativeMessageId: callback.nativeMessageId, clientCorrelationId: callback.clientCorrelationId, generation: callback.generation }) } })
  expect(await port.callbackAdmission()).toEqual({ ownerPrincipalId: 'sender', attemptId: '2' })
  const callbackPromise = port.bridge.canUseTool(callback, 'Read', { path: 'owned-root' }, new AbortController().signal)
  await vi.waitFor(() => expect(port.bridge.pendingInteractions(session)).toHaveLength(1))
  const pending = port.bridge.pendingInteractions(session)[0]!
  expect(query.mock.calls.every(([sql]) => !sql.includes('insert into'))).toBe(true)
  owner = undefined // Waiting graph releases its old advisory owner; real SDK callback remains resident.
  await expect(port.interactionPort.respond(session, callback.nativeRequestId, pending.responseOptions[0]!)).rejects.toThrow('no longer matches')
  // Modeled persisted output of EXISTING owned observer/assertNativeUpdateLocked/createRequestLocked and response CAS.
  persisted.interaction = DurableInteractionSchema.parse({ id: 'interaction', revision: 1, workspaceId: 'ws', workflowId: 'wf', runId: 'run', executionId: 'exec', requestingAgentId: 'agent', harness: 'claude', providerVersion: session.providerVersion, nativeSessionId: session.nativeSessionId, nativeRequestId: callback.nativeRequestId, nativeRequestType: callback.nativeRequestType, graphThreadId: 'run', request: pending.request, approval, responseOptions: pending.responseOptions, status: 'delivery_pending', selectedOptionId: 'allow_once', selectedSemantic: 'approve_once', nativeResponse: {}, deliveryState: 'pending', decidedAt: createdAt, createdAt, updatedAt: createdAt })
  await expect(port.interactionPort.respond(session, callback.nativeRequestId, pending.responseOptions[0]!)).rejects.toThrow('no longer matches')
  claimed = true
  await port.interactionPort.respond(session, callback.nativeRequestId, pending.responseOptions[0]!)
  expect((await callbackPromise).behavior).toBe('allow')
  expect((await port.interactionPort.reconcileResponse(session, { nativeRequestId: callback.nativeRequestId, option: pending.responseOptions[0]! })).responseDeliveries).toEqual([])
})

it.each(['operator', 'agent'] as const)('authorizes idle %s profile controls without admitting tool callbacks', async kind => {
  const f = fixture(kind)
  f.row.active_request_id = null
  const binding = kind === 'operator' ? { kind, conversationId: 'conversation', controlPrincipalId: 'sender',
    repository: new PostgresOperatorConversationRepository({ query: f.query } as unknown as pg.Pool) }
    : { kind, conversationId: 'conversation', workspaceId: 'workspace', controlPrincipalId: 'sender',
      repository: new PostgresAgentChatRepository({ query: f.query } as unknown as pg.Pool) }
  const authority = new PostgresClaudeInteractionAuthority({ query: f.query } as unknown as pg.Pool, binding, f.manager)
  await expect(authority.profileAdmission()).resolves.toBeUndefined()
  await expect(authority.callbackAdmissionIfActive()).resolves.toBeUndefined()
  await expect(authority.callbackAdmission()).rejects.toMatchObject({ code: 'CLAUDE_CALLBACK_SCOPE_DENIED' })
  f.principals.get('sender')!.grants[0]!.actions = [kind === 'operator' ? 'operator_chat:read' : 'agent_chat:read']
  await expect(authority.profileAdmission()).rejects.toMatchObject({ status: 403 })
})

for (const kind of ['operator', 'agent'] as const) it(`admits ${kind} profile observation with current read grants`, async () => {
  const f = fixture(kind)
  f.row.active_request_id = null
  f.principals.get('sender')!.grants[0]!.actions = [kind === 'operator' ? 'operator_chat:read' : 'agent_chat:read']
  const binding = kind === 'operator'
    ? { kind, conversationId: 'conversation', observationPrincipalId: 'sender', repository: new PostgresOperatorConversationRepository({ query: f.query } as unknown as pg.Pool) }
    : { kind, conversationId: 'conversation', workspaceId: 'workspace', observationPrincipalId: 'sender', repository: new PostgresAgentChatRepository({ query: f.query } as unknown as pg.Pool) }
  const authority = new PostgresClaudeInteractionAuthority({ query: f.query } as unknown as pg.Pool, binding, f.manager)
  await expect(authority.profileAdmission()).resolves.toBeUndefined()
  await expect(authority.callbackAdmission()).rejects.toMatchObject({ code: 'CLAUDE_CALLBACK_SCOPE_DENIED' })
  f.row.active_request_id = 'model-request'
  f.row.cancel_requested = true
  await expect(authority.profileAdmission()).resolves.toBeUndefined()
  await expect(authority.callbackAdmission()).rejects.toMatchObject({ code: 'CLAUDE_CALLBACK_SCOPE_DENIED' })
  f.principals.get('sender')!.grants = []
  await expect(authority.profileAdmission()).rejects.toMatchObject({ status: 403 })
})
