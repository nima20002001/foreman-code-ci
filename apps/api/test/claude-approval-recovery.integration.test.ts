import type pg from 'pg'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import type { OperatorConfigurationVersion, NativeSessionReference, OperatorConversationState } from '@foreman-code/contracts'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { buildApp } from '../src/app.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { OperatorChatService, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChat.js'
import { allocateClaudeNativeHarness } from '../src/modules/harnesses/claudeSdk/composition.js'
import { createPostgresClaudeInteractionBridge } from '../src/modules/harnesses/claudeSdk/domainAuthority.js'
import { createClaudeSdkCallbacks } from '../src/modules/harnesses/claudeSdk/sdkCallbacks.js'
import { createClaudeSdkRunner } from '../src/modules/harnesses/claudeSdk/runner.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import type { ClaudeNativeSessionManager } from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from '../src/modules/harnesses/claudeSdk/port.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import { rejectableDeferred } from './helpers/deferred.js'

/** Native transport frames are doubled; runner, normalizer, manager, callback authority, caller and PostgreSQL are real. */
function runtime(pool: pg.Pool, repository: PostgresOperatorConversationRepository, configuration: OperatorConfigurationVersion,
  conversationId: string, directory: string, nativeHistory: unknown[], offers: string[]) {
  const domain = createPostgresClaudeInteractionBridge({ database: pool, configuration: configuration.harness as ClaudeHarnessConfiguration,
    binding: { kind: 'operator', conversationId, repository },
    manager: { nativeCallbackContext: (sessionId, toolId) => manager.nativeCallbackContext(sessionId, toolId) } })
  const frames = new ClaudeBoundedQueue<unknown>(64)
  const ready = rejectableDeferred<AsyncIterator<ClaudeSdkUserMessage>>()
  let options!: Options
  const client: ClaudeSdkClient = {
    sdkVersion: '0.3.284',
    query(input) {
      options = input.options as Options
      ready.resolve(input.prompt[Symbol.asyncIterator]())
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close: () => frames.close(),
        interrupt: async () => undefined, initializationResult: async () => ({}) }
    },
    getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => nativeHistory,
    forkSession: async () => { throw new Error('Approval recovery cannot fork a native session.') },
  }
  const runner = createClaudeSdkRunner({ loadClient: async () => client })
  const open = runner.open.bind(runner)
  runner.open = async input => {
    const session = await open(input)
    const offer = session.offer.bind(session)
    session.offer = (message, signal) => { offers.push(message.promptUuid); return offer(message, signal) }
    return session
  }
  const manager: ClaudeNativeSessionManager = allocateClaudeNativeHarness({ harness: 'claude', role: 'operator', ownerAgentId: conversationId,
    workingDirectory: directory, appMcpAccess: 'none', scope: { deviceId: 'test-host', profilePath: '/test-profile', configRevision: '1', cwd: directory },
    runner, sdkOptions: createClaudeSdkCallbacks({ manager: () => manager, bridge: domain.bridge }),
    qualification: { sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true, resume: true, fork: false, history: true, interactions: true },
    interactionPort: domain.interactionPort, liveCallbacks: domain.bridge, cancelPendingRequests: () => domain.bridge.close(),
    pendingInteractions: session => domain.bridge.pendingInteractions(session),
    responseDeliveries: session => domain.bridge.deliveryEvidence(session),
    ownerForStart: () => ({ ownerId: conversationId, attemptId: 'model-request', generation: 'test-owner' }),
  }).manager
  domain.bridge.subscribePending(notification => manager.notifyPendingChanged(notification))
  const initial = manager.startInitialTurn.bind(manager)
  manager.startInitialTurn = async function* (start, message, signal) {
    yield* initial(start, { ...message, callbackAuthority: await domain.callbackAdmission() }, signal)
  }
  const reconcile = manager.reconcile.bind(manager)
  manager.reconcile = async (session, correlationId, signal) => ({ ...await reconcile(session, correlationId, signal),
    responseDeliveries: await domain.bridge.deliveryEvidence(session) })
  return { manager, ready, frames, options: () => options }
}

