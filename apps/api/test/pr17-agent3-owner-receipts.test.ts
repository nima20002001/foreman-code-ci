import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type OperatorConfigurationVersion } from '@foreman-code/contracts'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import type { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { memoryConversation, operator, ReviewManager } from './fixtures/agent1OperatorChat.js'

describe('F12 read-only receipt recovery owner boundary', () => {
  it('recovers the same accepted ID without another native submission and denies another owner before reading history', async () => {
    const configuration: OperatorConfigurationVersion = { id: 'v1', operatorId: 'operator', version: 1,
      harness: DEFAULT_HARNESS_DEFAULTS.codex, contentHash: 'sha256:test', createdAt: new Date().toISOString() }
    const owner = operator(), manager = new ReviewManager(), memory = memoryConversation(configuration)
    let reads = 0
    memory.repository.history = async () => {
      reads++
      return { conversationId: memory.row.id, revision: 2, activeRequestId: 'accepted-id', nextCursor: null,
        entries: [{ sequence: '1', message: { id: 'message', conversationId: memory.row.id, role: 'user', content: 'Accepted once' },
          receipt: { requestId: 'accepted-id', inputHash: 'a'.repeat(64), outcome: null, retryable: false } }] }
    }
    const chat = new OperatorChatService(memory.repository, {} as PostgresOperatorRepository, () => manager, '/tmp/operator', {
      current: async () => owner, assertConfiguration() {},
    setup: async (manager) => ({ harness: manager.harness, status: 'configured', endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() }), prepare: async () => { throw new Error('Receipt reads cannot prepare native work') },
      release: async () => {},
    })
    const command = { requestId: 'accepted-id', content: 'Accepted once' }
    await memory.repository.beginTurn(memory.row.id, command, owner.id)
    const recovered = await chat.history(memory.row.id, { ...owner }) // Same owner, new browser enrollment/session.
    expect(recovered.entries[0]?.receipt?.requestId).toBe(command.requestId)
    expect(manager.turns).toBe(0)
    await expect(chat.history(memory.row.id, operator('another-owner'))).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    expect(reads).toBe(1)
    await chat.shutdown()
  })
})
