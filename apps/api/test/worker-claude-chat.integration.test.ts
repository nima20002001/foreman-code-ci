import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, SessionControlStateSchema, SessionPreferencesSchema,
  type AgentConfigurationVersion } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService, type AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import { agentChatCorrelation, agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { workerClaudeReplacementFixture } from '../src/modules/conversations/workerClaudeReplacement.test-support.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { readSystemPromptSetting } from '../src/modules/settings/foundation.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { deferred } from './helpers/deferred.js'

it('preserves remote Claude cold recovery, ownership and non-delivery through authenticated Operator MCP', async () => {
  const db = await agent3Database()
  const recorded = workerConversationFixture('agent', 'claude')
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  fixture.configurations = fixture.configurations.map(value => AgentConfigurationVersionSchema.parse({ ...value,
    harness: recorded.configuration.harness, harnessProfileSelection: recorded.binding.profile }))
  let worker: Awaited<ReturnType<typeof workerClaudeReplacementFixture>> | undefined
  let chat: AgentChatService | undefined
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const seeded = await seedAgent3(db.pool, db.directory, fixture, { run: false })
    const node = seeded.version.definition.nodes[0]!
    const access = new PostgresAccessService(db.pool)
    const writer = await access.issue({ name: 'remote Claude writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: {} }] })
    const reader = await access.issue({ name: 'remote Claude reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agent_chat:read'], scope: {} }] })
    const ungranted = await access.issue({ name: 'other workspace reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: ['other'] } }] })
    const repository = new PostgresAgentChatRepository(db.pool)
    const messages = new PostgresOperatorConversationRepository(db.pool)
    const context = { workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId,
      workflowNodeId: node.id, agentId: node.agentId }
    const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
    const conversation = await repository.ensureForControls(agentChatKey(context), { context,
      agentConfigurationVersionId: configuration.id, harness: 'claude', origin: { kind: 'fresh' },
      workingDirectory: db.directory, runtimeDirectory: join(db.directory, 'remote-chat') }, async () => {})
    worker = await workerClaudeReplacementFixture({ ...recorded, configuration,
      binding: { ...recorded.binding, workingDirectory: db.directory,
        systemPrompt: await readSystemPromptSetting(db.pool), owner: { kind: 'agent',
        conversationId: conversation.id, workspaceId: configuration.workspaceId,
        workflowId: seeded.scope.workflowId, workflowNodeId: node.id, agentId: configuration.agentId,
        configurationVersionId: configuration.id, configurationHash: commandInputHash(configuration) } } })
    const createChat = () => new AgentChatService(db.pool, repository, messages, new PostgresWorkflowRepository(db.pool), {
      getForWorkspace: async () => { throw new Error('Chat must not select a Run.') },
      getExecution: async () => { throw new Error('This fixture must not read a Run execution.') }, executionPages() { throw new Error('Chat must not select a Run execution.') },
    }, Object.assign((id: string, selected: AgentConfigurationVersion, cwd: string) => {
      expect(id).toBe(conversation.id)
      expect(selected).toEqual(configuration)
      expect(cwd).toBe(db.directory)
      return worker!.createManager()
    }, {
      // A Worker-hosted admission requires the exact prepared Worker input. The recorded
      // Worker manager prepares the same frame it later verifies before offering it.
      prepareInput: async ({ row, request, prompt, settings, configuration: accepted, workingDirectory }:
        Parameters<NonNullable<AgentChatManagerFactory['prepareInput']>>[0]) => {
        if (!row) throw new Error('Worker preparation requires the reserved conversation.')
        const correlationId = agentChatCorrelation(row.id, request.requestId)
        const input = { prompt, clientCorrelationId: correlationId, sessionMode: settings.sessionMode,
          sessionPreferences: settings.sessionPreferences }
        return worker!.manager.prepareInput(row.native_session_id && row.provider_version
          ? { kind: 'turn', session: { harness: row.harness, nativeSessionId: row.native_session_id,
            providerVersion: row.provider_version }, input }
          // Preparation only builds the frame; the provider identity callback belongs to the later offer.
          : { kind: 'initial', input: { ...input, onSessionObserved: async () => {} }, start: { kind: 'agent-chat', conversationId: row.id, workflowId: row.workflow_id,
            workflowNodeId: row.workflow_node_id, configuration: accepted, workingDirectory, correlationId,
            instructionsDelivered: false, ...(row.record.systemPrompt ? { systemPrompt: row.record.systemPrompt } : {}) } })
      },
    }), db.directory)
    chat = createChat()
    const createApp = () => buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: chat, commands: new PostgresCommandCoordinator(db.pool) } as never } })
    app = createApp()
    const query = { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId }
    const call = (token: string, name: string, args: Record<string, unknown>) => graphRpc(app!, token, 'tools/call', {
      name, arguments: { workspaceId: seeded.scope.workspaceId, ...args },
    })
    const id = conversation.id
    const send = async (request: { requestId: string }, delivery: 'completed' | 'failed' = 'completed') => {
      const terminal = deferred()
      // Subscribe before admission so a fast turn cannot finish before the listener is installed.
      const unsubscribe = chat!.events.subscribe(id, event => {
        if (event.data.requestId === request.requestId
          && ['completed', 'failed', 'canceled'].includes(String(event.data.delivery))) terminal.resolve()
      })
      try {
        const result = await call(writer.token, 'agent_chat_send', { request })
        expect(result.result?.isError, JSON.stringify(result)).not.toBe(true)
        await terminal.promise
        expect((await repository.turn(id, request.requestId))?.delivery).toBe(delivery)
        return result
      } finally { unsubscribe() }
    }
    const first = { requestId: 'remote-initial', content: 'Initial task', intent: 'next_turn',
      expectedConversationId: conversation.id, context: query }
    const denied = await call(reader.token, 'agent_chat_send', { request: first })
    expect(denied.error || denied.result?.isError).toBeTruthy()
    expect(worker.offers).toHaveLength(0)
    const started = await send(first)
    expect(graphRpcValue(started.result)).toMatchObject({ state: { conversation: { id } } })
    const nativeId = (await repository.get(id))!.native_session_id
    await chat.shutdown()
    await app.close()
    const originalTurn = await repository.turn(id, first.requestId)
    const originalWorker = (await worker.journal.conversations.read(worker.binding))!
    await worker.coldRestart()
    expect(worker.launches).toHaveLength(1)
    expect(worker.launches[0]).toMatchObject({ lifecycle: 'closed', closureEvidence: 'native_exit_removed_cgroup' })
    expect(worker.offers).toHaveLength(1)
    chat = createChat()
    app = createApp()
    const deniedRead = await call(ungranted.token, 'agent_chat_read', { query })
    expect(deniedRead.error || deniedRead.result?.isError).toBeTruthy()
    const resumedRead = await call(reader.token, 'agent_chat_read', { query })
    expect(resumedRead.result?.isError).not.toBe(true)
    expect(graphRpcValue(resumedRead.result)).toMatchObject({
      conversation: { id, nativeSession: { nativeSessionId: nativeId } },
    })
    expect(worker.offers).toHaveLength(1)
    const next = { ...first, requestId: 'remote-after-cold-restart', expectedConversationId: id }
    await send(next)
    expect(worker.recoveries).toEqual([{ inputsBefore: 1, inputsAfter: 1 }])
    expect(worker.offers).toHaveLength(2)
    const recoveredWorker = (await worker.journal.conversations.read(worker.binding))!
    expect(recoveredWorker.session).toEqual(originalWorker.session)
    expect(recoveredWorker.turns[0]).toEqual(originalWorker.turns[0])
    expect(await repository.turn(id, first.requestId)).toEqual(originalTurn)
    expect((await repository.get(id))!.native_session_id).toBe(nativeId)
    const previous = (await worker!.journal.conversations.read(worker!.binding))!.nativeOwner
    const controls = await call(writer.token, 'agent_chat_controls_get', { conversationId: id })
    const state = SessionControlStateSchema.parse(graphRpcValue(controls.result))
    const request = { requestId: 'remote-preferences', expectedRevision: state.revision, kind: 'preferences',
      preferences: SessionPreferencesSchema.parse({ autoCompact: 'off' }) }
    const deniedSettings = await call(reader.token, 'agent_chat_controls_update', { conversationId: id, request })
    expect(deniedSettings.error || deniedSettings.result?.isError).toBeTruthy()
    const applied = await call(writer.token, 'agent_chat_controls_update', { conversationId: id, request })
    expect(applied.result?.isError).not.toBe(true)
    expect(SessionControlStateSchema.parse(graphRpcValue(applied.result)).desired.autoCompact).toBe('off')
    const afterPreferences = { ...first, requestId: 'remote-after-preferences', expectedConversationId: id }
    await send(afterPreferences)
    expect((await worker!.journal.conversations.read(worker!.binding))!.nativeOwner).not.toEqual(previous)
    worker!.failMode()
    const failedInput = { ...first, requestId: 'remote-unoffered', expectedConversationId: id, sessionMode: 'plan' }
    let failedPublished = false
    const unsubscribeFailure = chat.events.subscribe(id, event => {
      if (event.data.requestId === failedInput.requestId && event.data.delivery === 'failed') failedPublished = true
    })
    worker.holdClosure()
    const failing = send(failedInput, 'failed')
    try {
      await vi.waitFor(() => expect(worker!.hasClosureWaiter()).toBe(true))
      expect(failedPublished).toBe(false)
    } finally {
      worker.releaseClosure()
      await failing
      unsubscribeFailure()
    }
    expect((await repository.turn(id, failedInput.requestId))?.nativeSubmission).toBeUndefined()
    expect((await repository.get(id))?.active_request_id).toBeNull()
    expect(worker!.offers).toHaveLength(3)
    const retry = { ...first, requestId: 'remote-later', expectedConversationId: id }
    await send(retry)
    const read = await call(writer.token, 'agent_chat_read', { query })
    expect(read.result?.isError).not.toBe(true)
    expect(graphRpcValue(read.result)).toMatchObject({ conversation: { id, nativeSession: { nativeSessionId: nativeId } } })
    const readControls = await call(writer.token, 'agent_chat_controls_get', { conversationId: id })
    expect(SessionControlStateSchema.parse(graphRpcValue(readControls.result)).applied?.autoCompact).toBe('off')
    await call(writer.token, 'agent_chat_send', { request: failedInput })
    expect(worker!.offers).toHaveLength(4)
  } catch (error) {
    console.error('ORIGINAL_FAILURE', error)
    throw error
  } finally {
    try { await chat?.shutdown() }
    finally {
      try { await worker?.close() }
      finally { try { await app?.close() } finally { await db.close() } }
    }
  }
}, 120_000)
