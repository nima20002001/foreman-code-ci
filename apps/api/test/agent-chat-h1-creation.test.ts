import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, it } from 'vitest'
import type { AgentConfigurationVersion, ExecutionResult } from '@foreman-code/contracts'
import type { SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import { AgentChatService, type AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import type { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { CodexRpcError } from '../src/modules/harnesses/codexStdioTransport.js'
import { HarnessExecutionError, NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import type { NativeSessionStart } from '../src/modules/harnesses/port.js'
import type { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { context, F1Native, F1Store } from './helpers/agentChatF1.js'
import { deferred } from './helpers/deferred.js'

async function eventually(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 3_000
  while (!await check()) {
    assert.ok(Date.now() < end, 'The H1 lifecycle transition did not occur.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Real service/repository, scripted SQL and a fake native manager. NOT a PostgreSQL/native test. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-chat-h1-'))
  const store = new F1Store()
  store.row.native_session_id = null; store.row.provider_version = null
  delete store.row.record.startupDelivered
  store.row.record.workingDirectory = root; store.row.record.runtimeDirectory = root
  const configuration: AgentConfigurationVersion = {
    id: store.row.agent_configuration_version_id, workspaceId: context.workspaceId, agentId: context.agentId, version: 1,
    prompt: {}, assignedSkills: [], contentHash: 'fixture', createdAt: new Date().toISOString(),
    harness: { harness: 'codex', model: 'fixture', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' },
  }
  const principal: ManagementPrincipal = {
    id: 'caller', name: 'H1 unit caller', audience: 'operator', revokedAt: null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    grants: [{ scope: { workspaceIds: [context.workspaceId], workflowIds: [context.workflowId] },
      actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel'] }],
  }
  let connections = 0
  let bindingError: Error | undefined
  const sql = async (text: string, values: unknown[] = [], connection = 0) => {
    const normalized = text.replace(/\s+/g, ' ').trim()
    const result = (rowCount: number) => ({ rows: [], rowCount })
    const record = () => store.statements.push({ sql: normalized, values: structuredClone(values), connection })
    if (normalized.startsWith('update operator_conversations set record=record -')) {
      record()
      assert.match(normalized, /active_request_id=\$2 and native_session_id is null/)
      assert.match(normalized, /record->'sessionCreation'->>'requestId'=\$2/)
      if (store.row.active_request_id !== values[1] || store.row.native_session_id
        || store.row.record.sessionCreation?.requestId !== values[1]) return result(0)
      delete store.row.record.sessionCreation
      delete store.row.record.nativeNonSubmission
      return result(1)
    }
    if (normalized.includes("jsonb_build_object('sessionCreation'")) {
      record()
      assert.match(normalized, /active_request_id=\$2 and native_session_id is null/)
      assert.match(normalized, /not \(record \? 'sessionCreation'\)/)
      if (store.row.active_request_id !== values[1] || store.row.native_session_id || store.row.record.sessionCreation) return result(0)
      store.row.record.sessionCreation = { requestId: String(values[1]) }; store.row.revision = Number(store.row.revision) + 1
      return result(1)
    }
    if (normalized.startsWith('update operator_conversations set provider_version=')) {
      record()
      if (bindingError) throw bindingError
      assert.ok(!store.row.native_session_id || store.row.native_session_id === values[2])
      store.row.provider_version = String(values[1]); store.row.native_session_id = String(values[2])
      store.row.revision = Number(store.row.revision) + 1
      return result(1)
    }
    if (normalized.includes("jsonb_build_object('sessionUnavailable'")) {
      record(); store.row.record.sessionUnavailable = String(values[1])
      store.row.record.sessionUnavailableReason = values[2] as 'native_session_missing' | 'harness_unavailable'
      return result(1)
    }
    // The established F1 script remains strict for every other SQL statement.
    return store['query'](text, values, connection)
  }
  const pool = {
    query: (text: string, values?: unknown[]) => sql(text, values),
    connect: async () => {
      const connection = ++connections
      return { query: (text: string, values?: unknown[]) => sql(text, values, connection), release() {} }
    },
  } as unknown as pg.Pool
  const repository = new PostgresAgentChatRepository(pool)
  let creationError: Error | undefined = new NativeDeliveryError('session_creation', 'not_sent',
    new CodexRpcError('thread/start', 1, false, 'CODEX_APP_SERVER_REQUEST_FAILED'))
  let disposeError: Error | undefined
  let creates = 0
  const creationInputs: NativeSessionStart[] = []
  const disposeGate = deferred(); disposeGate.resolve()
  let disposal = disposeGate
  const owners = new Map<string, Native>()
  const natives: Native[] = []
  class Native extends F1Native {
    override readonly harness = 'codex' as const
    disposed = 0
    override async createSession(input?: NativeSessionStart) {
      assert.ok(input); creationInputs.push(structuredClone(input)); creates++
      assert.equal(input.environment, undefined)
      if (creationError) throw creationError
      return this.session
    }
    async dispose() {
      this.disposed++
      await disposal.promise
      if (disposeError) throw disposeError
    }
  }
  const managers: AgentChatManagerFactory = (id) => {
    let native = owners.get(id)
    if (!native) { native = new Native(); owners.set(id, native); natives.push(native) }
    return native
  }
  managers.release = (id) => { owners.delete(id) }
  const workflows = {
    getAgentConfiguration: async () => configuration,
    getCurrentSavedVersion: async () => ({ definition: { nodes: [{ id: context.workflowNodeId, agentId: context.agentId }] } }),
    getSavedVersion: async () => { throw new Error('No Run-origin selection in this fixture.') },
  } as unknown as Pick<PostgresWorkflowRepository, 'getAgentConfiguration' | 'getCurrentSavedVersion' | 'getSavedVersion'>
  const services: AgentChatService[] = []
  const makeService = () => {
    const service = new AgentChatService(pool, repository, {} as PostgresOperatorConversationRepository, workflows,
      { getForWorkspace: () => { throw new Error('No Run access.') }, getExecution: async () => { throw new Error('This fixture must not read a Run execution.') }, executionPages: () => { throw new Error('No execution access.') } }, managers, root)
    services.push(service); return service
  }
  const service = makeService()
  const request = (requestId: string): SendAgentChatMessageRequest => ({ requestId, content: requestId, intent: 'next_turn',
    expectedConversationId: store.row.id, context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId } })
  return { service, repository, store, principal, request, natives, owners, creationInputs, makeService,
    get creates() { return creates },
    set creationError(error: Error | undefined) { creationError = error },
    set bindingError(error: Error | undefined) { bindingError = error },
    set disposeError(error: Error | undefined) { disposeError = error },
    holdDisposal() { disposal = deferred(); return disposal },
    send: (id: string) => service.send(principal, context.workspaceId, request(id)),
    read: () => service.readConversation(principal, context.workspaceId, store.row.id),
    async dispose() {
      disposal.resolve(); disposeError = undefined
      try { for (const item of services) await item.shutdown() } finally { await rm(root, { recursive: true, force: true }) }
    },
  }
}

describe('H1/A3-PF-01 creation rejection and marker retirement (scripted SQL)', () => {
  it('retires proven unsent native admission failures and permits explicit retry', async () => {
    const f = await fixture()
    f.creationError = new NativeDeliveryError('session_creation', 'not_sent', new Error('Admission failed.'))
    try {
      await f.send('first')
      await eventually(() => f.store.turns.get('first')?.delivery === 'failed')
      assert.equal(f.store.row.record.sessionCreation, undefined)
      assert.equal((await f.read()).availability.canSend, true)
      await f.send('retry')
      await eventually(() => f.store.turns.get('retry')?.delivery === 'failed')
      assert.equal(f.creates, 2)
      assert.equal(f.store.row.record.sessionCreation, undefined)
      assert.deepEqual(f.natives.flatMap((native) => native.starts), [])
    } finally { await f.dispose() }
  })
  for (const preflight of [false, true]) {
    it(`${preflight ? 'proven model-catalog preflight failure' : 'definite thread/start rejection'} stays retryable, and exact replay never resends`, async () => {
      const f = await fixture()
      if (preflight) f.creationError = new NativeDeliveryError('session_creation', 'not_sent',
        new HarnessExecutionError('CODEX_MODEL_CATALOG_UNAVAILABLE', 'The model catalogue is unavailable.'))
      try {
        await f.send('first')
        await eventually(() => f.store.turns.get('first')?.delivery === 'failed')
        const state = await f.read()
        assert.equal(state.sessionState, 'error'); assert.equal(state.availability.canSend, true)
        assert.equal(state.activeTurn, null); assert.equal(state.conversation?.nativeSession, null)
        assert.equal(f.store.row.record.sessionCreation, undefined)
        assert.equal(f.store.row.record.sessionUnavailable, undefined)
        assert.equal(f.owners.size, 0)
        assert.equal(f.creates, 1); assert.deepEqual(f.natives.flatMap((native) => native.starts), [])
        const receipt = await f.repository.turn(f.store.row.id, 'first')
        assert.ok(receipt?.error)
        const replay = await f.send('first')
        assert.equal(replay.replayed, true); assert.deepEqual(replay.turn, receipt); assert.equal(f.creates, 1)
        // Cold explicit retry still uses the same app conversation, not another selection/session fallback.
        await f.service.shutdown()
        const restarted = f.makeService()
        f.creationError = undefined
        const coldReplay = await restarted.send(f.principal, context.workspaceId, f.request('first'))
        assert.equal(coldReplay.replayed, true); assert.deepEqual(coldReplay.turn, receipt); assert.equal(f.creates, 1)
        await restarted.send(f.principal, context.workspaceId, f.request('retry'))
        await eventually(() => f.store.turns.get('retry')?.delivery === 'completed')
        assert.equal(f.creates, 2); assert.equal(f.natives.length, 2)
        assert.deepEqual(f.natives.flatMap((native) => native.starts), ['retry'])
        assert.equal(f.store.row.native_session_id, 'session')
        assert.equal((await f.repository.get(f.store.row.id))?.record.sessionCreation?.requestId, 'retry')
        assert.equal(f.store.messages.size, 2)
        assert.ok(f.creationInputs.every((input) => input.environment === undefined && input.kind !== 'operator' && input.instructionsDelivered === false))
        assert.equal((await f.repository.turn(f.store.row.id, 'first'))?.delivery, 'failed')
      } finally { await f.dispose() }
    })
  }

  for (const stop of [false, true]) {
    it(`negative creation evidence survives shutdown${stop ? ' and a committed Stop' : ''}, after disposal is proven`, async () => {
      const f = await fixture(), gate = f.holdDisposal()
      try {
        await f.send('first')
        await eventually(() => f.natives[0]?.disposed === 1)
        assert.equal(f.store.row.record.sessionCreation?.requestId, 'first')
        assert.equal(f.store.turns.get('first')?.delivery, 'submitting')
        if (stop) assert.equal(await f.repository.requestCancel(f.store.row.id, 'first'), true)
        const closing = f.service.shutdown()
        gate.resolve(); await closing
        assert.equal(f.store.turns.get('first')?.delivery, stop ? 'canceled' : 'failed')
        assert.equal(f.store.row.active_request_id, null)
        assert.equal(f.store.row.record.sessionCreation, undefined)
        assert.equal(f.store.row.record.sessionUnavailable, undefined)
        assert.equal(f.creates, 1)
      } finally { await f.dispose() }
    })
  }

  for (const scenario of ['lost-ack', 'cleanup', 'binding', 'later-rpc', 'contradictory-certainty'] as const) {
    it(`${scenario} retains the original fence and never creates a replacement`, async () => {
      const f = await fixture()
      if (scenario === 'lost-ack') f.creationError = new CodexRpcError('thread/start', 1, true, 'CODEX_APP_SERVER_REQUEST_FAILED')
      if (scenario === 'cleanup') f.disposeError = new Error('Process closure is unconfirmed.')
      if (scenario === 'binding') {
        f.creationError = undefined
        // Even a definite-shaped binding error is NOT a definite native creation failure.
        f.bindingError = new CodexRpcError('thread/start', 1, false, 'CODEX_APP_SERVER_REQUEST_FAILED')
      }
      if (scenario === 'later-rpc') f.creationError = new CodexRpcError('mcpServerStatus/list', 2, false, 'CODEX_APP_SERVER_REQUEST_FAILED')
      if (scenario === 'contradictory-certainty') f.creationError = new CodexRpcError('thread/start', 1, true, 'CODEX_MODEL_CATALOG_UNAVAILABLE')
      try {
        await f.send('first')
        await eventually(() => f.store.turns.get('first')?.delivery === 'unknown')
        const state = await f.read()
        assert.equal(state.sessionState, 'unavailable'); assert.equal(state.availability.canSend, false)
        assert.equal(f.store.row.record.sessionCreation?.requestId, 'first')
        assert.equal(f.store.row.record.sessionUnavailable, undefined)
        assert.equal((await f.send('first')).replayed, true)
        await assert.rejects(f.send('retry'), { code: 'AGENT_CHAT_UNAVAILABLE' })
        assert.equal(f.creates, 1)
        assert.deepEqual(f.natives.flatMap((native) => native.starts), [])
        assert.equal(f.store.statements.some(({ sql }) => sql.startsWith('update operator_conversations set record=record -')), false)
      } finally { await f.dispose() }
    })
  }

  for (const fence of ['owner', 'marker', 'native-session', 'native-turn', 'unavailable', 'success'] as const) {
    it(`the retirement transaction refuses a mismatched ${fence}`, async () => {
      const f = await fixture()
      try {
        const request = f.request('first')
        await f.repository.admit({ key: f.store.row.agent_key, request, context, delivery: 'queued' })
        assert.equal(await f.repository.claim(f.store.row.id, 'first'), true)
        assert.equal(await f.repository.beginSessionCreation(f.store.row.id, 'first'), true)
        if (fence === 'owner') f.store.row.active_request_id = 'later'
        if (fence === 'marker') f.store.row.record.sessionCreation = { requestId: 'later' }
        if (fence === 'native-session') f.store.row.native_session_id = 'session'
        if (fence === 'native-turn') f.store.row.active_native_turn_id = 'turn'
        if (fence === 'unavailable') f.store.row.record.sessionUnavailable = 'Preserve this fence.'
        const before = structuredClone({ row: f.store.row, turns: f.store.turns })
        f.store.statements.length = 0
        const result: ExecutionResult = fence === 'success' ? { outcome: 'succeeded' }
          : { outcome: 'failed', error: { code: 'FIXTURE', message: 'Rejected.', retryable: true } }
        assert.equal(await f.repository.finish(f.store.row.id, 'first', result, undefined, true), false)
        assert.deepEqual({ row: f.store.row, turns: f.store.turns }, before)
        assert.deepEqual(f.store.statements.filter(({ sql }) => /^(insert|update|delete)\b/.test(sql)), [])
      } finally { await f.dispose() }
    })
  }
})
