import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HARNESS_DEFAULTS,
  type AgentConfigurationVersion,
  type NativeSessionReference,
  type OperatorConfigurationVersion,
  type PromptSettingSnapshot,
} from '@foreman-code/contracts'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentConversation, PostgresAgentChatRepository,
  type NewAgentConversation } from '../src/modules/conversations/agentChatRepository.js'
import { OperatorChatService, type OperatorChatAuthority } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import type { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../src/modules/harnesses/port.js'
import type { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { context, F1Native, F1Store, eventually } from './helpers/agentChatF1.js'
import { memoryConversation, operator, ReviewManager } from './fixtures/agent1OperatorChat.js'

const snapshot = (text: string, revision = 1): PromptSettingSnapshot => ({
  value: { text }, revision, versionId: `prompt-${revision}`,
})
const configuration: OperatorConfigurationVersion = {
  id: 'operator-config', operatorId: 'application-operator', version: 1,
  harness: DEFAULT_HARNESS_DEFAULTS.codex, contentHash: 'sha256:fixture',
  createdAt: new Date().toISOString(),
}

function conversationStore() {
  let setting = snapshot('Started prompt')
  const rows = new Map<string, Record<string, unknown>>()
  const turns = new Map<string, Record<string, unknown>>()
  const query = async (sql: string, values: unknown[] = []) => {
    sql = sql.replace(/\s+/g, ' ').trim()
    if (sql.startsWith('select record, revision, current_version_id')) {
      return { rows: [{ record: setting.value, revision: setting.revision, current_version_id: setting.versionId }], rowCount: 1 }
    }
    if (sql.startsWith('insert into operator_conversations')) {
      const isAgent = sql.includes("'agent'")
      const record = JSON.parse(String(values[isAgent ? 10 : 5])) as Record<string, unknown>
      const id = String(values[0])
      if (!rows.has(id)) rows.set(id, {
        id, record, owner_principal_id: values[4], harness: isAgent ? values[9] : values[3],
        agent_key: values[1], workspace_id: values[2], workflow_id: values[3], workflow_node_id: values[4],
        agent_id: values[5], agent_configuration_version_id: values[6],
        origin_run_id: values[7], origin_execution_id: values[8],
        provider_version: null, native_session_id: null, updated_at: new Date(), created_at: new Date(),
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('select * from operator_conversations')) {
      const found = sql.includes('agent_key=$1')
        ? [...rows.values()].find(row => row.agent_key === values[0]) : rows.get(String(values[0]))
      return { rows: found ? [structuredClone(found)] : [], rowCount: found ? 1 : 0 }
    }
    if (sql.startsWith("select c.record->>'workingDirectory' as path,")) {
      const found = rows.get(String(values[0]))
      const record = found?.record as Record<string, unknown> | undefined
      const directories = record ? [{ path: record.workingDirectory, host_kind: 'main' }] : []
      return { rows: directories, rowCount: directories.length }
    }
    if (sql.startsWith('select count(*)::text as count from operator_conversation_turns')) {
      return { rows: [{ count: '0' }], rowCount: 1 }
    }
    if (sql.startsWith('select') && sql.includes('from operator_conversation_turns')) {
      const found = turns.get(`${values[0]}:${values[1]}`)
      return { rows: found ? [structuredClone(found)] : [], rowCount: found ? 1 : 0 }
    }
    if (sql.startsWith('insert into operator_conversation_turns')) {
      const row = { request_id: values[1], payload: JSON.parse(String(values[2])), input_hash: values[3],
        intent: values[4], delivery: values[5], message_id: values[6], target_native_turn_id: values[7],
        native_turn_id: null, turn_sequence: String(turns.size + 1), created_at: new Date(), updated_at: new Date() }
      turns.set(`${values[0]}:${values[1]}`, row)
      return { rows: [structuredClone(row)], rowCount: 1 }
    }
    if (sql.startsWith('update operator_conversations set record=record ||')) {
      const row = rows.get(String(values[0]))!
      row.record = { ...row.record as Record<string, unknown>, systemPrompt: JSON.parse(String(values[1])) }
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('select record from conversation_session_controls')) return { rows: [], rowCount: 0 }
    if (sql.startsWith('insert into operator_conversation_messages')
      || sql.startsWith('update operator_conversations set revision=')) return { rows: [], rowCount: 1 }
    if (['begin', 'commit', 'rollback'].includes(sql) || sql.startsWith('select pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql === 'select archived_at from workspaces where id = $1 for share') {
      return { rows: [{ archived_at: null }], rowCount: 1 }
    }
    throw new Error('Unexpected conversation persistence operation')
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  return { pool, rows, change: (next: PromptSettingSnapshot) => { setting = next } }
}

describe('conversation prompt snapshots', () => {
  it('pins the latest prompt on first send after a controls-created conversation, and retains it for later sends', async () => {
    const store = conversationStore()
    const repository = new PostgresAgentChatRepository(store.pool)
    const create: NewAgentConversation = {
      context, agentConfigurationVersionId: 'agent-config', harness: 'codex', origin: { kind: 'fresh' },
      workingDirectory: process.cwd(), runtimeDirectory: '/runtime',
    }
    const first = await repository.ensureForControls('first', create, async () => {})
    expect(agentConversation(first).systemPrompt).toBeUndefined()
    store.change(snapshot('Updated prompt', 2))
    const send = (requestId: string) => repository.admit({ key: 'first', context, delivery: 'queued', request: {
      requestId, content: 'User request', intent: 'next_turn', expectedConversationId: first.id,
      context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId },
    } })
    await send('first-request')
    expect(agentConversation((await repository.get(first.id))!).systemPrompt).toEqual(snapshot('Updated prompt', 2))
    store.change(snapshot('Later prompt', 3))
    await send('second-request')
    expect(agentConversation((await repository.get(first.id))!).systemPrompt).toEqual(snapshot('Updated prompt', 2))
  })

  it('retains the source prompt revision for Run forks including historical sessions with no snapshot', async () => {
    const store = conversationStore()
    const repository = new PostgresAgentChatRepository(store.pool)
    const create: NewAgentConversation = {
      context, agentConfigurationVersionId: 'agent-config', harness: 'codex', origin: { kind: 'fresh' },
      workingDirectory: process.cwd(), runtimeDirectory: '/runtime',
    }
    store.change(snapshot('Updated prompt', 2))
    const origin = { kind: 'run_execution' as const, runId: 'run', executionId: 'execution', sourceNativeSessionId: 'source' }
    const fork = await repository.ensureForControls('fork', { ...create, origin, systemPrompt: snapshot('Started prompt') }, async () => {})
    expect(agentConversation(fork).systemPrompt).toEqual(snapshot('Started prompt'))
    const historical = await repository.ensureForControls('historical', { ...create, origin }, async () => {})
    expect(agentConversation(historical).systemPrompt).toBeUndefined()
  })

  it('persists the Operator own prompt independently for each fresh conversation', async () => {
    const store = conversationStore()
    const repository = new PostgresOperatorConversationRepository(store.pool)
    const first = await repository.create(configuration.operatorId, configuration, 'owner', undefined, 'first')
    expect(first.initialPrompt).toEqual(snapshot('Started prompt'))
    store.change(snapshot('Updated prompt', 2))
    const second = await repository.create(configuration.operatorId, configuration, 'owner', undefined, 'second')
    expect(second.initialPrompt).toEqual(snapshot('Updated prompt', 2))
    expect((await repository.create(configuration.operatorId, configuration, 'owner', undefined, 'first')).initialPrompt)
      .toEqual(snapshot('Started prompt'))
  })

  it('passes the stored Agent revision when a chat attaches after an API restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chat-prompt-'))
    const store = new F1Store()
    store.row.record.workingDirectory = root
    store.row.record.systemPrompt = snapshot('Original app instructions', 4)
    const starts: NativeSessionStart[] = []
    class Native extends F1Native {
      override async attachSession(_session?: NativeSessionReference, start?: NativeSessionStart) {
        if (start) starts.push(structuredClone(start))
        return this.session
      }
    }
    const native = new Native()
    const agentConfiguration: AgentConfigurationVersion = {
      id: store.row.agent_configuration_version_id, agentId: context.agentId, workspaceId: context.workspaceId,
      version: 1, harness: DEFAULT_HARNESS_DEFAULTS.codex,
      prompt: {}, assignedSkills: [], contentHash: 'sha256:fixture', createdAt: new Date().toISOString(),
    }
    const workflows = {
      getAgentConfiguration: async () => agentConfiguration,
      getCurrentSavedVersion: async () => ({ definition: { nodes: [{ id: context.workflowNodeId, agentId: context.agentId }] } }),
    } as unknown as Pick<PostgresWorkflowRepository, 'getAgentConfiguration' | 'getCurrentSavedVersion' | 'getSavedVersion'>
    const service = new AgentChatService(store.pool, new PostgresAgentChatRepository(store.pool),
      {} as PostgresOperatorConversationRepository, workflows,
      { getForWorkspace: async () => undefined, getExecution: async () => undefined, async *executionPages() {} }, () => native, root)
    const caller = { ...operator('caller'), grants: [{ scope: {}, actions: ['agent_chat:read' as const, 'agent_chat:write' as const] }] }
    try {
      await service.send(caller, context.workspaceId, {
        requestId: 'first', content: 'User request', intent: 'next_turn', expectedConversationId: store.row.id,
        context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId },
      })
      await vi.waitFor(() => expect(store.row.active_request_id).toBeNull())
      expect(starts).toHaveLength(1)
      expect(starts[0]).toMatchObject({ kind: 'agent-chat', instructionsDelivered: true,
        systemPrompt: snapshot('Original app instructions', 4) })
      expect((await service.readConversation(caller, context.workspaceId, store.row.id)).conversation?.systemPrompt)
        .toEqual(snapshot('Original app instructions', 4))
      expect(native.prompts).toEqual(['User request'])
    } finally {
      await service.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Operator initial prompt delivery', () => {
  it('sends the pinned own prompt before the first message and omits it after restart', async () => {
    const memory = memoryConversation(configuration)
    memory.row.record = { ...memory.state().conversation, initialPrompt: snapshot('Own startup instructions', 3) }
    const caller = operator()
    let submitted = false
    const repository = memory.repository
    repository.hasNativeSubmission = async () => submitted
    const submit = repository.submitted.bind(repository)
    repository.submitted = async (...args) => {
      const accepted = await submit(...args)
      if (accepted) submitted = true
      return accepted
    }
    const prompts: string[] = []
    const starts: NativeSessionStart[] = []
    class Native extends ReviewManager {
      override async createSession(start?: NativeSessionStart) {
        if (start) starts.push(structuredClone(start))
        return this.session
      }
      override async *startTurn(session: NativeSessionReference, input: NativeTurnInput) {
        prompts.push(input.prompt)
        yield* super.startTurn(session, input)
        this.nativeHistory.terminalResult = { outcome: 'succeeded' }
      }
    }
    const native = new Native()
    const authority: OperatorChatAuthority = {
      current: async () => caller, assertConfiguration() {},
      setup: async () => ({ harness: 'codex', status: 'configured', endpoint: 'http://127.0.0.1/mcp', checkedAt: new Date().toISOString() }),
      prepare: async () => ({ agentId: configuration.operatorId, variables: {} }), release: async () => {},
    }
    const services: OperatorChatService[] = []
    const makeService = () => {
      const service = new OperatorChatService(repository, {} as PostgresOperatorRepository, () => native, '/tmp/operator', authority)
      services.push(service)
      return service
    }
    const first = makeService()
    try {
      await first.send(memory.row.id, { requestId: 'first', content: 'First request' }, caller)
      await eventually(() => memory.finishResults.length === 1)
      await first.shutdown()
      const resumed = makeService()
      await resumed.send(memory.row.id, { requestId: 'second', content: 'Second request' }, caller)
      await eventually(() => memory.finishResults.length === 2)
      expect(prompts).toEqual(['Own startup instructions\n\nCurrent user message:\nFirst request', 'Second request'])
      expect(starts).toHaveLength(1)
      expect(starts[0]).toMatchObject({ kind: 'operator' })
      expect(starts[0]).not.toHaveProperty('systemPrompt')
      expect((await resumed.get(memory.row.id, caller)).conversation.initialPrompt).toEqual(snapshot('Own startup instructions', 3))
    } finally {
      for (const service of services) await service.shutdown()
    }
  })

  it('includes the pinned prompt in Claude first-input admission and keeps Operator free of the app prompt', async () => {
    const claudeConfiguration: OperatorConfigurationVersion = { ...configuration, harness: {
      harness: 'claude', model: 'fixture-model', effort: 'medium', authMode: 'subscription',
      configDirectory: '/fixture/profile', permissionMode: 'default', sandbox: 'danger-full-access',
      tools: [], permissionRules: [], instructions: '', mcpServers: {},
    } }
    const memory = memoryConversation(claudeConfiguration)
    memory.row.record = { ...memory.state().conversation, initialPrompt: snapshot('Claude own prompt', 6) }
    memory.repository.hasNativeSubmission = async () => false
    memory.repository.submittedMessage = async () => true
    const commands = memory.repository.createControlCommands()
    commands.reconcileStoredResponses = async () => {}
    memory.repository.createControlCommands = () => commands
    const session: NativeSessionReference = { harness: 'claude', providerVersion: 'fixture', nativeSessionId: 'claude-session' }
    const caller = operator()
    const prompts: string[] = []
    const starts: NativeSessionStart[] = []
    const base = new ReviewManager()
    let history: NativeHistory = { events: [], pendingInteractions: [] }
    const native: NativeHarnessSessionManager = {
      harness: 'claude',
      capabilities: base.capabilities.bind(base), inspectMcp: base.inspectMcp.bind(base),
      createSession: async () => { throw new Error('Claude must admit its first input with the session') },
      attachSession: async reference => reference,
      async *startInitialTurn(start, input) {
        starts.push(structuredClone(start))
        prompts.push(input.prompt)
        await input.onSessionObserved(session)
        const receipt = { kind: 'message' as const, nativeSessionId: session.nativeSessionId,
          nativeMessageId: 'first-message', clientCorrelationId: input.clientCorrelationId }
        await input.onMessageSubmitted?.(receipt)
        history = { events: [], pendingInteractions: [], correlationId: input.clientCorrelationId,
          nativeSubmission: receipt, terminalResult: { outcome: 'succeeded' },
          terminalTurn: { correlationId: input.clientCorrelationId, providerId: receipt.nativeMessageId,
            result: { outcome: 'succeeded' } } }
        yield* []
      },
      async *startTurn() { throw new Error('First input was already admitted'); yield* [] },
      pending: async () => undefined, respond: async () => {}, cancel: async () => false,
      history: async () => history,
      reconcile: async () => history, close: async () => {}, dispose: async () => {},
    }
    const authority: OperatorChatAuthority = {
      current: async () => caller, assertConfiguration() {},
      setup: async () => ({ harness: 'claude', status: 'configured', endpoint: 'http://127.0.0.1/mcp', checkedAt: new Date().toISOString() }),
      prepare: async () => ({ agentId: configuration.operatorId, variables: {} }), release: async () => {},
    }
    const service = new OperatorChatService(memory.repository, {} as PostgresOperatorRepository,
      () => native, '/tmp/operator', authority)
    try {
      await service.send(memory.row.id, { requestId: 'claude-first', content: 'First Claude request' }, caller)
      await eventually(() => memory.finishResults.length === 1)
      expect(prompts).toEqual(['Claude own prompt\n\nCurrent user message:\nFirst Claude request'])
      expect(starts).toHaveLength(1)
      expect(starts[0]).not.toHaveProperty('systemPrompt')
      expect(memory.state().conversation.initialPrompt).toEqual(snapshot('Claude own prompt', 6))
    } finally { await service.shutdown() }
  })
})
