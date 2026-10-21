import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, operatorChatSettings } from '@foreman-code/contracts'
import type { HarnessOptions } from '@foreman-code/contracts/management'
import { AgentDefaultsUpdateResultSchema, ManagedAgentDefaultsSchema } from '@foreman-code/contracts/management'
import { initializeNativeDefaults } from '../src/modules/harnesses/initializeDefaults.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { reviewAuthMcpDatabase } from './helpers/reviewAuthMcpDatabase.js'

it('initializes an available harness while leaving an unranked native default unset and preserving retries', async () => {
  const fixture = await reviewAuthMcpDatabase()
  let rankedCodex = false
  const options = async (harness: HarnessOptions['harness']): Promise<HarnessOptions> => ({
    harness, providerVersion: 'native-fixture', authenticated: harness !== 'claude',
    models: [{ id: 'unranked-model',
      ...(harness === 'codex' && rankedCodex ? { defaultPriority: 0 } : {}),
      reasoningEfforts: ['low', 'medium'], variants: ['', 'medium'], serviceTiers: ['standard'] }],
    nativeAgents: ['build'], settings: [], restrictions: [], checkedAt: new Date().toISOString(),
  })
  try {
    await initializeNativeDefaults({ pool: fixture.pool, options, appMcpEndpoint: 'http://127.0.0.1:3050/mcp' })
    const repository = new PostgresSettingsRepository(fixture.pool)
    const first = await repository.getManagedHarnessDefaults()
    expect(first.unavailable).toEqual(['codex'])
    expect(first.defaults.codex).toEqual(DEFAULT_HARNESS_DEFAULTS.codex)
    await initializeNativeDefaults({ pool: fixture.pool, options, appMcpEndpoint: 'http://127.0.0.1:3050/mcp' })
    expect(await repository.getManagedHarnessDefaults()).toEqual(first)
    rankedCodex = true
    await initializeNativeDefaults({ pool: fixture.pool, options, appMcpEndpoint: 'http://127.0.0.1:3050/mcp' })
    const recovered = await repository.getManagedHarnessDefaults()
    expect(recovered.unavailable ?? []).toEqual([])
    expect(recovered.defaults.codex.model).toBe('unranked-model')
  } finally { await fixture.close() }
}, 30_000)

it('persists detected defaults once, preserves explicit pins and exposes the exact medium Claude effort through authenticated MCP', async () => {
  const f = await reviewAuthMcpDatabase()
  const options = async (harness: HarnessOptions['harness']): Promise<HarnessOptions> => ({ harness, providerVersion: 'observed-native',
    authenticated: true, models: [{ id: `${harness}-latest`, defaultPriority: 0,
      reasoningEfforts: ['low', 'medium', 'high'], variants: ['', 'medium'], serviceTiers: ['standard'] }], nativeAgents: ['build'], settings: [], restrictions: [], checkedAt: new Date().toISOString() })
  try {
    await initializeNativeDefaults({ pool: f.pool, options, appMcpEndpoint: 'http://127.0.0.1:3050/mcp' })
    const harnesses = await new PostgresSettingsRepository(f.pool).getManagedHarnessDefaults()
    expect(harnesses.defaults.codex).toMatchObject({ model: 'codex-latest', reasoningEffort: 'medium', sandbox: 'read-only' })
    expect(harnesses.defaults.claude).toMatchObject({ model: 'claude-latest', effort: 'medium', authMode: 'subscription', sandbox: 'read-only' })
    expect(harnesses.unavailable).toEqual(['claude'])
    const initialized = await f.repository.getAgentDefaults()
    expect(initialized.value.operator.harness).toMatchObject({ model: 'codex-latest', reasoningEffort: 'medium', sandbox: 'danger-full-access' })
    await initializeNativeDefaults({ pool: f.pool, options, appMcpEndpoint: 'http://127.0.0.1:3050/mcp' })
    expect(await f.repository.getAgentDefaults()).toEqual(initialized)
    expect(await new PostgresSettingsRepository(f.pool).getManagedHarnessDefaults()).toEqual(harnesses)
    const writer = await f.access.issue({ name: 'Native defaults owner', audience: 'operator',
      grants: [{ actions: ['settings:read', 'settings:update', 'harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const profile = (await f.profiles.save(writer.principal, 'http', { commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0,
      target: { hostRef: { kind: 'main', mainId: f.mainId }, applicationInstallationId: f.mainId, harnessInstallationId: 'actual-claude', installationFingerprint: 'actual-fingerprint' },
      presetId: 'local-default:claude', enabled: true, configuration: { ...harnesses.defaults.claude!, sandbox: 'danger-full-access' } })).value
    const input = { commandId: randomUUID(), expectedRevision: initialized.revision, value: { ...initialized.value, operator: {
      ...initialized.value.operator, harness: profile.configuration, harnessProfileSelection: { target: profile.target, instanceId: profile.instanceId, instanceRevision: profile.instanceRevision },
    } } }
    const client = await f.connect(writer.token)
    const saved = AgentDefaultsUpdateResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'agent_defaults_update', arguments: input }))))
    expect(operatorChatSettings(saved.value.value.operator.harness)).toMatchObject({ harness: 'claude', model: 'claude-latest', effort: 'medium' })
    expect(AgentDefaultsUpdateResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'agent_defaults_update', arguments: input }))))).toEqual({ ...saved, replayed: true })
    const reader = await f.access.issue({ name: 'Read-only model caller', audience: 'operator', grants: [{ actions: ['settings:read', 'harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const readClient = await f.connect(reader.token)
    await expectMcpAccessDenied(readClient.callTool({ name: 'agent_defaults_update', arguments: { ...input, commandId: randomUUID() } }))
    expect(ManagedAgentDefaultsSchema.parse(decodeMcpToolResult((await readClient.callTool({ name: 'agent_defaults_get', arguments: {} }))))).toEqual(saved.value)
    await initializeNativeDefaults({ pool: f.pool, options, appMcpEndpoint: 'http://127.0.0.1:3050/mcp' })
    expect(await f.repository.getAgentDefaults()).toEqual(saved.value)
    const historical = { ...harnesses.defaults.claude! }
    delete historical.effort
    await new PostgresSettingsRepository(f.pool).saveHarnessDefaults({ ...harnesses.defaults, claude: historical })
    await initializeNativeDefaults({ pool: f.pool, options, appMcpEndpoint: 'http://127.0.0.1:3050/mcp' })
    expect((await new PostgresSettingsRepository(f.pool).getHarnessDefaults()).claude).toEqual(historical)
    expect(await f.repository.getAgentDefaults()).toEqual(saved.value)
  } finally { await f.close() }
}, 30_000)
