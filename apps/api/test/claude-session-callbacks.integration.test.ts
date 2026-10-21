import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, type NativeHarnessEvent, type NativeSessionReference } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresAgentChatRepository, agentChatCorrelation, agentChatKey } from '../src/modules/conversations/agentChatRepository.js'
import type { NativeSessionStart } from '../src/modules/harnesses/port.js'
import { createPostgresClaudeInteractionBridge } from '../src/modules/harnesses/claudeSdk/domainAuthority.js'
import { claudeNativeEvent } from '../src/modules/harnesses/claudeSdk/nativeEvents.js'
import { createClaudeEventNormalizer } from '../src/modules/harnesses/claudeSdk/normalization.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from '../src/modules/harnesses/claudeSdk/port.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import { createClaudeSdkRunner } from '../src/modules/harnesses/claudeSdk/runner.js'
import { createClaudeSdkCallbacks } from '../src/modules/harnesses/claudeSdk/sdkCallbacks.js'
import {
  createClaudeNativeSessionManager, type ClaudeMessageTurnInput, type ClaudeNativeSessionManager,
} from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'

async function drain(events: AsyncIterable<NativeHarnessEvent>) {
  const values: NativeHarnessEvent[] = []
  for await (const event of events) values.push(event)
  return values
}

it('persists one message admission across later tool rounds and validates each callback against the real domain', async () => {
  const db = await agent3Database()
  let manager: ClaudeNativeSessionManager | undefined
  try {
    const access = new PostgresAccessService(db.pool)
    const writer = await access.issue({ name: 'Session callback writer', audience: 'operator',
      grants: [{ actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:respond'], scope: {} }],
      expiresAt: new Date(Date.now() + 600_000) })
    const reader = await access.issue({ name: 'Session callback reader', audience: 'operator',
      grants: [{ actions: ['agent_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const harness: ClaudeHarnessConfiguration = {
      harness: 'claude', model: 'fixture', authMode: 'subscription', configDirectory: db.directory,
      permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Read'], permissionRules: [],
      instructions: '', mcpServers: {},
    }
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
    fixture.configurations = fixture.configurations.map(configuration =>
      AgentConfigurationVersionSchema.parse({ ...configuration, harness }))
    const seeded = await seedAgent3(db.pool, db.directory, fixture, { run: false })
    const node = seeded.version.definition.nodes[0]!
    const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
    const context = { workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId,
      workflowNodeId: node.id, agentId: node.agentId }
    const repository = new PostgresAgentChatRepository(db.pool)
    const oldId = randomUUID()
    const admit = (requestId: string, expectedConversationId: string | null) => repository.admit({
      key: agentChatKey(context), context, ownerPrincipalId: writer.principal.id, delivery: 'queued',
      request: { requestId, content: 'Read the files', intent: 'next_turn', expectedConversationId,
        context: { workflowId: context.workflowId, workflowNodeId: node.id, agentId: node.agentId } },
      create: { context, agentConfigurationVersionId: configuration.id, harness: 'claude',
        origin: { kind: 'fresh' }, workingDirectory: db.directory, runtimeDirectory: db.directory },
    })
    const conversation = { id: (await admit(oldId, null)).conversationId }
    const session: NativeSessionReference = { harness: 'claude', providerVersion: '2.1.284', nativeSessionId: randomUUID() }
    const frames = new ClaudeBoundedQueue<unknown>(32)
    let messages!: AsyncIterator<ClaudeSdkUserMessage>
    const query = vi.fn<ClaudeSdkClient['query']>(input => {
      messages = input.prompt[Symbol.asyncIterator]()
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
        initializationResult: async () => ({}), interrupt: async () => undefined, close: () => frames.close() }
    })
    const transcript: unknown[] = []
    const sdk: ClaudeSdkClient = {
      sdkVersion: '0.3.284', query, getSessionInfo: async sessionId => ({ sessionId }),
      getSessionMessages: async (_sessionId, page) => transcript.slice(page.offset, (page.offset ?? 0) + (page.limit ?? 256)), forkSession: async () => ({ sessionId: 'unused' }),
    }
    const domain = createPostgresClaudeInteractionBridge({ database: db.pool, configuration: harness,
      binding: { kind: 'agent', conversationId: conversation.id, workspaceId: context.workspaceId, repository },
      manager: { nativeCallbackContext: (nativeSessionId, toolUseId) =>
        manager!.nativeCallbackContext(nativeSessionId, toolUseId) } })
    const callbacks = createClaudeSdkCallbacks({ manager: () => manager!, bridge: domain.bridge })
    manager = createClaudeNativeSessionManager({ runner: createClaudeSdkRunner({ loadClient: async () => sdk }),
      scope: { deviceId: 'main', profilePath: db.directory, configRevision: configuration.id, cwd: db.directory },
      sdkOptions: callbacks, qualification: { sdkVersion: sdk.sdkVersion, cliVersion: session.providerVersion,
        basicTurns: true, resume: true, fork: false, history: true, interactions: true },
      interactionPort: domain.interactionPort, liveCallbacks: domain.bridge,
      cancelPendingRequests: () => domain.bridge.cancelPendingRequests(),
      pendingInteractions: value => domain.bridge.pendingInteractions(value),
      decodeFactory() {
        const normalizer = createClaudeEventNormalizer({
          owner: { ownerId: conversation.id, attemptId: 'conversation', generation: 'fixture' },
          observedAt: () => new Date().toISOString(),
        })
        return raw => normalizer.ingest(raw).map(event => claudeNativeEvent(event, 0))
      },
    })
    const start: NativeSessionStart = { kind: 'workflow', correlationId: 'attach', request: {
      executionId: `agent-chat:${conversation.id}`, runId: `agent-chat:${conversation.id}`,
      workspaceId: context.workspaceId, workflowNodeId: node.id, configuration, input: {},
      workingDirectory: db.directory, runtimeDirectory: db.directory,
    } }
    await manager.attachSession(session, start)
    await repository.bindSession(conversation.id, session.providerVersion, session.nativeSessionId)
    const begin = async (requestId: string) => {
      if (requestId !== oldId) await admit(requestId, conversation.id)
      expect(await repository.claim(conversation.id, requestId)).toBe(true)
      const admission = await domain.callbackAdmission()
      const input: ClaudeMessageTurnInput = { prompt: 'Read the files',
        clientCorrelationId: agentChatCorrelation(conversation.id, requestId), callbackAuthority: admission,
        onMessageSubmitted: async receipt => {
          expect(await repository.acceptedMessage(conversation.id, requestId, receipt)).toBe(true)
        } }
      const output = drain(manager!.startTurn(session, input))
      const message = (await messages.next()).value!
      transcript.push({ ...message, session_id: session.nativeSessionId })
      return { output, message }
    }
    const assistant = (id: string, content: unknown[], promptUuid?: string) => {
      const frame = {
      type: 'assistant', session_id: session.nativeSessionId, parent_tool_use_id: null, uuid: randomUUID(),
      message: { id, content }, ...(promptUuid ? { user_message_uuid: promptUuid } : {}),
      }
      if (id !== 'older' || promptUuid) transcript.push(frame)
      return frames.offer(frame)
    }
    const result = (promptUuid: string) => frames.offer({ type: 'result', session_id: session.nativeSessionId,
      uuid: `result-${promptUuid}`, user_message_uuid: promptUuid, subtype: 'success', is_error: false, result: 'done' })

    const old = await begin(oldId)
    void assistant('older', [{ type: 'text', text: 'older response' }], old.message.uuid)
    void result(old.message.uuid)
    await old.output
    expect(await repository.finish(conversation.id, oldId, { outcome: 'succeeded', output: 'done' })).toBe(true)

    const requestId = randomUUID()
    const current = await begin(requestId)
    for (const [index, messageId] of ['A1', 'A2'].entries()) {
      const toolUseID = `tool-${index}`
      const request = `control-${index}`
      const signal = new AbortController().signal
      const decision = callbacks.canUseTool!('Read', { file_path: `${db.directory}/file` }, {
        signal, toolUseID, requestId: request,
      })
      void assistant(messageId, [{ type: 'tool_use', id: toolUseID, name: 'Read', input: {} }],
        index === 0 ? current.message.uuid : undefined)
      await vi.waitFor(async () => {
        expect((await repository.get(conversation.id))?.pending_interaction?.turn.nativeRequestId).toBe(request)
      })
      const callbackContext = manager.nativeCallbackContext(session.nativeSessionId, toolUseID)!
      expect(callbackContext.nativeMessageId).toBe(current.message.uuid)
      const identity = { ...callbackContext, ownerPrincipalId: writer.principal.id, attemptId: requestId,
        toolUseId: toolUseID, nativeRequestId: request, nativeRequestType: 'can_use_tool' as const }
      await expect(domain.authority.validate({ ...identity, ownerPrincipalId: reader.principal.id }))
        .rejects.toThrow('no longer matches')
      await domain.authority.validate(identity)
      const option = domain.bridge.pendingInteractions(session)[0]!.responseOptions
        .find(value => value.semantic === 'approve_once')!
      const control = { schemaVersion: 1, kind: 'respond', modelRequestId: requestId, conversationId: conversation.id,
        scope: { kind: 'agent_chat', conversationId: conversation.id,
          workspaceId: context.workspaceId, workflowId: context.workflowId },
        native: { harness: 'claude', providerVersion: session.providerVersion, sessionId: session.nativeSessionId,
          messageId: current.message.uuid, generation: callbackContext.generation, requestId: request, requestType: 'can_use_tool' },
        choice: { optionId: option.optionId, semantic: option.semantic } }
      await db.pool.query(`insert into management_command_receipts
        (principal_id,operation,command_id,target_key,input_hash,result) values ($1,'agent_chat_control',$2,$3,$4,$5::jsonb)`,
      [writer.principal.id, randomUUID(), conversation.id, `claim-${index}`,
        JSON.stringify({ status: 'pending', acceptedControl: control })])
      await manager.respond(session, request, option)
      expect(await decision).toMatchObject({ behavior: 'allow' })
      if (index === 0) {
      void frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'unseen-old',
        message: { id: 'unseen-old', content: [{ type: 'text', text: 'unowned delayed text' },
          { type: 'tool_use', id: 'unowned-tool', name: 'Read', input: {} }] } })
      }
      void frames.offer({ type: 'user', session_id: session.nativeSessionId, uuid: `tool-result-${index}`,
        message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, content: 'file' }] } })
      if (index === 0) void frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'wake',
        subtype: 'success', is_error: false, result: 'unrelated wake' })
      if (index === 0) void assistant('older', [{ type: 'text', text: 'late older response' }])
    }
    void assistant('A3', [{ type: 'text', text: 'final response' }])
    void result(current.message.uuid)
    const output = await current.output
    expect(output.some(event => ['late older response', 'unowned delayed text'].includes(String(event.payload.text)))).toBe(false)
    expect(manager.nativeCallbackContext(session.nativeSessionId, 'unowned-tool')).toBeUndefined()
    expect(output.find(event => event.payload.text === 'final response')?.payload.clientCorrelationId)
      .toBe(agentChatCorrelation(conversation.id, requestId))
    expect((await repository.turn(conversation.id, requestId))?.nativeSubmission?.nativeMessageId).toBe(current.message.uuid)
    expect((await manager.reconcile(session, agentChatCorrelation(conversation.id, requestId))).terminalResult)
      .toEqual({ outcome: 'succeeded', output: 'done' })
    expect(query).toHaveBeenCalledTimes(1)
  } finally {
    try { await manager?.dispose?.() }
    finally { await db.close() }
  }
}, 60_000)
