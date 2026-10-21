import { afterAll, beforeAll, describe, it } from 'vitest'
import { runCommand } from '../src/modules/harnesses/process.js'
import { nativeHttpIsolation } from './helpers/nativeHttpIsolation.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('native process local-human isolation', { timeout: 60_000 }, () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => { database = await agent3Database() }, 60_000)
  afterAll(async () => { await database?.close() }, 60_000)

  // The cases share migrated tables and retain separate workflows, servers and native owners.
  it('denies tokenless mutations and approvals while retaining credentialed MCP access', async () => {
    await nativeHttpIsolation(input => runCommand(process.execPath, ['-e', input.script], input.directory,
      undefined, { expectedAgentId: input.owner, beforeSpawn: async () => ({ agentId: input.owner,
        variables: { FOREMAN_CODE_MCP_TOKEN: input.token } }) }, { recovery: input.recovery }), { database })
  })
  it('denies an independently launched restricted MCP client with Authorization omitted', async () => {
    await nativeHttpIsolation(input => runCommand(process.execPath, ['-e', input.script], input.directory,
      undefined, { expectedAgentId: input.owner, beforeSpawn: async () => ({ agentId: input.owner,
        variables: { FOREMAN_CODE_MCP_TOKEN: input.token } }) }), { database })
  })
})
