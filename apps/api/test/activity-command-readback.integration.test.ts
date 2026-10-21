import { migratedDatabase } from './helpers/migratedDatabase.js'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { AgentChatCommands } from '../src/modules/conversations/agentChatCommands.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { if (postgresEnabled) database = await migratedDatabase() })
afterAll(async () => { if (database) await database.close() })

/** Durable receipt/readback proof; real HTTP/MCP and factory replay remain orchestrator gates. */
it.skipIf(!postgresEnabled)('preserves one PostgreSQL command receipt across transport/restart and rejects revoked readback', async () => {
  const access = new PostgresAccessService(database.pool)
  const issued = await access.issue({ name: 'W05 current readback', audience: 'operator',
    expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['agent_chat:read', 'agent_chat:cancel'], scope: {} }] })
  const principal = await access.authenticate(issued.token, 'operator')
  let state = structuredClone(agentChatFixtures.idleAfterCompletion)
  const perform = vi.fn(async () => state)
  const current = async () => { await access.authenticate(issued.token, 'operator'); return state }
  await new AgentChatCommands(database.pool).execute(principal, 'http', 'conversation', 'w05-command', { kind: 'interrupt' }, perform, current)
  const receipt = (await database.pool.query("select result from management_command_receipts where principal_id=$1 and command_id='w05-command'", [principal.id])).rows[0]!.result
  state = { ...state, revision: state.revision + 10 }
  const replay = await new AgentChatCommands(database.pool).execute(principal, 'mcp', 'conversation', 'w05-command', { kind: 'interrupt' }, perform, current)
  expect(replay.revision).toBe(state.revision)
  expect(perform).toHaveBeenCalledTimes(1)
  expect((await database.pool.query("select result from management_command_receipts where principal_id=$1 and command_id='w05-command'", [principal.id])).rows)
    .toEqual([{ result: receipt }])
  await access.revoke(principal.id)
  await expect(new AgentChatCommands(database.pool).execute(principal, 'mcp', 'conversation', 'w05-command', { kind: 'interrupt' }, perform, current))
    .rejects.toMatchObject({ status: 401 })
  expect(perform).toHaveBeenCalledTimes(1)
})
