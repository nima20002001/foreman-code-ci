import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts/claude'
import { ManagedWorkspaceCommandResultSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentManagementService } from '../src/modules/workspaces/agents.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { ProviderAccountConfigurationService } from '../src/modules/harnesses/providerAccountConfiguration.js'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import { workspaceMcpFixture, callWorkspaceTool } from './helpers/workspaceMcp.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { deferred } from './helpers/deferred.js'

it('prepares Claude profiles without retaining connections needed by nested profile checks', async () => {
  const f = await workspaceMcpFixture()
  const release = deferred()
  const entered = deferred()
  const calls: Array<ReturnType<typeof f.owner.client.callTool>> = []
  let checks: HostHarnessInstanceProfileChecks | undefined
  try {
    // Ten is the lifecycle pool's minimum; filling it exposes nested acquisition.
    f.pool.options.max = 10
    f.pool.options.connectionTimeoutMillis = 1000
    const home = join(f.parentPath, 'account')
    await mkdir(home)
    const accountId = randomUUID()
    const mainId = (await f.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
      harnessInstallationId: 'fixture-claude', installationFingerprint: 'fixture' }
    const repository = new HarnessInstanceSettingsRepository(f.pool)
    const proofs = new HostHarnessProfileEvidenceRepository(f.pool)
    const authority = { authorize: async () => {} }
    checks = new HostHarnessInstanceProfileChecks(repository, proofs, f.commands, authority, {
      qualify: async value => ({ target: value.target, instanceRevision: value.instanceRevision,
        configurationFingerprint: value.configurationFingerprint, driverId: value.driverId,
        driverRevision: '1', protocolRevision: '1', suiteRevision: 'fixture', environmentGeneration: 'fixture',
        connectionGeneration: 'local', authenticated: true, compatible: true, qualified: true,
        checkedAt: new Date().toISOString() }),
    })
    const profiles = new HostHarnessOverrideService(repository, f.commands, authority, async (value, client) => {
      const proof = await proofs.latest(value.instanceId, value.revision, client)
      return proof ? { target: proof.target, configurationFingerprint: proof.configurationFingerprint,
        qualified: proof.qualified } : null
    }, checks, () => target)
    let resolving = 0
    const accounts = new ProviderAccountConfigurationService({ resolve: async () => {
      resolving++
      if (resolving === 10) entered.resolve()
      await release.promise
      return { accountId, homePath: home, authMode: 'subscription' }
    } })
    accounts.bindProfiles(profiles)
    Object.assign(f.services, { agents: new AgentManagementService(f.pool), extensions: {
      agents: new OperatorAgentMutationService(f.pool, f.commands, {
        qualifyConfiguration: async () => { throw new Error('Expected saved profile qualification') },
      }, profiles, accounts),
    } })
    const created = await callWorkspaceTool(f.owner.client, 'workspace_create', ManagedWorkspaceCommandResultSchema,
      { name: 'Profile project', commandId: randomUUID() })
    const inputs = Array.from({ length: 10 }, (_, index) => ({ workspaceId: created.value.workspace.id,
      agentId: randomUUID(), name: `Agent ${index}`, productRole: 'coder', commandId: randomUUID(),
      configuration: ClaudeHarnessConfigurationSchema.parse({ harness: 'claude', accountId,
        model: `fixture-${index}`, effort: 'medium', configDirectory: home, authMode: 'subscription',
        permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [],
        instructions: '', mcpServers: {} }),
    }))
    const reader = await f.issue([{ actions: ['agents:read'], scope: {} }])
    await expectMcpAccessDenied(reader.client.callTool({ name: 'agent_create', arguments: inputs[0]! }))
    for (const input of inputs) calls.push(f.owner.client.callTool({ name: 'agent_create', arguments: input }))
    await entered.promise
    release.resolve()
    const results = await Promise.all(calls)
    for (const result of results) expect(result.isError, JSON.stringify(result)).not.toBe(true)
    for (const input of inputs) {
      const result = decodeMcpToolResult(await reader.client.callTool({ name: 'agent_get',
        arguments: { workspaceId: input.workspaceId, agentId: input.agentId } }))
      expect(result).toMatchObject({ agent: { harnessProfileSelection: { target, instanceRevision: '1' } } })
    }
    const replay = await f.owner.client.callTool({ name: 'agent_create', arguments: inputs[0]! })
    const saved = decodeMcpToolResult(results[0]!) as Record<string, unknown>
    expect(decodeMcpToolResult(replay)).toEqual({ ...saved, replayed: true })
  } finally {
    release.resolve()
    await Promise.allSettled(calls)
    await checks?.close()
    await f.close()
  }
})
