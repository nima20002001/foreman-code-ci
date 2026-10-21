import { afterEach, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { createDatabase } from '../src/infrastructure/database.js'
import type { NativeManagerResolver } from '../src/modules/conversations/operatorChat.js'
import type { ConversationRow } from '../src/modules/conversations/operatorChatRepository.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { buildProductionApp } from '../src/production.js'

const composition = vi.hoisted(() => ({ resolvers: [] as NativeManagerResolver[] }))
vi.mock('../src/modules/conversations/operatorChat.js', async original => {
  const actual = await original<typeof import('../src/modules/conversations/operatorChat.js')>()
  return { ...actual, OperatorChatService: class extends actual.OperatorChatService {
    constructor(...args: ConstructorParameters<typeof actual.OperatorChatService>) {
      super(...args)
      composition.resolvers.push(args[2])
    }
  } }
})
afterEach(() => { composition.resolvers.splice(0) })

it('offers live steering to production Codex Operator chats and not to Claude chats', async () => {
  const config = loadConfig({ DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/operator_chat_steering' })
  const database = createDatabase(config.database)
  const checkpoints = createCheckpointStore(config.database.connectionString, 'operator_chat_steering', config.database)
  const production = buildProductionApp(config, database, checkpoints, false)
  try {
    expect(composition.resolvers).toHaveLength(1)
    const resolver = composition.resolvers[0]!
    const configuration = (harness: 'codex' | 'claude') => {
      const accepted = workerConversationFixture('operator', harness).configuration
      if (!('operatorId' in accepted)) throw new Error('Expected an Operator configuration.')
      return accepted
    }
    // Qualification reads the accepted owner configuration; the live row/runtime checks stay in the service.
    const row = { harness: 'codex' } as ConversationRow
    expect(await resolver.qualifiedSteer?.(row, configuration('codex'))).toBe(true)
    expect(await resolver.qualifiedSteer?.({ ...row, harness: 'claude' }, configuration('claude'))).toBe(false)
  } finally {
    await production.app.close()
    await production.engine.shutdown()
    await Promise.all([database.close(), checkpoints.close()])
  }
})
