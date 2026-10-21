import { it } from 'vitest'
import { remoteAgentConversation } from './helpers/remoteAgentConversation.js'
import { assertAgentNewConversation } from './helpers/agentNewConversation.js'

it.each(['codex', 'claude'] as const)(
  'starts a fresh Main-local %s Agent conversation through authenticated MCP and retains history', async harness => {
    const f = await remoteAgentConversation(harness, 'main')
    try { await assertAgentNewConversation(f) }
    finally { await f.close() }
  }, 30_000)
