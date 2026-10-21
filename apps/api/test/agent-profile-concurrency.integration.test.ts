import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import pg from 'pg'
import { ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts/claude'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { ManagedWorkspaceCommandResultSchema } from '@foreman-code/contracts/management'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { AgentManagementService } from '../src/modules/workspaces/agents.js'
import { ProviderAccountConfigurationService } from '../src/modules/harnesses/providerAccountConfiguration.js'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { workspaceMcpFixture, callWorkspaceTool } from './helpers/workspaceMcp.js'
import { deferred } from './helpers/deferred.js'
import { observe } from './helpers/concurrentMutations.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

it('leaves pool capacity for automatic profile setup while Agent mutations queue', async () => {
  const f = await workspaceMcpFixture()
  const release = deferred()
  const entered = deferred()
  const calls: Array<ReturnType<typeof f.owner.client.callTool>> = []
  const observer = new pg.Client({ ...f.pool.options, application_name: 'pool-observer' })
  try {
    await observer.connect()
    f.pool.options.max = 2
    f.pool.options.connectionTimeoutMillis = 1000
    const home = join(f.parentPath, 'account')
    await mkdir(home)
    const accountId = randomUUID()
    const configuration = ClaudeHarnessConfigurationSchema.parse({ harness: 'claude', accountId,
      model: 'fixture', effort: 'medium', configDirectory: home, authMode: 'subscription',
      permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [],
      instructions: '', mcpServers: {} })
    const mainId = (await f.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
      harnessInstallationId: 'fixture-claude', installationFingerprint: 'fixture' }
    const repository = new HarnessInstanceSettingsRepository(f.pool)
    const profiles = new HostHarnessOverrideService(repository, f.commands, { authorize: async () => {} }, async () => null)
    const saved = (await profiles.save(f.owner.principal, 'mcp', { instanceId: randomUUID(), target,
      configuration, presetId: 'local-default:claude', enabled: true, commandId: randomUUID() })).value
    const selection: HarnessProfileSelection = { instanceId: saved.instanceId, instanceRevision: saved.instanceRevision, target }
    let ready = false
    let preparing = 0
    let availableCapacity = Infinity
    const accounts = new ProviderAccountConfigurationService({ resolve: async () => ({ accountId,
      homePath: home, authMode: 'subscription' }) })
    accounts.bindProfiles({
      selectionForConfiguration: async () => ready ? selection : undefined,
      validateSelection: profiles.validateSelection.bind(profiles),
      prepareOperatorConfiguration: async () => {
        preparing++
        entered.resolve()
        await release.promise
        availableCapacity = Math.min(availableCapacity, f.pool.idleCount + f.pool.options.max! - f.pool.totalCount)
        await repository.list(target.hostRef, mainId)
        ready = true
        return selection
      },
    })
    Object.assign(f.services, { agents: new AgentManagementService(f.pool), extensions: {
      agents: new OperatorAgentMutationService(f.pool, f.commands, {
        qualifyConfiguration: async () => { throw new Error('The prepared profile must supply native qualification.') },
      }, profiles, accounts),
    } })
    const created = (await callWorkspaceTool(f.owner.client, 'workspace_create', ManagedWorkspaceCommandResultSchema,
      { name: 'Profile project', commandId: randomUUID() })).value
    const input = { workspaceId: created.workspace.id, agentId: randomUUID(), name: 'First Agent',
      productRole: 'coder', configuration, commandId: randomUUID() }
    const reader = await f.issue([{ actions: ['agents:read'], scope: {} }])
    await expectMcpAccessDenied(reader.client.callTool({ name: 'agent_create', arguments: input }))
    calls.push(f.owner.client.callTool({ name: 'agent_create', arguments: input }))
    await entered.promise
    calls.push(f.owner.client.callTool({ name: 'agent_create', arguments: { ...input,
      agentId: randomUUID(), name: 'Second Agent', commandId: randomUUID() } }))
    await observe(async () => {
      if (preparing === 2) return true
      if (f.pool.totalCount !== 2 || f.pool.idleCount !== 0) return false
      const result = await observer.query<{ owned: boolean }>(`select exists(
        select 1 from pg_locks where locktype='advisory' and granted
          and database=(select oid from pg_database where datname=current_database())
          and classid=((hashtext($1)::bigint >> 32) & 4294967295)
          and objid=(hashtext($1)::bigint & 4294967295)) as owned`,
      [`admission:workspace:${input.workspaceId}`])
      return result.rows[0]!.owned
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    release.resolve()
    let completed = false
    const all = Promise.all(calls).then(results => { completed = true; return results })
    await observe(() => completed || f.pool.waitingCount > 0)
    const starved = f.pool.waitingCount > 0
    if (starved) await vi.advanceTimersByTimeAsync(1000)
    const results = await all
    vi.useRealTimers()
    expect(starved).toBe(false)
    expect(availableCapacity).toBeGreaterThan(0)
    for (const result of results) expect(result.isError).not.toBe(true)
    expect(decodeMcpToolResult(await reader.client.callTool({ name: 'agent_get',
      arguments: { workspaceId: input.workspaceId, agentId: input.agentId } })))
      .toMatchObject({ agent: { harnessProfileSelection: selection } })
  } finally {
    release.resolve()
    vi.useRealTimers()
    await Promise.allSettled(calls)
    await observer.end()
    await f.close()
  }
})
