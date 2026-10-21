import { afterEach, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { createDatabase } from '../src/infrastructure/database.js'
import type { AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import type { AgentConversationRow } from '../src/modules/conversations/agentChatRepository.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { buildProductionApp } from '../src/production.js'

const composition = vi.hoisted(() => ({ factories: [] as AgentChatManagerFactory[] }))
vi.mock('../src/modules/conversations/agentChat.js', async original => {
  const actual = await original<typeof import('../src/modules/conversations/agentChat.js')>()
  return { ...actual, AgentChatService: class extends actual.AgentChatService {
    constructor(...args: ConstructorParameters<typeof actual.AgentChatService>) {
      super(...args)
      composition.factories.push(args[5])
    }
  } }
})
afterEach(() => { composition.factories.splice(0) })

it('offers live steering to production Codex Agent chats and not to Claude chats', async () => {
  const config = loadConfig({ DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/agent_chat_steering' })
  const database = createDatabase(config.database)
  const checkpoints = createCheckpointStore(config.database.connectionString, 'agent_chat_steering', config.database)
  const production = buildProductionApp(config, database, checkpoints, false)
  try {
    expect(composition.factories).toHaveLength(1)
    const factory = composition.factories[0]!
    const configuration = (harness: 'codex' | 'claude') => {
      const accepted = workerConversationFixture('agent', harness).configuration
      if (!('agentId' in accepted)) throw new Error('Expected an Agent configuration.')
      return accepted
    }
    // Qualification reads the accepted owner configuration; the live row/runtime checks stay in the service.
    const row = { harness: 'codex' } as AgentConversationRow
    expect(await factory.qualifiedSteer?.(row, configuration('codex'))).toBe(true)
    expect(await factory.qualifiedSteer?.({ ...row, harness: 'claude' }, configuration('claude'))).toBe(false)
  } finally {
    await production.app.close()
    await production.engine.shutdown()
    await Promise.all([database.close(), checkpoints.close()])
  }
})
