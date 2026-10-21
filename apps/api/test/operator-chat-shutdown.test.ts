import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type NativeSessionReference, type OperatorConfigurationVersion } from '@foreman-code/contracts'
import { OperatorChatService, type OperatorChatAuthority } from '../src/modules/conversations/operatorChat.js'
import type { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { eventually, memoryConversation, operator, ReviewManager } from './fixtures/agent1OperatorChat.js'

const configuration: OperatorConfigurationVersion = {
  id: 'operator-v1', operatorId: 'operator-one', version: 1, harness: DEFAULT_HARNESS_DEFAULTS.codex,
  contentHash: 'sha256:test', createdAt: new Date().toISOString(),
}

class UnreachableHistoryManager extends ReviewManager {
  reconciles = 0
  // A disconnected provider never answers; only the caller's signal ends the read.
  override reconcile(_session: NativeSessionReference, _correlationId: string, signal?: AbortSignal) {
    this.reconciles++
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
}

it('shuts down cleanly while a finished turn is still waiting for its native history', async () => {
  const { repository } = memoryConversation(configuration)
  const owner = operator()
  const manager = new UnreachableHistoryManager()
  const authority: OperatorChatAuthority = {
    current: async () => owner, assertConfiguration() {},
    setup: async (native) => ({ harness: native.harness, status: 'configured', endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() }),
    prepare: async () => ({ agentId: configuration.operatorId, variables: {} }),
    release: async () => {},
  }
  const chat = new OperatorChatService(repository, {} as PostgresOperatorRepository, () => manager, '/tmp/operator', authority)
  await chat.send('chat-one', { requestId: 'request', content: 'Answer when the provider returns' }, owner)
  await eventually(() => manager.reconciles > 0)
  await expect(chat.shutdown()).resolves.toBeUndefined()
})
