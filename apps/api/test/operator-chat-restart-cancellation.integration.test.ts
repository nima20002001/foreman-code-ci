import { describe, expect, it } from 'vitest'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { input } from './fixtures/codex-test-helpers.js'
import { ActivityProductionReplay } from './helpers/activityProductionReplay.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { readUntil } from './helpers/observableCondition.js'
import { registerOperatorChatFixture, type OperatorChatFixture } from './helpers/operatorChatFixture.js'

let fixture: OperatorChatFixture
let chat: OperatorChatService
registerOperatorChatFixture(value => { fixture = value; chat = value.chat }, () => chat, migratedDatabase)

describe('Operator native cancellation after restart', () => {
  it('interrupts the recovered native target and persists its canceled terminal receipt', async () => {
    const { repository, operators, runtimeDirectory, authority, owner, pool } = fixture
    const provider = new ActivityProductionReplay()
    const managers: CodexAppServerSessionManager[] = []
    const manager = () => {
      const result = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined,
        undefined, 'scoped', undefined, provider.infrastructure().codex)
      managers.push(result)
      return result
    }
    const { operator, configuration } = await operators.update(input(runtimeDirectory).request.configuration.harness,
      (await operators.ensure()).configuration.id)
    const conversation = await repository.create(operator.id, configuration, owner.id, 'Interrupted connection')
    const correlationId = nativeCorrelation(conversation.id, 'original-request')
    const originalManager = manager()
    const source = { kind: 'operator' as const, correlationId, configuration, workingDirectory: runtimeDirectory,
      environment: { agentId: configuration.operatorId, variables: { GRAPHQL_MCP_TOKEN: 'fixture-operator-token' } } }
    let streaming: Promise<void> | undefined
    try {
      await repository.beginTurn(conversation.id, { requestId: 'original-request', content: 'Long running work' }, owner.id)
      const session = await originalManager.createSession(source)
      await repository.bind(conversation.id, 'original-request', session.providerVersion, session.nativeSessionId)
      streaming = (async () => {
        for await (const event of originalManager.startTurn(session, { prompt: 'Long running work', clientCorrelationId: correlationId,
          onSubmitted: async nativeTurnId => {
            await repository.submitted(conversation.id, 'original-request', nativeTurnId,
              { nativeSessionId: session.nativeSessionId, principalId: owner.id })
          },
        })) void event
      })()
      const streamOutcome = Promise.allSettled([streaming])
      const original = await readUntil(() => repository.active(conversation.id), row => Boolean(row?.active_native_turn_id),
        { timeoutMs: 2000, description: 'native submission' })
      const sessionId = original!.native_session_id!
      const nativeTurnId = original!.active_native_turn_id!
      expect(provider.threads.get(sessionId)?.turns.find(turn => turn.id === nativeTurnId)?.status).toBe('inProgress')
      provider.disconnect(sessionId)
      await streamOutcome
      chat = new OperatorChatService(repository, operators, manager, runtimeDirectory, authority)
      await chat.reconcileActive()
      expect((await repository.active(conversation.id))?.active_native_turn_id).toBe(nativeTurnId)
      await chat.cancel(conversation.id, 'original-request', owner)
      // Check before another reconciliation can retry a missing interrupt dispatch.
      expect(provider.threads.get(sessionId)?.turns.find(turn => turn.id === nativeTurnId)?.status).toBe('interrupted')
      await readUntil(async () => {
        await chat.reconcileActive()
        return repository.active(conversation.id)
      }, row => row?.active_request_id === null, { timeoutMs: 2000, description: 'canceled terminal receipt' })
      const receipt = (await pool.query(`select native_turn_id,result from operator_conversation_turns
        where conversation_id=$1 and request_id=$2`, [conversation.id, 'original-request'])).rows[0]
      expect(receipt).toMatchObject({ native_turn_id: nativeTurnId, result: { outcome: 'canceled' } })
      const verifier = manager()
      await verifier.attachSession(session, { ...source, nativeTurnId })
      const history = await verifier.reconcile(session, correlationId)
      expect(history).toMatchObject({ nativeTurnId, terminalResult: { outcome: 'canceled' } })
      expect(provider.starts).toHaveLength(1)
    } finally {
      await chat.shutdown()
      for (const instance of managers) await instance.dispose()
      if (streaming) await Promise.allSettled([streaming])
    }
  })
})
