import { expect, it, vi } from 'vitest'
import { CODEX_APPROVAL_OPTIONS_FIXTURE, DEFAULT_HARNESS_DEFAULTS, type NativeSessionReference, type PendingNativeInteraction } from '@foreman-code/contracts'
import type { NativeResponseDeliveryEvidence } from '../src/modules/interactions/delivery.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { buildApp } from '../src/app.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { OperatorChatService, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../src/modules/harnesses/port.js'
import { graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'

it.skipIf(process.env.NIM2691_POSTGRES !== '1').each(['acknowledged', 'acknowledged-terminal', 'exact', 'wrong-choice', 'wrong-version', 'conflicting-proof'])('reconciles only %s Codex response evidence after outcome persistence fails once', async (proofCase) => {
    await nim2691TaskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const access = new PostgresAccessService(pool)
      const owner = await access.issue({ name: 'recovery owner', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:respond'], scope: {} }] })
      const denied = await access.issue({ name: 'denied reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['harnesses:read'], scope: {} }] })
      const settings = new PostgresFoundationSettingsRepository(pool)
      const defaults = await settings.getAgentDefaults()
      await settings.updateAgentDefaults({ ...defaults.value, operator: { ...defaults.value.operator, harness: DEFAULT_HARNESS_DEFAULTS.codex } }, defaults.revision)
      const repository = new PostgresOperatorConversationRepository(pool)
      const session: NativeSessionReference = { harness: 'codex', providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'recovery-session' }
      let responses = 0
      let history: NativeHistory = { events: [], pendingInteractions: [] }
      const proof: NativeResponseDeliveryEvidence = { source: 'provider_acknowledgement', harness: 'codex', providerVersion: 'codex-cli 0.154.0',
        nativeSessionId: session.nativeSessionId, nativeRequestId: 'approval', nativeRequestType: 'item/commandExecution/requestApproval', optionId: 'codex-approve-once', semantic: 'approve_once' }
      const manager: NativeHarnessSessionManager = {
        harness: 'codex', capabilities() { throw new Error('Unused') }, inspectMcp() { throw new Error('Unused') },
        createSession: async () => { throw new Error('Recovery must not create a session') }, attachSession: async () => session,
        startTurn() { throw new Error('Recovery must not submit a prompt') }, pending: async () => undefined,
        respond: async () => { responses++ }, cancel: async () => false,
        history: async () => history, reconcile: async () => history,
        reconcileResponse: async () => ({ ...history, responseDeliveries: proofCase.startsWith('acknowledged') ? [proof] : [] }), close: async () => {},
      }
      const chat = new OperatorChatService(repository, new PostgresOperatorRepository(pool), () => manager, directory, {
        current: (id) => access.currentOperator(id), assertConfiguration() {},
        setup: async () => ({ harness: 'codex', status: 'configured', endpoint: 'http://127.0.0.1/mcp', checkedAt: new Date().toISOString() }),
        prepare: async (_manager, config) => ({ agentId: config.operatorId, variables: {} }), release: async () => {},
      })
      const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { operatorChat: chat, commands: new PostgresCommandCoordinator(pool) } as never } })
      registerOperatorChatRoutes(app, chat)
      try {
        const conversation = await chat.create(owner.principal)
        const id = conversation.id, modelRequestId = 'model-request'
        await repository.beginTurn(id, { requestId: modelRequestId, content: 'Inspect' }, owner.principal.id)
        await repository.bind(id, modelRequestId, session.providerVersion, session.nativeSessionId)
        await repository.submitted(id, modelRequestId, 'turn', { nativeSessionId: session.nativeSessionId, principalId: owner.principal.id })
        const pending: PendingNativeInteraction = { session, turn: { nativeTurnId: 'turn', nativeRequestId: 'approval' },
          nativeRequestType: 'item/commandExecution/requestApproval', request: {
            threadId: session.nativeSessionId, turnId: 'turn', itemId: 'command-item', command: 'pwd', cwd: directory,
          }, responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE }
        await repository.pending(id, modelRequestId, pending)
        history = { correlationId: nativeCorrelation(id, modelRequestId), nativeTurnId: 'turn', events: [], pendingInteractions: [],
          ...(proofCase === 'acknowledged-terminal' ? { terminalResult: { outcome: 'succeeded', output: { text: '' } } } : {}) }
        const query = pool.query.bind(pool)
        let failed = false
        const spy = vi.spyOn(pool, 'query').mockImplementation(((...args: unknown[]) => {
          if (!failed && String(args[0]).includes('with settled as')) { failed = true; return Promise.reject(new Error('Injected outcome persistence failure')) }
          return (query as (...values: unknown[]) => unknown)(...args)
        }) as typeof pool.query)
        const input = { commandId: 'original-command', requestId: modelRequestId, nativeRequestId: 'approval', optionId: 'codex-approve-once' }
        const response = await app.inject({ method: 'POST', url: `/api/operator/conversations/${id}/responses`, headers: graphHeaders(owner.token), payload: input })
        spy.mockRestore()
        expect(failed, response.body).toBe(true)
        expect(response.statusCode, response.body).toBe(proofCase.startsWith('acknowledged') ? 200 : 409)
        expect(responses).toBe(1)
        const readReceipt = async () => (await pool.query('select result from management_command_receipts where command_id=$1', [input.commandId])).rows[0]!.result
        const original = await readReceipt()
        expect(original.status).toBe(proofCase.startsWith('acknowledged') ? 'completed' : 'pending')
        const recoveryProof: NativeResponseDeliveryEvidence = { ...proof, source: 'provider_history' as const,
          ...(proofCase === 'wrong-choice' || proofCase === 'conflicting-proof' ? { optionId: 'codex-reject', semantic: 'reject' } : {}),
          ...(proofCase === 'wrong-version' ? { providerVersion: 'foreign-version' } : {}) }
        history.responseDeliveries = proofCase === 'conflicting-proof' ? [proof, recoveryProof] : [recoveryProof]
        await chat.reconcileActive()
        const receipt = await readReceipt()
        const http = await app.inject({ method: 'GET', url: `/api/operator/conversations/${id}`, headers: graphHeaders(owner.token) })
        expect(http.statusCode, http.body).toBe(200)
        const mcp = await graphRpc(app, owner.token, 'tools/call', { name: 'operator_chat_get', arguments: { conversationId: id } })
        expect(mcp.result?.isError).not.toBe(true)
        expect(graphRpcValue(mcp.result)).toMatchObject({ activitySnapshot: http.json().activitySnapshot })
        const summary = http.json().activitySnapshot.activities.find((item: { kind: string; interaction?: { answerRecorded: boolean } }) =>
          item.kind === 'interaction' && item.interaction?.answerRecorded)?.interaction
        if (proofCase === 'exact' || proofCase.startsWith('acknowledged')) {
          expect(receipt).toMatchObject({ status: 'completed', acceptedControl: original.acceptedControl, providerAcknowledgment: proofCase.startsWith('acknowledged') ? proof : recoveryProof })
          expect(summary).toMatchObject({ delivery: 'delivered', providerAcknowledged: true })
          const replay = await graphRpc(app, owner.token, 'tools/call', { name: 'operator_chat_respond', arguments: { conversationId: id, request: input } })
          expect(replay.result?.isError).not.toBe(true)
          const changed = await graphRpc(app, owner.token, 'tools/call', { name: 'operator_chat_respond', arguments: { conversationId: id, request: { ...input, optionId: 'codex-reject' } } })
          expect(changed.result?.isError).toBe(true)
          expect((await pool.query("select count(*)::integer as n from management_audit where details->>'phase'='reconciled'" )).rows[0]!.n).toBe(proofCase.startsWith('acknowledged') ? 0 : 1)
        } else {
          expect(receipt).toEqual(original)
          expect(summary).toMatchObject({ delivery: 'answer_recorded', providerAcknowledged: false })
        }
        const blocked = await graphRpc(app, denied.token, 'tools/call', { name: 'operator_chat_get', arguments: { conversationId: id } })
        expect(blocked.error || blocked.result?.isError).toBeTruthy()
        expect((await pool.query('select count(*)::integer as n from management_command_receipts')).rows[0]!.n).toBe(1)
        expect(responses).toBe(1)
      } finally { await app.close(); await chat.shutdown() }
    })
  }, 120000)