it.each(['aborted', 'resident-write-loss', 'resident-stream-after-recovery', 'restart-without-proof', 'restart-with-stored-proof', 'restart-wrong-generation',
  'terminal-after-response', 'restart-after-terminal', 'concurrent-poll', 'concurrent-poll-write-loss'] as const)(
  'recovers %s Claude approval through authenticated MCP with no response or prompt replay', async scenario => {
    await nim2691TaskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const access = new PostgresAccessService(pool)
      const owner = await access.issue({ name: 'approval owner', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:respond'], scope: {} }] })
      const denied = await access.issue({ name: 'approval reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['operator_chat:read'], scope: {} }] })
      const settings = new PostgresFoundationSettingsRepository(pool)
      const defaults = await settings.getAgentDefaults()
      const harness: ClaudeHarnessConfiguration = { harness: 'claude', model: 'transport-fixture', authMode: 'subscription',
        configDirectory: '/test-profile', permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Read'],
        permissionRules: [{ tool: 'Read', effect: 'ask' }], instructions: '', mcpServers: {} }
      await settings.updateAgentDefaults({ ...defaults.value, operator: { ...defaults.value.operator, harness } }, defaults.revision)
      const repository = new PostgresOperatorConversationRepository(pool)
      const nativeHistory: unknown[] = []
      const offers: string[] = []
      const runtimes: ReturnType<typeof runtime>[] = []
      const resolver = (configuration: OperatorConfigurationVersion, id: string) => {
        const owned = runtime(pool, repository, configuration, id, directory, nativeHistory, offers)
        runtimes.push(owned)
        return owned.manager
      }
      const closeRecoveredRuntime = vi.fn(async () => true)
      const accountBindingReady = rejectableDeferred<void>()
      const createChat = () => new OperatorChatService(repository, new PostgresOperatorRepository(pool),
        Object.assign(resolver, { closeRecoveredRuntime,
          prepareAccountBinding: async () => {
            if (scenario === 'restart-after-terminal') await accountBindingReady.promise
          },
        }), directory, { current: id => access.currentOperator(id), assertConfiguration() {},
        setup: async () => ({ harness: 'claude', status: 'configured', endpoint: 'http://127.0.0.1/mcp', checkedAt: new Date().toISOString() }),
        prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }), release: async () => {} })
      let chat = createChat()
      const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { operatorChat: { get: (...args: Parameters<OperatorChatService['get']>) => chat.get(...args),
          respond: (...args: Parameters<OperatorChatService['respond']>) => chat.respond(...args) },
        commands: new PostgresCommandCoordinator(pool) } as never } })
      const controller = new AbortController()
      const session: NativeSessionReference = { harness: 'claude', nativeSessionId: 'approval-session', providerVersion: '2.1.284' }
      let responses = 0
      try {
        const conversation = await chat.create(owner.principal)
        const id = conversation.id
        await chat.send(id, { requestId: 'model-request', content: 'Read an admitted file' }, owner.principal)
        if (scenario === 'restart-after-terminal') {
          const starting = await graphRpc(app, owner.token, 'tools/call', {
            name: 'operator_chat_get', arguments: { conversationId: id },
          })
          expect(starting.result?.isError).not.toBe(true)
          expect(graphRpcValue(starting.result)).toMatchObject({ activeRequestId: 'model-request' })
          expect(offers).toEqual([])
          accountBindingReady.resolve()
        }
        await vi.waitFor(() => expect(runtimes).toHaveLength(1), { timeout: 20_000, interval: 50 })
        const owned = runtimes[0]!
        const message = (await (await owned.ready.promise).next()).value!
        nativeHistory.push({ type: 'user', uuid: message.uuid, session_id: session.nativeSessionId,
          parent_tool_use_id: null, message: { role: 'user', content: 'Read an admitted file' } })
        void owned.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId, claude_code_version: session.providerVersion, cwd: directory })
        void owned.frames.offer({ type: 'assistant', uuid: 'tool-reply', session_id: session.nativeSessionId, user_message_uuid: message.uuid,
          parent_tool_use_id: null, message: { id: 'tool-message', content: [{ type: 'tool_use', id: 'read-tool', name: 'Read', input: { file_path: '/test-file' } }] } })
        const hook = { session_id: session.nativeSessionId, transcript_path: '/test-transcript', cwd: directory,
          tool_use_id: 'read-tool', tool_name: 'Read', tool_input: { file_path: '/test-file' } }
        const callbacks = owned.options()
        await callbacks.hooks!.PreToolUse![0]!.hooks[0]!({ ...hook, hook_event_name: 'PreToolUse' }, 'read-tool', { signal: controller.signal })
        const permission = callbacks.canUseTool!('Read', hook.tool_input, {
          toolUseID: 'read-tool', requestId: 'permission-request', signal: controller.signal,
        }).then(decision => { responses++; return decision })
        await vi.waitFor(async () => expect((await repository.get(id))?.pendingInteraction).toBeDefined(),
          { timeout: 20_000, interval: 50 })
        const admitted = await graphRpc(app, owner.token, 'tools/call', {
          name: 'operator_chat_get', arguments: { conversationId: id },
        })
        expect(admitted.result?.isError).not.toBe(true)
        expect(graphRpcValue(admitted.result)).toMatchObject({ activeRequestId: 'model-request',
          nativeSubmission: { kind: 'message', nativeSessionId: session.nativeSessionId,
            nativeMessageId: message.uuid, clientCorrelationId: `operator:${id}:model-request` } })
        const input = { commandId: 'response-command', requestId: 'model-request', nativeRequestId: 'permission-request', optionId: 'allow_once' }
        const deniedResponse = await graphRpc(app, denied.token, 'tools/call', { name: 'operator_chat_respond', arguments: { conversationId: id, request: input } })
        expect(deniedResponse.error || deniedResponse.result?.isError).toBeTruthy()
        expect((await pool.query('select count(*)::int as n from management_command_receipts')).rows[0].n).toBe(0)
        const query = pool.query.bind(pool)
        const concurrentPoll = scenario.startsWith('concurrent-poll')
        const journalEntered = rejectableDeferred<void>()
        const finishJournal = rejectableDeferred<void>()
        let validations = 0
        const spy = vi.spyOn(pool, 'query').mockImplementation(((...args: unknown[]) => {
          const statement = String(args[0])
          if (scenario === 'aborted' && statement.includes('select principal_id,result from management_command_receipts') && ++validations === 2) {
            controller.abort(new Error('SDK callback canceled after selection'))
          }
          if (concurrentPoll && statement.startsWith('update management_command_receipts set result=$4::jsonb')) {
            journalEntered.resolve()
            return finishJournal.promise.then(() => {
              if (scenario === 'concurrent-poll-write-loss') throw new Error('Original acknowledgment write interrupted')
              return (query as (...values: unknown[]) => unknown)(...args)
            })
          }
          if (scenario !== 'aborted' && !concurrentPoll && statement.includes('with settled as')) {
            return Promise.reject(new Error('Control outcome write lost'))
          }
          return (query as (...values: unknown[]) => unknown)(...args)
        }) as typeof pool.query)
        const storedProof = scenario === 'restart-with-stored-proof' || scenario === 'restart-wrong-generation'
          || concurrentPoll
        if (storedProof) {
          const respond = owned.manager.respond.bind(owned.manager)
          owned.manager.respond = async (...args) => {
            await respond(...args)
            await callbacks.hooks!.PostToolUse![0]!.hooks[0]!({ ...hook, hook_event_name: 'PostToolUse', tool_response: 'read-completed' },
              'read-tool', { signal: new AbortController().signal })
          }
        }
        const responseTask = graphRpc(app, owner.token, 'tools/call', {
          name: 'operator_chat_respond', arguments: { conversationId: id, request: input },
        })
        if (concurrentPoll) {
          try {
            await journalEntered.promise
            const [, read] = await Promise.all([chat.reconcileActive(), graphRpc(app, owner.token, 'tools/call', {
              name: 'operator_chat_get', arguments: { conversationId: id },
            })])
            expect(read.result?.isError).not.toBe(true)
            expect((await pool.query('select result from management_command_receipts where command_id=$1',
              [input.commandId])).rows[0].result.status).toBe('completed')
          } finally { finishJournal.resolve() }
        }
        const response = await responseTask
        spy.mockRestore()
        expect(Boolean(response.result?.isError)).toBe(!concurrentPoll)
        expect((await permission)?.behavior).toBe(scenario === 'aborted' ? 'deny' : 'allow')
        const readReceipt = async () => (await pool.query('select result from management_command_receipts where command_id=$1', [input.commandId])).rows[0].result
        const original = await readReceipt()
        let expectedStatus = 'pending'
        if (concurrentPoll) expectedStatus = 'completed'
        if (scenario === 'aborted') expectedStatus = 'uncertain'
        expect(original.status).toBe(expectedStatus)
        const callbackRecords = (await pool.query(`select record from claude_callback_receipts
          where record#>>'{identity,nativeRequestId}'=$1`, [input.nativeRequestId])).rows
        expect(callbackRecords).toHaveLength(1)
        expect(callbackRecords[0].record).toMatchObject({ identity: { nativeMessageId: message.uuid,
          nativeRequestId: input.nativeRequestId }, inputHash: expect.any(String), toolName: 'Read' })
        expect(callbackRecords[0].record.input).toBeUndefined()
        if (scenario === 'resident-write-loss' || scenario === 'resident-stream-after-recovery'
          || scenario === 'terminal-after-response' || scenario === 'restart-after-terminal') {
          await callbacks.hooks!.PostToolUse![0]!.hooks[0]!({ ...hook, hook_event_name: 'PostToolUse', tool_response: 'read-completed' },
            'read-tool', { signal: new AbortController().signal })
        }
        const historyFault = scenario === 'restart-after-terminal'
          ? vi.spyOn(repository.activity, 'append').mockRejectedValue(new Error('History save interrupted')) : undefined
        if (scenario === 'terminal-after-response' || scenario === 'restart-after-terminal') {
          void owned.frames.offer({ type: 'user', uuid: 'completed-tool', session_id: session.nativeSessionId,
            parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-tool', content: 'read-completed' }] } })
          void owned.frames.offer({ type: 'assistant', uuid: 'after-approval-answer', session_id: session.nativeSessionId,
            user_message_uuid: message.uuid, parent_tool_use_id: null,
            message: { id: 'after-approval', content: [{ type: 'text', text: 'Tool completed after approval.' }] } })
          void owned.frames.offer({ type: 'result', uuid: 'after-approval-terminal', session_id: session.nativeSessionId,
            user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'done' })
          await vi.waitFor(async () => expect(await repository.terminal(id, 'model-request')).toBeDefined(),
            { timeout: 20_000, interval: 50 })
        }
        if (scenario === 'restart-after-terminal') {
          const terminal = await repository.terminal(id, 'model-request')
          expect(terminal?.history?.responseDeliveries).toHaveLength(1)
          expect(terminal?.history?.events.some(event => event.type === 'claude.text')).toBe(true)
          expect(terminal?.historyPersisted).toBe(false)
          const disposalFault = vi.spyOn(owned.manager, 'dispose').mockRejectedValue(new Error('Native cleanup interrupted'))
          await expect(chat.shutdown()).rejects.toThrow('incomplete')
          expect((await repository.get(id))?.activeRequestId).toBe('model-request')
          expect(await repository.terminal(id, 'model-request')).toMatchObject({
            historyPersisted: false, closureState: 'pending',
          })
          disposalFault.mockRestore()
          await owned.manager.dispose!()
          historyFault!.mockRestore()
          chat = createChat()
        }
        if (scenario.startsWith('restart') && scenario !== 'restart-after-terminal') {
          expect(Boolean(original.providerAcknowledgment)).toBe(storedProof)
          if (scenario === 'restart-wrong-generation') {
            original.providerAcknowledgment.nativeIdentity.generation = 'foreign-generation'
            await pool.query('update management_command_receipts set result=$1::jsonb where command_id=$2', [JSON.stringify(original), input.commandId])
          }
          await chat.shutdown()
          chat = createChat()
        }
        await chat.reconcileActive()
        const receipt = await readReceipt()
        const completed = scenario === 'resident-write-loss' || scenario === 'resident-stream-after-recovery'
          || scenario === 'restart-with-stored-proof'
          || scenario === 'terminal-after-response' || scenario === 'restart-after-terminal'
          || concurrentPoll
        expect(receipt.status).toBe(completed ? 'completed' : original.status)
        if (completed) expect(receipt.providerAcknowledgment.nativeIdentity).toMatchObject({ kind: 'message', nativeMessageId: message.uuid })
        const readback = await graphRpc(app, owner.token, 'tools/call', { name: 'operator_chat_get', arguments: { conversationId: id } })
        expect(readback.result?.isError).not.toBe(true)
        const state = graphRpcValue(readback.result) as OperatorConversationState
        if (scenario === 'terminal-after-response' || scenario === 'restart-after-terminal') {
          expect(state.activeRequestId).toBeNull()
          expect(state.messages).toContainEqual(expect.objectContaining({ content: 'Tool completed after approval.' }))
          expect(state.activities).toContainEqual(expect.objectContaining({ kind: 'file_read', status: 'completed' }))
          const saved = (await pool.query(`select terminal_observation,native_closure_state,terminal_history,terminal_history_persisted
            from operator_conversation_turns where conversation_id=$1 and request_id=$2`, [id, 'model-request'])).rows[0]
          expect(saved.native_closure_state).toBe('closed')
          expect(saved.terminal_observation.result.outcome).toBe('succeeded')
          expect(saved.terminal_history_persisted).toBe(true)
          expect(saved.terminal_history).toMatchObject({ correlationId: `operator:${id}:model-request`,
            terminalResult: { outcome: 'succeeded' } })
          if (scenario === 'restart-after-terminal') {
            expect(closeRecoveredRuntime).toHaveBeenCalledTimes(1)
            expect(runtimes).toHaveLength(1)
          }
        } else expect(state).toMatchObject({ nativeSubmission: { kind: 'message', nativeMessageId: message.uuid } })
        const activity = state.activitySnapshot?.activities.find(activity => activity.kind === 'interaction'
          && activity.interaction?.answerRecorded)
        const summary = activity?.kind === 'interaction' ? activity.interaction : undefined
        expect(summary?.providerAcknowledged).toBe(completed)
        if (!completed) expect(summary?.delivery).not.toBe('delivered')
        if (scenario === 'resident-stream-after-recovery') {
          void owned.frames.offer({ type: 'assistant', uuid: 'after-recovery-answer', session_id: session.nativeSessionId,
            user_message_uuid: message.uuid, parent_tool_use_id: null,
            message: { id: 'after-recovery', content: [{ type: 'text', text: 'Live output after recovery.' }] } })
          await vi.waitFor(async () => {
            const continued = await graphRpc(app, owner.token, 'tools/call', {
              name: 'operator_chat_get', arguments: { conversationId: id },
            })
            expect(continued.result?.isError).not.toBe(true)
            expect((graphRpcValue(continued.result) as OperatorConversationState).messages)
              .toContainEqual(expect.objectContaining({ content: 'Live output after recovery.' }))
          }, { timeout: 20_000, interval: 50 })
        }
        const replay = await graphRpc(app, owner.token, 'tools/call', { name: 'operator_chat_respond', arguments: { conversationId: id, request: input } })
        expect(Boolean(replay.result?.isError)).toBe(!completed)
        expect(offers).toEqual([message.uuid])
        expect(responses).toBe(1)
      } finally {
        accountBindingReady.resolve()
        vi.restoreAllMocks()
        controller.abort()
        try { await app.close() }
        finally { await chat.shutdown() }
      }
    })
  }, 120_000)
