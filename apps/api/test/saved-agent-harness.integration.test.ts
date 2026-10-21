import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import {
  AgentMutationResultSchema, HarnessCatalogEntrySchema, HarnessCatalogResultSchema,
  HarnessCatalogSchema, HarnessDefaultsUpdateResultSchema, ManagedAgentDetailSchema,
} from '@foreman-code/contracts/management'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

const savedConfiguration = {
  harness: 'claude' as const, model: 'saved-model', authMode: 'subscription' as const,
  configDirectory: '/saved/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
  tools: ['Write'], permissionRules: [], instructions: 'Saved instructions', mcpServers: {},
}

it('reports Claude preset availability equally through HTTP/MCP and preserves a saved Claude Agent on rename', async () => {
  const f = await currentOperatorIntegration({ agentManagement: true })
  const call = async (name: string, input: Record<string, unknown>) => {
    const result = await f.client.callTool({ name, arguments: input })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  const http = async (path: string, token = f.writer.token) => {
    const response = await fetch(new URL(path, f.address), { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    return response.json()
  }
  try {
    const workspaceId = f.f.scope.workspaceId
    const agentId = randomUUID()
    const created = AgentMutationResultSchema.parse(await call('agent_create', {
      workspaceId, agentId, commandId: randomUUID(), name: 'Main coordinator', configuration: savedConfiguration,
    })).value
    const repository = new PostgresSettingsRepository(f.db.pool)
    await repository.saveHarnessDefaults(DEFAULT_HARNESS_DEFAULTS)
    const missing = HarnessCatalogResultSchema.parse(await call('harness_list', {}))
    expect(missing.items.map(entry => entry.harness)).toEqual(['codex'])
    expect(HarnessCatalogSchema.parse(await http('/api/management/harnesses'))).toEqual(missing.items)
    const missingClaude = await f.client.callTool({ name: 'harness_get', arguments: { harness: 'claude' } })
    expect(missingClaude).toMatchObject({ isError: true,
      content: [{ type: 'text', text: expect.stringContaining('HARNESS_PROFILE_REQUIRED') }] })
    const missingHttp = await fetch(new URL('/api/management/harnesses/claude', f.address), {
      headers: { authorization: `Bearer ${f.writer.token}` },
    })
    expect(missingHttp.status).toBe(409)
    expect(await missingHttp.json()).toMatchObject({ error: { code: 'HARNESS_PROFILE_REQUIRED' } })

    const incomplete = { ...savedConfiguration, sandbox: 'read-only' as const }
    await repository.saveHarnessDefaults({ ...DEFAULT_HARNESS_DEFAULTS, claude: incomplete })
    const choices = HarnessCatalogResultSchema.parse(await call('harness_list', {}))
    expect(HarnessCatalogSchema.parse(await http('/api/management/harnesses'))).toEqual(choices.items)
    const claude = choices.items.find(entry => entry.harness === 'claude')!
    expect(claude).toMatchObject({ harness: 'claude', defaults: incomplete, capability: null,
      discoveryError: { code: 'CLAUDE_FULL_ACCESS_REQUIRED' } })
    expect(HarnessCatalogEntrySchema.parse(await call('harness_get', { harness: 'claude' }))).toEqual(claude)
    expect(HarnessCatalogEntrySchema.parse(await http('/api/management/harnesses/claude'))).toEqual(claude)

    const noHarnessGrant = await f.access.issue({ name: 'Caller without harness access', audience: 'operator',
      grants: [{ actions: ['agents:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const deniedChoices = await f.connect(noHarnessGrant.token)
    await expectMcpAccessDenied(deniedChoices.callTool({ name: 'harness_list', arguments: {} }))
    const deniedHttp = await fetch(new URL('/api/management/harnesses', f.address), {
      headers: { authorization: `Bearer ${noHarnessGrant.token}` },
    })
    expect(deniedHttp.status).toBe(403)

    const reader = await f.access.issue({ name: 'Saved harness reader', audience: 'operator',
      grants: [{ actions: ['agents:read', 'harnesses:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 600_000) })
    const denied = await f.connect(reader.token)
    const rename = { workspaceId, agentId, commandId: randomUUID(), expectedRevision: created.metadataRevision,
      expectedConfigurationVersionId: created.agent.configurationVersionId!, name: 'Renamed coordinator' }
    await expectMcpAccessDenied(denied.callTool({ name: 'agent_update', arguments: rename }))
    const renamed = AgentMutationResultSchema.parse(await call('agent_update', rename))
    expect(renamed.value.agent).toMatchObject({ harness: 'claude', name: 'Renamed coordinator',
      harnessConfiguration: savedConfiguration })
    expect(AgentMutationResultSchema.parse(await call('agent_update', rename))).toEqual({ ...renamed, replayed: true })
    const readback = await denied.callTool({ name: 'agent_get', arguments: { workspaceId, agentId } })
    expect(readback.isError).not.toBe(true)
    const persisted = ManagedAgentDetailSchema.parse(decodeMcpToolResult(readback))
    expect(persisted.agent).toEqual(renamed.value.agent)
    expect(ManagedAgentDetailSchema.parse(await http(
      `/api/management/workspaces/${workspaceId}/agents/${agentId}`, reader.token,
    ))).toEqual(persisted)

    const deniedDefaults = { commandId: randomUUID(), expectedRevision: claude.defaultsRevision,
      defaults: { ...DEFAULT_HARNESS_DEFAULTS, claude: savedConfiguration }, configure: ['claude'] }
    await expectMcpAccessDenied(denied.callTool({ name: 'harness_defaults_update', arguments: deniedDefaults }))
    const configured = HarnessDefaultsUpdateResultSchema.parse(await call('harness_defaults_update', deniedDefaults))
    expect(configured.value.defaults.claude).toEqual(savedConfiguration)
    expect(HarnessDefaultsUpdateResultSchema.parse(await call('harness_defaults_update', deniedDefaults)))
      .toEqual({ ...configured, replayed: true })
    expect(HarnessCatalogEntrySchema.parse(await call('harness_get', { harness: 'claude' })).defaults)
      .toEqual(savedConfiguration)
    expect(HarnessCatalogEntrySchema.parse(await http('/api/management/harnesses/claude')).defaults)
      .toEqual(savedConfiguration)
  } finally {
    await f.close()
  }
}, 60_000)
